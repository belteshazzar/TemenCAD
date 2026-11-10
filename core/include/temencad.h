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

/*
 * Outlines of a string in a bundled or project font, for a host that draws labels (the render sheet):
 * JSON {"rings":[[[x,y],...],...],"width":w} in millimetres, baseline at y = 0, or NULL with the reason
 * in temen_error(). align: 0 left, 1 centre, 2 right. The string is owned by the core until the next call.
 */
const char *temen_text_outlines(TemenCore *core, const char *text, const char *font, double size, int align,
                                double letter_spacing, int kerning, int curve_segments);

/*
 * The part of a mesh on one side of an axis-aligned plane (axis 0 = x, 1 = y, 2 = z, keeping coordinates
 * <= value), as a closed mesh with the cut face filled, for section renders. Returns 0 and fills *out,
 * 1 when nothing remains (out is zeroed), 2 on failure (temen_error). Buffers belong to the core until
 * the next call. The mesh must be closed, as a part's mesh is.
 */
int temen_cut_mesh(TemenCore *core, const float *positions, size_t n_verts, const uint32_t *indices, size_t n_tris,
                   int axis, double value, TemenPart *out);

/* Milliseconds the last run took. */
double temen_last_run_ms(const TemenCore *core);

/* ---- .temen archives (a plain zip), independent of any TemenCore --------------------------- */
typedef struct TemenArchive TemenArchive;

/* Reads a zip held in memory (CRCs checked; at most 65535 entries and 1 GiB uncompressed).
 * NULL on failure, with a static message in *error when error is not NULL. */
TemenArchive    *temen_archive_read(const void *bytes, size_t len, const char **error);
size_t           temen_archive_count(const TemenArchive *archive);
/* Reads a .temen project with the web app's rules (Project.fromZip in src/project.js): paths normalized
 * ('\\' to '/', '.' and '..' resolved), folders, __MACOSX/, dotfiles and paths outside the project
 * dropped, and main.js guaranteed (a lone script becomes main.js, otherwise no main.js is an error).
 * Entries under .assistant/ (the app's own data, e.g. the conversation) are kept apart as extras. */
TemenArchive    *temen_project_read(const void *bytes, size_t len, const char **error);
size_t           temen_archive_extra_count(const TemenArchive *archive);
const TemenFile *temen_archive_extra(const TemenArchive *archive, size_t index);
/* Entry `index` (folders are never entries): its name and bytes, owned by the archive until
 * temen_archive_free. For temen_archive_read the names are exactly as stored. */
const TemenFile *temen_archive_entry(const TemenArchive *archive, size_t index);
void             temen_archive_free(TemenArchive *archive);

/* Writes files as a zip, deflated at `level` 0..9 (6 when out of range). Returns a buffer of *out_len
 * bytes to release with temen_buffer_free, or NULL with a static message in *error. */
void *temen_archive_write(const TemenFile *files, size_t n_files, int level, size_t *out_len, const char **error);
void  temen_buffer_free(void *buffer);

/* ---- STL and 3MF, independent of any TemenCore (the web app's src/export.js, byte for byte) ----
 * Every part given is written, so leave out ghosts and hidden parts as the apps do. Coordinates go out
 * Z up, as slicers expect: (x, y, z) -> (x, -z, y), so the build plate y = 0 becomes z = 0. Returns a
 * buffer of *out_len bytes to release with temen_buffer_free, or NULL with a static message in *error. */
void *temen_write_stl(const TemenPart *parts, size_t n_parts, size_t *out_len, const char **error); /* binary, one solid */
void *temen_write_3mf(const TemenPart *parts, size_t n_parts, size_t *out_len, const char **error); /* named, coloured objects */

/* ---- the render sheet (the web app's src/render.js, pixel for pixel) ----------------------------- */
typedef struct TemenRenderOptions {
    const char *views;          /* comma-separated, in order: iso, top, bottom, front, back, left, right (NULL: iso) */
    int width, height;          /* one view in pixels (0: 480 x 360) */
    int supersample;            /* 0: 2 */
    int labels;                 /* view titles with the size, part names, scale bar, axis triad */
    int no_ghosts;              /* leave ghost parts out (they are drawn translucent otherwise) */
    int has_section;            /* cut every part open at section_axis = section_value (0 x, 1 y, 2 z), */
    int section_axis;           /* keeping coordinates <= value, and paint the cut faces */
    double section_value;
    const char *const *annotations; size_t n_annotations; /* temen_annotation records: dimensions and marks */
} TemenRenderOptions;
/* A sheet of the views as PNG (*out_len bytes, release with temen_buffer_free), or NULL with a static
 * message in *error. Hidden parts are left out. The core draws the labels, so it needs the TemenCore
 * (its bundled fonts); the parts may come from any build. */
void *temen_render_views(TemenCore *core, const TemenPart *parts, size_t n_parts, const TemenRenderOptions *options,
                         size_t *out_len, const char **error);

/* ---- pointing and measuring (the web app's src/pick-geometry.js, word for word) -------------------
 * A pick holds one part's mesh topology (vertices welded, faces found as needed); build it once per mesh.
 * The positions and indices are copied out; Y up, millimetres, as temen_part gives them. */
typedef struct TemenPick TemenPick;
TemenPick *temen_pick_new(const float *positions, size_t n_verts, const uint32_t *indices, size_t n_tris);
void       temen_pick_free(TemenPick *pick);
/* The surface triangle `tri` belongs to, as JSON: kind "flat" (normal, offset) or "curved" (shape
 * "cylinder" | "sphere" | "surface", radius, convex, center, axis, length, span in degrees), area, bounds
 * {min, max}, centroid, tris (every triangle of the surface, for highlighting), label (short, for a chip:
 * "lid · Ø6 hole along Y") and description (for the assistant). `part` names the part; `point` is where
 * the user tapped. NULL when tri is out of range. The string belongs to the pick until its next call. */
const char *temen_pick_surface(TemenPick *pick, size_t tri, const char *part, const double point[3]);
/* Between two tapped points (each on a triangle of a pick; snapped: it landed on a corner), as JSON:
 * distance, delta (|dx|, |dy|, |dz|), gap (the distance between two parallel flat faces, else null), label
 * ("Measured 12.5 mm") and text (for the assistant). The string belongs to pick_a until its next call. */
const char *temen_pick_measure(TemenPick *pick_a, size_t tri_a, const char *part_a, const double point_a[3], int snapped_a,
                               TemenPick *pick_b, size_t tri_b, const char *part_b, const double point_b[3], int snapped_b);

/* Version strings of the pieces, for a report or an about box. */
const char *temen_version(void);

#ifdef __cplusplus
}
#endif

#endif /* TEMENCAD_H */
