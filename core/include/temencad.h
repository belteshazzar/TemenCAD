/*
 * TemenCAD core — the modelling runtime as one C library.
 *
 * A project (a set of named files with a main.js entry) runs on the lamassu
 * JavaScript engine; the geometry is Manifold through its C binding. The same
 * library is linked into the browser (Emscripten), a native command line tool,
 * and a Swift package: nothing here depends on the host platform.
 *
 * Threading: one TemenCore is single-threaded. Use it from one thread.
 */
#ifndef TEMENCAD_H
#define TEMENCAD_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TemenCore TemenCore;

/* One project file. `data` is bytes; scripts and fonts names decide how it is read. */
typedef struct TemenFile {
    const char *name;   /* project-relative path, e.g. "main.js", "parts/lid.js", "Logo.ttf" */
    const void *data;
    size_t len;
} TemenFile;

typedef enum TemenMessageKind {
    TEMEN_LOG = 0,   /* log(), print(), echo() output */
    TEMEN_WARN = 1   /* warnings: empty parts, printability, ... */
} TemenMessageKind;

/* Receives messages during a run. `file` may be NULL and `line` 0 when unknown. */
typedef void (*TemenMessageFn)(void *ud, TemenMessageKind kind, const char *text,
                               const char *file, int line);

/* One built part. Buffers belong to the core and stay valid until the next run or temen_free. */
typedef struct TemenPart {
    const char *name;        /* "lid", or "Part 3" when the script gave no name */
    int named;               /* 1 if the script named it */
    const char *color;       /* "#rrggbb" */
    int ghost;
    int hidden;
    const float *positions;  /* n_verts * 3 floats, Y up, millimetres */
    size_t n_verts;
    const uint32_t *indices; /* n_tris * 3 vertex indices */
    size_t n_tris;
    double volume;           /* mm^3 */
} TemenPart;

/* The printer profile the script declared with printer(); `declared` is 0 when it did not. */
typedef struct TemenProfile {
    int declared;
    double nozzle;
    double layer;
    double hole_compensation;
    const char *material; /* NULL when none */
} TemenProfile;

TemenCore *temen_new(void);
void       temen_free(TemenCore *core);

void temen_set_message_fn(TemenCore *core, TemenMessageFn fn, void *ud);

/*
 * Runs the project: evaluates main.js and collects the shapes it returns or
 * show()s. Returns 0 on success, 1 on a script error (see temen_error_*),
 * 2 when the runtime itself failed (out of memory, engine fault).
 * Parts from the previous run are released when a new run starts.
 */
int temen_run(TemenCore *core, const TemenFile *files, size_t n_files);

/* After a failed run: the message, and where it came from (file NULL / line 0 when unknown). */
const char *temen_error(const TemenCore *core);
const char *temen_error_file(const TemenCore *core);
int         temen_error_line(const TemenCore *core);

size_t           temen_part_count(const TemenCore *core);
const TemenPart *temen_part(const TemenCore *core, size_t index);

/* Annotations from dimension() and mark(), as JSON records in script order:
 * {"type":"dimension","a":[x,y,z],"b":[x,y,z],"label":"12 mm","length":12} or {"type":"mark","p":[x,y,z],"text":"tip"} */
size_t      temen_annotation_count(const TemenCore *core);
const char *temen_annotation(const TemenCore *core, size_t index);

/* The profile of the last run (declared == 0 when the script declared none). */
const TemenProfile *temen_profile(const TemenCore *core);

/* Milliseconds the last run took. */
double temen_last_run_ms(const TemenCore *core);

/* Version strings of the pieces, for a report or an about box. */
const char *temen_version(void);

#ifdef __cplusplus
}
#endif

#endif /* TEMENCAD_H */
