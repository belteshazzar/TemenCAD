/*
 * temencore — build a TemenCAD model natively.
 *
 *   temencore model.js [-o out.stl]        a single script (it becomes main.js)
 *   temencore project-dir [-o out.stl]     a folder with main.js and its imports
 *   temencore project.temen [-o out.stl]   a .temen project archive (a zip)
 *
 * Prints messages as the build emits them, then one line per part with its
 * triangle count and volume; with -o writes the visible, non-ghost parts as a
 * binary STL, or as 3MF with named, coloured objects when the name ends in .3mf. Exit code 1 on a script error, 2 on a runtime failure.
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

/* The visible, non-ghost parts as binary STL or, for a .3mf path, 3MF (the core's writers). */
static int write_model(TemenCore *core, const char *path) {
    size_t n = 0;
    TemenPart *parts = malloc((temen_part_count(core) + 1) * sizeof *parts);
    if (!parts) return 0;
    for (size_t i = 0; i < temen_part_count(core); i++) {
        const TemenPart *p = temen_part(core, i);
        if (!p->ghost && !p->hidden) parts[n++] = *p;
    }
    if (!n) { free(parts); fprintf(stderr, "Nothing to export: no visible, non-ghost parts\n"); return 0; }
    int is_3mf = ends_with(path, ".3mf");
    size_t len = 0, tris = 0;
    const char *error = NULL;
    for (size_t i = 0; i < n; i++) tris += parts[i].n_tris;
    void *buf = is_3mf ? temen_write_3mf(parts, n, &len, &error) : temen_write_stl(parts, n, &len, &error);
    free(parts);
    if (!buf) { fprintf(stderr, "%s: %s\n", path, error ? error : "cannot write"); return 0; }
    FILE *f = fopen(path, "wb");
    int ok = f && fwrite(buf, 1, len, f) == len;
    if (f && fclose(f) != 0) ok = 0;
    temen_buffer_free(buf);
    if (!ok) { perror(path); return 0; }
    if (is_3mf) printf("Wrote %s (%zu part%s)\n", path, n, n == 1 ? "" : "s");
    else printf("Wrote %s (%zu triangles)\n", path, tris);
    return 1;
}

/* --pick N: about N triangles of every part (every max(1, n_tris / N)th) as the surface each belongs to,
 * and a measurement from each to the next sampled in the same part, one JSON line each (for
 * core/test/pick-parity.mjs). The tapped point is the triangle's centroid. */
static void pick_dump(TemenCore *core, size_t samples) {
    for (size_t i = 0; i < temen_part_count(core); i++) {
        const TemenPart *p = temen_part(core, i);
        size_t every = p->n_tris / samples > 1 ? p->n_tris / samples : 1;
        TemenPick *pick = temen_pick_new(p->positions, p->n_verts, p->indices, p->n_tris);
        if (!pick) continue;
        size_t prev = (size_t)-1;
        double prev_pt[3] = { 0 };
        for (size_t t = 0; t < p->n_tris; t += every) {
            double pt[3] = { 0, 0, 0 };
            for (int k = 0; k < 3; k++) for (int j = 0; j < 3; j++) pt[j] += (double)p->positions[p->indices[t * 3 + k] * 3 + j];
            for (int j = 0; j < 3; j++) pt[j] /= 3;
            printf("{\"part\":%zu,\"tri\":%zu,\"surface\":%s}\n", i, t, temen_pick_surface(pick, t, p->name, pt));
            if (prev != (size_t)-1)
                printf("{\"part\":%zu,\"tri\":%zu,\"from\":%zu,\"snapped\":%d,\"measure\":%s}\n", i, t, prev, (int)(t / every) % 2,
                       temen_pick_measure(pick, prev, p->name, prev_pt, (int)(t / every) % 2, pick, t, p->name, pt, 0));
            prev = t;
            memcpy(prev_pt, pt, sizeof pt);
        }
        temen_pick_free(pick);
    }
}

int main(int argc, char **argv) {
    const char *input = NULL, *out = NULL;
    size_t pick_every = 0;
    const char *png = NULL, *views = "iso";
    int view_w = 480, view_h = 360, labels = 1, has_section = 0, section_axis = 0;
    double section_value = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) out = argv[++i];
        else if (strcmp(argv[i], "--pick") == 0 && i + 1 < argc) pick_every = (size_t)atol(argv[++i]);
        else if (strcmp(argv[i], "--png") == 0 && i + 1 < argc) png = argv[++i];
        else if (strcmp(argv[i], "--views") == 0 && i + 1 < argc) views = argv[++i];
        else if (strcmp(argv[i], "--size") == 0 && i + 1 < argc) { if (sscanf(argv[++i], "%dx%d", &view_w, &view_h) != 2) { fprintf(stderr, "--size is WIDTHxHEIGHT\n"); return 2; } }
        else if (strcmp(argv[i], "--no-labels") == 0) labels = 0;
        else if (strcmp(argv[i], "--section") == 0 && i + 1 < argc) {
            const char *s = argv[++i];
            if ((s[0] != 'x' && s[0] != 'y' && s[0] != 'z') || s[1] != '=') { fprintf(stderr, "--section is axis=value, e.g. y=5\n"); return 2; }
            has_section = 1; section_axis = s[0] - 'x'; section_value = atof(s + 2);
        }
        else if (strcmp(argv[i], "--version") == 0) { puts(temen_version()); return 0; }
        else input = argv[i];
    }
    if (!input) { fprintf(stderr, "usage: temencore <model.js | project-dir | project.temen> [-o out.stl | out.3mf] [--png out.png [--views iso,top] [--size 480x360] [--section y=5] [--no-labels]]\n"); return 2; }

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
        if (out && !write_model(core, out)) status = 2;
        if (pick_every) pick_dump(core, pick_every);
        if (png) {
            size_t np = temen_part_count(core), na = temen_annotation_count(core), len = 0;
            TemenPart *parts = malloc((np + 1) * sizeof *parts);
            const char **ann = malloc((na + 1) * sizeof *ann);
            for (size_t i = 0; i < np; i++) parts[i] = *temen_part(core, i);
            for (size_t i = 0; i < na; i++) ann[i] = temen_annotation(core, i);
            TemenRenderOptions ro = { views, view_w, view_h, 2, labels, 0, has_section, section_axis, section_value, ann, na };
            const char *error = NULL;
            void *bytes = temen_render_views(core, parts, np, &ro, &len, &error);
            FILE *f = bytes ? fopen(png, "wb") : NULL;
            if (!bytes) { fprintf(stderr, "%s: %s\n", png, error ? error : "cannot render"); status = 2; }
            else if (!f || fwrite(bytes, 1, len, f) != len) { perror(png); status = 2; }
            else printf("Rendered %s (%s)\n", png, views);
            if (f) fclose(f);
            temen_buffer_free(bytes);
            free(parts); free(ann);
        }
    }
    temen_free(core);
    for (size_t i = 0; i < fs.n; i++) { free((void *)fs.files[i].name); free((void *)fs.files[i].data); }
    free(fs.files);
    return status;
}
