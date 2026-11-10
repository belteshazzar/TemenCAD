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

EXPORT int tw_profile_declared(void) { return temen_profile(g_core)->declared; }
EXPORT double tw_profile_nozzle(void) { return temen_profile(g_core)->nozzle; }
EXPORT double tw_profile_layer(void) { return temen_profile(g_core)->layer; }
EXPORT double tw_profile_hole_compensation(void) { return temen_profile(g_core)->hole_compensation; }
EXPORT const char *tw_profile_material(void) { return temen_profile(g_core)->material; }

EXPORT int tw_annotation_count(void) { return (int)temen_annotation_count(g_core); }
EXPORT const char *tw_annotation(int i) { return temen_annotation(g_core, (size_t)i); }

EXPORT const char *tw_text_outlines(const char *text, const char *font, double size, int align, double letter_spacing, int kerning, int curve_segments) {
    return temen_text_outlines(g_core, text, font, size, align, letter_spacing, kerning, curve_segments);
}
static TemenPart g_cut;
EXPORT int tw_cut_mesh(const float *positions, int n_verts, const uint32_t *indices, int n_tris, int axis, double value) {
    return temen_cut_mesh(g_core, positions, (size_t)n_verts, indices, (size_t)n_tris, axis, value, &g_cut);
}
EXPORT const float *tw_cut_positions(void) { return g_cut.positions; }
EXPORT int tw_cut_nverts(void) { return (int)g_cut.n_verts; }
EXPORT const uint32_t *tw_cut_indices(void) { return g_cut.indices; }
EXPORT int tw_cut_ntris(void) { return (int)g_cut.n_tris; }

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

/* ---- the conversation format (core/CONVERSATION.md): blobs and files are pushed, results read by index ---- */
static TemenBlob *g_blobs;
static size_t g_n_blobs, g_cap_blobs;
static TemenFile *g_conv_files;   /* pack: the archive entries written; unpack: the entries pushed */
static size_t g_n_conv_files, g_cap_conv_files;
static int g_conv_files_owned;    /* written by temen_conversation_pack (freed with temen_files_free) */
static TemenConversation *g_conv;
static char *g_conv_error;

static void clear_conv(void) {
    for (size_t i = 0; i < g_n_blobs; i++) { free((void *)g_blobs[i].key); free((void *)g_blobs[i].data); }
    g_n_blobs = 0;
    if (g_conv_files_owned) { temen_files_free(g_conv_files, g_n_conv_files); g_conv_files = NULL; g_cap_conv_files = 0; }
    else for (size_t i = 0; i < g_n_conv_files; i++) { free((void *)g_conv_files[i].name); free((void *)g_conv_files[i].data); }
    g_n_conv_files = 0;
    g_conv_files_owned = 0;
    temen_conversation_free(g_conv);
    g_conv = NULL;
    temen_buffer_free(g_conv_error);
    g_conv_error = NULL;
}

EXPORT void tw_conv_clear(void) { clear_conv(); }

/* `data` allocated with _malloc by the wrapper; the glue owns it from here. */
EXPORT void tw_conv_add_blob(const char *key, void *data, int len) {
    if (g_n_blobs == g_cap_blobs) { g_cap_blobs = g_cap_blobs ? g_cap_blobs * 2 : 16; g_blobs = realloc(g_blobs, g_cap_blobs * sizeof *g_blobs); }
    g_blobs[g_n_blobs].key = strdup(key);
    g_blobs[g_n_blobs].data = data;
    g_blobs[g_n_blobs].len = (size_t)len;
    g_n_blobs++;
}
EXPORT void tw_conv_add_file(const char *name, void *data, int len) {
    if (g_n_conv_files == g_cap_conv_files) { g_cap_conv_files = g_cap_conv_files ? g_cap_conv_files * 2 : 16; g_conv_files = realloc(g_conv_files, g_cap_conv_files * sizeof *g_conv_files); }
    g_conv_files[g_n_conv_files].name = strdup(name);
    g_conv_files[g_n_conv_files].data = data;
    g_conv_files[g_n_conv_files].len = (size_t)len;
    g_n_conv_files++;
}

/* Packs the JSON with the pushed blobs: the number of archive entries written, or -1 (tw_conv_error). */
EXPORT int tw_conv_pack(const char *json, int len) {
    size_t n = 0;
    TemenFile *files = temen_conversation_pack(json, (size_t)len, g_blobs, g_n_blobs, &n, &g_conv_error);
    if (!files) return -1;
    if (!g_conv_files_owned) { for (size_t i = 0; i < g_n_conv_files; i++) { free((void *)g_conv_files[i].name); free((void *)g_conv_files[i].data); } free(g_conv_files); }
    g_conv_files = files;
    g_n_conv_files = n;
    g_conv_files_owned = 1;
    return (int)n;
}
EXPORT const char *tw_conv_file_name(int i) { return g_conv_files[i].name; }
EXPORT const void *tw_conv_file_data(int i) { return g_conv_files[i].data; }
EXPORT int tw_conv_file_len(int i) { return (int)g_conv_files[i].len; }

/* Unpacks the pushed files: 1 with a conversation, 0 without one, -1 on error (tw_conv_error). */
EXPORT int tw_conv_unpack(void) {
    temen_conversation_free(g_conv);
    g_conv = temen_conversation_unpack(g_conv_files, g_n_conv_files, &g_conv_error);
    return g_conv ? 1 : g_conv_error ? -1 : 0;
}
EXPORT const char *tw_conv_json(void) { return temen_conversation_json(g_conv, NULL); }
EXPORT int tw_conv_json_len(void) { size_t n; temen_conversation_json(g_conv, &n); return (int)n; }
EXPORT int tw_conv_blob_count(void) { return (int)temen_conversation_blob_count(g_conv); }
EXPORT const char *tw_conv_blob_key(int i) { return temen_conversation_blob(g_conv, (size_t)i)->key; }
EXPORT const void *tw_conv_blob_data(int i) { return temen_conversation_blob(g_conv, (size_t)i)->data; }
EXPORT int tw_conv_blob_len(int i) { return (int)temen_conversation_blob(g_conv, (size_t)i)->len; }
EXPORT const char *tw_conv_error(void) { return g_conv_error ? g_conv_error : ""; }
