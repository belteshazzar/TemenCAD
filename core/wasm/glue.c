/*
 * Emscripten surface of the core: a flat C ABI that wasm/index.js wraps.
 * Files are pushed one by one, the run collects messages into a list the
 * JavaScript side reads back by index, and parts are read as pointers into
 * wasm memory (positions and indices are copied out by the wrapper).
 */
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "temencad.h"

#define EXPORT EMSCRIPTEN_KEEPALIVE

static TemenCore *g_core;
static TemenFile *g_files;
static size_t g_n_files, g_cap_files;

typedef struct { int kind; char *text; char *file; int line; } Msg;
static Msg *g_msgs;
static size_t g_n_msgs, g_cap_msgs;

static void clear_files(void) {
    for (size_t i = 0; i < g_n_files; i++) { free((void *)g_files[i].name); free((void *)g_files[i].data); }
    g_n_files = 0;
}
static void clear_msgs(void) {
    for (size_t i = 0; i < g_n_msgs; i++) { free(g_msgs[i].text); free(g_msgs[i].file); }
    g_n_msgs = 0;
}

static void on_message(void *ud, TemenMessageKind kind, const char *text, const char *file, int line) {
    (void)ud;
    if (g_n_msgs == g_cap_msgs) { g_cap_msgs = g_cap_msgs ? g_cap_msgs * 2 : 32; g_msgs = realloc(g_msgs, g_cap_msgs * sizeof *g_msgs); }
    g_msgs[g_n_msgs].kind = kind;
    g_msgs[g_n_msgs].text = strdup(text);
    g_msgs[g_n_msgs].file = file ? strdup(file) : NULL;
    g_msgs[g_n_msgs].line = line;
    g_n_msgs++;
}

EXPORT int tw_init(void) {
    if (!g_core) {
        g_core = temen_new();
        if (!g_core) return 0;
        temen_set_message_fn(g_core, on_message, NULL);
    }
    return 1;
}

EXPORT void tw_clear_files(void) { clear_files(); }

/* The wrapper allocates `data` with _malloc; the glue owns it from here. */
EXPORT void tw_add_file(const char *name, void *data, int len) {
    if (g_n_files == g_cap_files) { g_cap_files = g_cap_files ? g_cap_files * 2 : 16; g_files = realloc(g_files, g_cap_files * sizeof *g_files); }
    g_files[g_n_files].name = strdup(name);
    g_files[g_n_files].data = data;
    g_files[g_n_files].len = (size_t)len;
    g_n_files++;
}

EXPORT int tw_run(void) {
    clear_msgs();
    if (!tw_init()) return 2;
    return temen_run(g_core, g_files, g_n_files);
}

EXPORT const char *tw_error(void) { return g_core ? temen_error(g_core) : "runtime not started"; }
EXPORT const char *tw_error_file(void) { return g_core ? temen_error_file(g_core) : NULL; }
EXPORT int tw_error_line(void) { return g_core ? temen_error_line(g_core) : 0; }
EXPORT double tw_last_ms(void) { return g_core ? temen_last_run_ms(g_core) : 0; }
EXPORT const char *tw_version(void) { return temen_version(); }

EXPORT int tw_msg_count(void) { return (int)g_n_msgs; }
EXPORT int tw_msg_kind(int i) { return g_msgs[i].kind; }
EXPORT const char *tw_msg_text(int i) { return g_msgs[i].text; }
EXPORT const char *tw_msg_file(int i) { return g_msgs[i].file; }
EXPORT int tw_msg_line(int i) { return g_msgs[i].line; }

EXPORT int tw_part_count(void) { return g_core ? (int)temen_part_count(g_core) : 0; }
EXPORT const char *tw_part_name(int i) { return temen_part(g_core, (size_t)i)->name; }
EXPORT int tw_part_named(int i) { return temen_part(g_core, (size_t)i)->named; }
EXPORT const char *tw_part_color(int i) { return temen_part(g_core, (size_t)i)->color; }
EXPORT int tw_part_ghost(int i) { return temen_part(g_core, (size_t)i)->ghost; }
EXPORT int tw_part_hidden(int i) { return temen_part(g_core, (size_t)i)->hidden; }
EXPORT const float *tw_part_positions(int i) { return temen_part(g_core, (size_t)i)->positions; }
EXPORT int tw_part_nverts(int i) { return (int)temen_part(g_core, (size_t)i)->n_verts; }
EXPORT const uint32_t *tw_part_indices(int i) { return temen_part(g_core, (size_t)i)->indices; }
EXPORT int tw_part_ntris(int i) { return (int)temen_part(g_core, (size_t)i)->n_tris; }
EXPORT double tw_part_volume(int i) { return temen_part(g_core, (size_t)i)->volume; }
