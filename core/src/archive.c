/*
 * .temen archives: a project as a plain zip, read and written in memory with miniz.
 *
 * Independent of any TemenCore and of the JavaScript engine, so a host (the Swift app, the native
 * command line tool) can open and save projects without building anything. temen_archive_read gives
 * the entries exactly as stored; temen_project_read applies the web app's Project.fromZip rules
 * (src/project.js), which must stay in step with it.
 */
#include <stdlib.h>
#include <string.h>

#include "temencad.h"
#include "miniz/miniz.h"

/* miniz allocates with its default callbacks, which are malloc, realloc and free, so its buffers are
 * released with free() here. */

/* A guard against zip bombs and corrupt directories: a project is scripts, fonts, meshes and images. */
#define TEMEN_ARCHIVE_MAX_ENTRIES 65535u
#define TEMEN_ARCHIVE_MAX_TOTAL ((mz_uint64)1 << 30) /* 1 GiB uncompressed */

struct TemenArchive {
    TemenFile *entries;
    size_t n;
    TemenFile *extras; /* temen_project_read: the app's own data under .assistant/ */
    size_t n_extras;
};

static void set_error(const char **error, const char *msg) { if (error) *error = msg; }

void temen_archive_free(TemenArchive *a) {
    if (!a) return;
    for (size_t i = 0; i < a->n; i++) { free((void *)a->entries[i].name); free((void *)a->entries[i].data); }
    for (size_t i = 0; i < a->n_extras; i++) { free((void *)a->extras[i].name); free((void *)a->extras[i].data); }
    free(a->entries);
    free(a->extras);
    free(a);
}

TemenArchive *temen_archive_read(const void *bytes, size_t len, const char **error) {
    set_error(error, NULL);
    mz_zip_archive zip;
    memset(&zip, 0, sizeof zip);
    if (!bytes || !mz_zip_reader_init_mem(&zip, bytes, len, 0)) {
        set_error(error, bytes ? mz_zip_get_error_string(mz_zip_get_last_error(&zip)) : "no data");
        return NULL;
    }
    mz_uint count = mz_zip_reader_get_num_files(&zip);
    TemenArchive *a = calloc(1, sizeof *a);
    if (!a || count > TEMEN_ARCHIVE_MAX_ENTRIES || !(a->entries = calloc(count ? count : 1, sizeof *a->entries))) {
        set_error(error, a && count > TEMEN_ARCHIVE_MAX_ENTRIES ? "too many entries in the archive" : "out of memory");
        free(a);
        mz_zip_reader_end(&zip);
        return NULL;
    }
    mz_uint64 total = 0;
    for (mz_uint i = 0; i < count; i++) {
        mz_zip_archive_file_stat st;
        if (!mz_zip_reader_file_stat(&zip, i, &st)) goto fail;
        if (st.m_is_directory) continue;
        if (st.m_is_encrypted) { set_error(error, "the archive is encrypted"); goto fail_msg; }
        total += st.m_uncomp_size;
        if (total > TEMEN_ARCHIVE_MAX_TOTAL) { set_error(error, "the archive is too large (over 1 GiB uncompressed)"); goto fail_msg; }
        size_t size = 0;
        void *data = mz_zip_reader_extract_to_heap(&zip, i, &size, 0); /* checks the CRC */
        if (!data) {
            if (st.m_uncomp_size != 0) goto fail;
            data = malloc(1); /* an empty file: keep a non-NULL pointer */
            if (!data) goto fail;
        }
        char *name = malloc(strlen(st.m_filename) + 1);
        if (!name) { free(data); goto fail; }
        strcpy(name, st.m_filename);
        a->entries[a->n].name = name;
        a->entries[a->n].data = data;
        a->entries[a->n].len = size;
        a->n++;
    }
    mz_zip_reader_end(&zip);
    return a;
fail:
    set_error(error, mz_zip_get_error_string(mz_zip_get_last_error(&zip)));
fail_msg:
    mz_zip_reader_end(&zip);
    temen_archive_free(a);
    return NULL;
}

size_t temen_archive_count(const TemenArchive *a) { return a ? a->n : 0; }

const TemenFile *temen_archive_entry(const TemenArchive *a, size_t index) {
    return a && index < a->n ? &a->entries[index] : NULL;
}

/* ---- projects ---------------------------------------------------------------------------- */

#define APP_DATA_DIR ".assistant/"
#define ENTRY "main.js"

static int starts_with(const char *s, const char *prefix) { return strncmp(s, prefix, strlen(prefix)) == 0; }
static int ends_with(const char *s, const char *suffix) {
    size_t a = strlen(s), b = strlen(suffix);
    return a >= b && strcmp(s + a - b, suffix) == 0;
}
static int is_script(const char *name) { return ends_with(name, ".js") || ends_with(name, ".mjs"); }

/* normalizePath in project.js: '\\' to '/', empty and '.' segments dropped, '..' resolved; NULL when the
 * path escapes the root or nothing is left. Writes into `out`, which has room for strlen(path) + 1. */
static char *normalize_path(const char *path, char *out) {
    size_t len = 0;
    const char *p = path;
    while (*p) {
        const char *q = p;
        while (*q && *q != '/' && *q != '\\') q++;
        size_t seg = (size_t)(q - p);
        if (seg == 0 || (seg == 1 && p[0] == '.')) { /* nothing */ }
        else if (seg == 2 && p[0] == '.' && p[1] == '.') {
            if (len == 0) return NULL;
            while (len > 0 && out[len - 1] != '/') len--;
            if (len > 0) len--; /* and the '/' before the dropped segment */
        } else {
            if (len) out[len++] = '/';
            memcpy(out + len, p, seg);
            len += seg;
        }
        p = *q ? q + 1 : q;
    }
    out[len] = 0;
    return len ? out : NULL;
}

TemenArchive *temen_project_read(const void *bytes, size_t len, const char **error) {
    TemenArchive *a = temen_archive_read(bytes, len, error);
    if (!a) return NULL;
    a->extras = calloc(a->n ? a->n : 1, sizeof *a->extras);
    if (!a->extras) { set_error(error, "out of memory"); temen_archive_free(a); return NULL; }
    size_t kept = 0;
    for (size_t i = 0; i < a->n; i++) {
        TemenFile e = a->entries[i];
        const char *base = strrchr(e.name, '/');
        base = base ? base + 1 : e.name;
        if (starts_with(e.name, APP_DATA_DIR)) { a->extras[a->n_extras++] = e; continue; }
        /* folders, Finder junk, dotfiles, and paths that leave the project are not project files */
        char *name = NULL;
        if (!starts_with(e.name, "__MACOSX/") && base[0] != '.' && *base) {
            char *buf = malloc(strlen(e.name) + 1);
            if (buf && !(name = normalize_path(e.name, buf))) free(buf);
        }
        if (!name) { free((void *)e.name); free((void *)e.data); continue; }
        /* a later entry with the same normalized path replaces an earlier one, as in a JS Map */
        size_t j = 0;
        while (j < kept && strcmp(a->entries[j].name, name) != 0) j++;
        if (j < kept) { free((void *)a->entries[j].name); free((void *)a->entries[j].data); }
        free((void *)e.name);
        a->entries[j] = (TemenFile){ name, e.data, e.len };
        if (j == kept) kept++;
    }
    a->n = kept;
    size_t scripts = 0, lone = 0;
    for (size_t i = 0; i < a->n; i++) {
        if (strcmp(a->entries[i].name, ENTRY) == 0) return a;
        if (is_script(a->entries[i].name)) { scripts++; lone = i; }
    }
    if (scripts != 1) { set_error(error, "the project has no " ENTRY); temen_archive_free(a); return NULL; }
    char *entry = malloc(sizeof ENTRY); /* a single script is the entry whatever it is called */
    if (!entry) { set_error(error, "out of memory"); temen_archive_free(a); return NULL; }
    memcpy(entry, ENTRY, sizeof ENTRY);
    free((void *)a->entries[lone].name);
    a->entries[lone].name = entry;
    return a;
}

size_t temen_archive_extra_count(const TemenArchive *a) { return a ? a->n_extras : 0; }

const TemenFile *temen_archive_extra(const TemenArchive *a, size_t index) {
    return a && index < a->n_extras ? &a->extras[index] : NULL;
}

void *temen_archive_write(const TemenFile *files, size_t n, int level, size_t *out_len, const char **error) {
    set_error(error, NULL);
    if (out_len) *out_len = 0;
    if (level < 0 || level > 9) level = 6;
    mz_zip_archive zip;
    memset(&zip, 0, sizeof zip);
    if (!mz_zip_writer_init_heap(&zip, 0, 0)) { set_error(error, "out of memory"); return NULL; }
    for (size_t i = 0; i < n; i++) {
        if (!files[i].name || !*files[i].name) { set_error(error, "an entry has no name"); goto fail_msg; }
        if (!mz_zip_writer_add_mem(&zip, files[i].name, files[i].data ? files[i].data : "", files[i].len, (mz_uint)level)) goto fail;
    }
    void *buf = NULL;
    size_t size = 0;
    if (!mz_zip_writer_finalize_heap_archive(&zip, &buf, &size)) goto fail;
    mz_zip_writer_end(&zip);
    if (out_len) *out_len = size;
    return buf;
fail:
    set_error(error, mz_zip_get_error_string(mz_zip_get_last_error(&zip)));
fail_msg:
    mz_zip_writer_end(&zip);
    return NULL;
}

void temen_buffer_free(void *p) { free(p); }
