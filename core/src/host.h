/* Internal state shared by host.c (engine, modules, run loop) and natives.c (the __cad namespace). */
#ifndef TEMEN_HOST_H
#define TEMEN_HOST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "lamassu.h"
#include "temencad.h"

typedef struct ManifoldManifold ManifoldManifold;
typedef struct ManifoldCrossSection ManifoldCrossSection;

/* A file handed to temen_run, kept for the duration of the run. */
typedef struct TemenHostFile {
    char *name;
    const uint8_t *data;
    size_t len;
    uint16_t *src16;   /* the module source as the engine saw it (set when loaded); for error lines */
    size_t len16;
    int user_lines;    /* lines in the file as the user wrote it; a position in the wrapper's tail maps to the last one */
} TemenHostFile;

/* A font the runtime can draw text with: bundled (embedded at build) or a project file (for one run). */
typedef struct TemenFont {
    char *name;
    char key[256];        /* normalised name: lower case, no spaces/hyphens/underscores */
    const uint8_t *data;
    size_t len;
    bool project;
    bool parsed;
    void *info;           /* stbtt_fontinfo, lazily parsed */
} TemenFont;

typedef struct TemenMessage {
    TemenMessageKind kind;
    char *text;
    char *file;
    int line;
} TemenMessage;

struct TemenCore {
    JsVm *vm;
    JsContext *ctx;
    bool prelude_loaded;

    /* GC-protected slots the run loop keeps values in. */
    JsValue cad_ns;        /* the __cad object */
    JsValue api_begin;     /* prelude's begin(): resets the run's state before main.js evaluates */
    JsValue api_run;       /* prelude's run(result): main.js's returned value -> parts */
    JsValue slot_a, slot_b, slot_c;

    /* the project of the current run */
    TemenHostFile *files;
    size_t n_files;
    uint16_t canon_buf[1024];

    /* results */
    TemenPart *parts;
    size_t n_parts, cap_parts;
    char *scratch_text;      /* temen_text_outlines result */
    float *cut_positions;    /* temen_cut_mesh result */
    uint32_t *cut_indices;
    TemenFont *fonts;
    size_t n_fonts, cap_fonts;
    TemenProfile profile;
    char **annotations;      /* JSON records from dimension() and mark(), in order */
    size_t n_annotations, cap_annotations;
    char *error, *error_file;
    int error_line;
    double last_ms;

    TemenMessageFn message_fn;
    void *message_ud;
};

/* host.c */
void temen_message(TemenCore *core, TemenMessageKind kind, const char *text, const char *file, int line);
uint16_t *temen_utf8_to_utf16(const char *s, size_t len, size_t *out_len);
char *temen_utf16_to_utf8(const uint16_t *u, size_t len);
char *temen_value_to_utf8(TemenCore *core, JsValue v);           /* ToString; malloc'd */
JsValue temen_atom(TemenCore *core, const char *ascii);
JsValue temen_string(TemenCore *core, const char *utf8, size_t len);
/* obj[name] = value with key and value rooted across the set (a safe point); false on OOM */
bool temen_object_set(TemenCore *core, JsValue obj, const char *name, JsValue value);
JsValue temen_type_error(TemenCore *core, const char *msg);      /* a TypeError value to throw */
JsValue temen_range_error(TemenCore *core, const char *msg);
JsValue temen_plain_error(TemenCore *core, const char *msg);           /* a plain Error */
#define error_plain temen_plain_error
/* The innermost frame that lies in a project file: its name (owned by the core) and 1-based line. */
bool temen_locate(TemenCore *core, const JsStackFrame *frames, size_t n, const char **file, int *line);
/* Where the running script is right now (for a native: its caller's line in the user's file). */
bool temen_where(TemenCore *core, const char **file, int *line);

/* host.c: a project file by its path, or NULL */
const TemenHostFile *temen_find_file(TemenCore *core, const char *name);

/* image.c */
bool temen_install_assets(TemenCore *core, JsValue ns);

/* text.c */
bool temen_fonts_init(TemenCore *core);
void temen_fonts_set_project(TemenCore *core, const TemenHostFile *files, size_t n_files);
void temen_fonts_free(TemenCore *core);
bool temen_install_text(TemenCore *core, JsValue ns);

/* natives.c */
bool temen_install_cad(TemenCore *core);                        /* creates __cad on the globals */
/* Shapes and sketches are host objects owning their Manifold object (freed by the collector);
 * _new adopts the object (deleting it and returning undefined on OOM), _get is NULL for anything else. */
JsValue temen_handle_new(TemenCore *core, ManifoldManifold *m);
ManifoldManifold *temen_handle_get(TemenCore *core, JsValue h);
/* Before evaluating shapes outside a native (collecting parts): collect garbage once if any of them is
 * an unevaluated boolean tree, then evaluate those, so the result does not depend on when the
 * collector last ran (see natives.c). The handles must be rooted. */
void temen_settle(TemenCore *core, const JsValue *handles, size_t n);
JsValue temen_cs_new(TemenCore *core, ManifoldCrossSection *cs);
ManifoldCrossSection *temen_cs_get(TemenCore *core, JsValue h);

#endif
