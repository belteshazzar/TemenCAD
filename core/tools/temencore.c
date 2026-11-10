/*
 * temencore — build a TemenCAD model natively.
 *
 *   temencore model.js [-o out.stl]        a single script (it becomes main.js)
 *   temencore project-dir [-o out.stl]     a folder with main.js and its imports
 *   temencore project.temen [-o out.stl]   a .temen project archive (a zip)
 *
 * Prints messages as the build emits them, then one line per part with its
 * triangle count and volume; writes a binary STL of every visible part when -o
 * is given. Exit code 1 on a script error, 2 on a runtime failure.
 */
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "temencad.h"

typedef struct { TemenFile *files; size_t n, cap; } Files;

static void *read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); fclose(f); return NULL; }
    fclose(f);
    buf[n] = 0;
    *len = (size_t)n;
    return buf;
}

static void add_file(Files *fs, const char *name, void *data, size_t len) {
    if (fs->n == fs->cap) { fs->cap = fs->cap ? fs->cap * 2 : 16; fs->files = realloc(fs->files, fs->cap * sizeof *fs->files); }
    fs->files[fs->n].name = strdup(name);
    fs->files[fs->n].data = data;
    fs->files[fs->n].len = len;
    fs->n++;
}

static void add_dir(Files *fs, const char *root, const char *rel) {
    char path[4096];
    snprintf(path, sizeof path, "%s%s%s", root, *rel ? "/" : "", rel);
    DIR *d = opendir(path);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (e->d_name[0] == '.') continue;
        char child_rel[2048], child[4096];
        snprintf(child_rel, sizeof child_rel, "%s%s%s", rel, *rel ? "/" : "", e->d_name);
        snprintf(child, sizeof child, "%s/%s", root, child_rel);
        struct stat st;
        if (stat(child, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) add_dir(fs, root, child_rel);
        else {
            size_t len;
            void *data = read_file(child, &len);
            if (data) add_file(fs, child_rel, data, len);
        }
    }
    closedir(d);
}

static int ends_with(const char *s, const char *suffix) {
    size_t a = strlen(s), b = strlen(suffix);
    return a >= b && strcmp(s + a - b, suffix) == 0;
}

static int add_archive(Files *fs, const char *path) {
    size_t len;
    void *bytes = read_file(path, &len);
    if (!bytes) { perror(path); return 0; }
    const char *error = NULL;
    TemenArchive *a = temen_project_read(bytes, len, &error);
    free(bytes);
    if (!a) { fprintf(stderr, "%s: cannot open the project (%s)\n", path, error ? error : "unknown error"); return 0; }
    for (size_t i = 0; i < temen_archive_count(a); i++) {
        const TemenFile *e = temen_archive_entry(a, i);
        void *data = malloc(e->len + 1);
        if (!data) { temen_archive_free(a); return 0; }
        memcpy(data, e->data, e->len);
        ((char *)data)[e->len] = 0;
        add_file(fs, e->name, data, e->len);
    }
    temen_archive_free(a);
    return 1;
}

static void on_message(void *ud, TemenMessageKind kind, const char *text, const char *file, int line) {
    (void)ud;
    if (kind == TEMEN_WARN) {
        if (file) fprintf(stderr, "Warning (%s:%d): %s\n", file, line, text);
        else fprintf(stderr, "Warning: %s\n", text);
    } else printf("%s\n", text);
}

static void write_stl(TemenCore *core, const char *path) {
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); return; }
    char header[80] = "TemenCAD binary STL";
    fwrite(header, 1, 80, f);
    uint32_t total = 0;
    for (size_t i = 0; i < temen_part_count(core); i++) {
        const TemenPart *p = temen_part(core, i);
        if (!p->ghost && !p->hidden) total += (uint32_t)p->n_tris;
    }
    fwrite(&total, 4, 1, f);
    for (size_t i = 0; i < temen_part_count(core); i++) {
        const TemenPart *p = temen_part(core, i);
        if (p->ghost || p->hidden) continue;
        for (size_t t = 0; t < p->n_tris; t++) {
            float tri[12] = {0};
            for (int k = 0; k < 3; k++) {
                const float *v = p->positions + p->indices[t * 3 + k] * 3;
                /* STL is Z up: (x, y, z)_Yup -> (x, -z, y) */
                tri[3 + k * 3 + 0] = v[0];
                tri[3 + k * 3 + 1] = -v[2];
                tri[3 + k * 3 + 2] = v[1];
            }
            fwrite(tri, sizeof(float), 12, f);
            uint16_t attr = 0;
            fwrite(&attr, 2, 1, f);
        }
    }
    fclose(f);
    printf("Wrote %s (%u triangles)\n", path, total);
}

int main(int argc, char **argv) {
    const char *input = NULL, *out = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) out = argv[++i];
        else if (strcmp(argv[i], "--version") == 0) { puts(temen_version()); return 0; }
        else input = argv[i];
    }
    if (!input) { fprintf(stderr, "usage: temencore <model.js | project-dir | project.temen> [-o out.stl]\n"); return 2; }

    Files fs = {0};
    struct stat st;
    if (stat(input, &st) != 0) { perror(input); return 2; }
    if (S_ISDIR(st.st_mode)) add_dir(&fs, input, "");
    else if (ends_with(input, ".temen")) { if (!add_archive(&fs, input)) return 2; }
    else {
        size_t len;
        void *data = read_file(input, &len);
        if (!data) { perror(input); return 2; }
        add_file(&fs, "main.js", data, len);
    }

    TemenCore *core = temen_new();
    if (!core) { fprintf(stderr, "cannot start the runtime\n"); return 2; }
    temen_set_message_fn(core, on_message, NULL);
    int status = temen_run(core, fs.files, fs.n);
    if (status != 0) {
        const char *file = temen_error_file(core);
        if (file) fprintf(stderr, "Error (%s:%d): %s\n", file, temen_error_line(core), temen_error(core));
        else fprintf(stderr, "Error: %s\n", temen_error(core));
    } else {
        size_t tris = 0;
        for (size_t i = 0; i < temen_part_count(core); i++) {
            const TemenPart *p = temen_part(core, i);
            printf("  %s: %zu triangles, %.1f mm³%s\n", p->name, p->n_tris, p->volume, p->ghost ? " (ghost)" : p->hidden ? " (hidden)" : "");
            tris += p->n_tris;
        }
        printf("%zu part%s, %zu triangles, %.0f ms\n", temen_part_count(core), temen_part_count(core) == 1 ? "" : "s", tris, temen_last_run_ms(core));
        if (out) write_stl(core, out);
    }
    temen_free(core);
    for (size_t i = 0; i < fs.n; i++) { free((void *)fs.files[i].name); free((void *)fs.files[i].data); }
    free(fs.files);
    return status;
}
