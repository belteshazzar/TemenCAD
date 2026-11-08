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
    int line_offset;   /* lines the wrapper added before the user's first line (1 for main.js) */
    int user_lines;    /* lines in the file as the user wrote it; a position in the wrapper's tail maps to the last one */
} TemenHostFile;

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
    JsValue api_run;       /* prelude's run(main) */
    JsValue slot_a, slot_b, slot_c;

    /* the project of the current run */
    TemenHostFile *files;
    size_t n_files;
    uint16_t canon_buf[1024];

    /* Manifold objects created during the run; all freed when it ends. */
    ManifoldManifold **objs;
    size_t n_objs, cap_objs;
    ManifoldCrossSection **cs;
    size_t n_cs, cap_cs;

    /* results */
    TemenPart *parts;
    size_t n_parts, cap_parts;
    TemenProfile profile;
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
JsValue temen_type_error(TemenCore *core, const char *msg);      /* a TypeError value to throw */
JsValue temen_range_error(TemenCore *core, const char *msg);
/* The innermost frame that lies in a project file: its name (owned by the core) and 1-based line. */
bool temen_locate(TemenCore *core, const JsStackFrame *frames, size_t n, const char **file, int *line);
/* Where the running script is right now (for a native: its caller's line in the user's file). */
bool temen_where(TemenCore *core, const char **file, int *line);

/* natives.c */
bool temen_install_cad(TemenCore *core);                        /* creates __cad on the globals */
uint32_t temen_handle_new(TemenCore *core, ManifoldManifold *m); /* 1-based; 0 on failure */
ManifoldManifold *temen_handle_get(TemenCore *core, double h);
uint32_t temen_cs_new(TemenCore *core, ManifoldCrossSection *cs);
ManifoldCrossSection *temen_cs_get(TemenCore *core, double h);
void temen_handles_release(TemenCore *core);

#endif
