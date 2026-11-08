/*
 * The __cad namespace: flat natives over Manifold's C binding. Shapes cross
 * the boundary as numeric handles into a per-run table; the JavaScript
 * prelude wraps them in Shape objects and does the argument checking, so
 * these functions assume well-formed arguments and only guard against
 * misuse that would be memory-unsafe.
 *
 * Every Manifold object made during a run is released when the run ends
 * (the browser app does the same with releaseAll), which is why there is no
 * per-object free: the engine has no finalizer hook yet (see README).
 */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "host.h"
#include "js_bytecode.h" /* js_native_new */
#include "manifold/manifoldc.h"

/* ---------------------------------------------------------- handles */

uint32_t temen_handle_new(TemenCore *core, ManifoldManifold *m) {
    if (!m) return 0;
    if (core->n_objs == core->cap_objs) {
        size_t cap = core->cap_objs ? core->cap_objs * 2 : 64;
        ManifoldManifold **n = realloc(core->objs, cap * sizeof *n);
        if (!n) { manifold_delete_manifold(m); return 0; }
        core->objs = n; core->cap_objs = cap;
    }
    core->objs[core->n_objs++] = m;
    return (uint32_t)core->n_objs;
}

ManifoldManifold *temen_handle_get(TemenCore *core, double h) {
    if (!(h >= 1) || h > (double)core->n_objs || h != floor(h)) return NULL;
    return core->objs[(size_t)h - 1];
}

void temen_handles_release(TemenCore *core) {
    for (size_t i = 0; i < core->n_objs; i++) manifold_delete_manifold(core->objs[i]);
    core->n_objs = 0;
}

/* --------------------------------------------------------- helpers */

#define CORE() ((TemenCore *)js_context_userdata(ctx))
#define NUM(i) (((i) < argc && js_is_number(args[i])) ? js_get_number(args[i]) : 0.0)
#define THROW(v) do { *result = (v); return false; } while (0)

static void *mem(void) { return malloc(manifold_manifold_size()); }

static bool ret_handle(TemenCore *core, ManifoldManifold *m, JsValue *result) {
    uint32_t h = temen_handle_new(core, m);
    if (!h) THROW(temen_range_error(core, "geometry kernel: out of memory"));
    *result = js_number(h);
    return true;
}

static ManifoldManifold *arg_shape(JsContext *ctx, const JsValue *args, int argc, int i, JsValue *result) {
    ManifoldManifold *m = temen_handle_get(CORE(), NUM(i));
    if (!m) *result = temen_type_error(CORE(), "__cad: not a shape handle");
    return m;
}
#define SHAPE(i) ({ ManifoldManifold *m_ = arg_shape(ctx, args, argc, (i), result); if (!m_) return false; m_; })

/* ------------------------------------------------------- primitives */

static bool n_cube(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    return ret_handle(CORE(), manifold_cube(mem(), NUM(0), NUM(1), NUM(2), NUM(3) != 0), result);
}

/* cylinder(h, r1, r2, segments, center): Manifold builds along Z; TemenCAD is Y up, so turn it as cad.js does. */
static bool n_cylinder(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldManifold *z = manifold_cylinder(mem(), NUM(0), NUM(1), NUM(2), (int)NUM(3), NUM(4) != 0);
    ManifoldManifold *y = manifold_rotate(mem(), z, -90, 0, 0);
    manifold_delete_manifold(z);
    return ret_handle(CORE(), y, result);
}

static bool n_sphere(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    return ret_handle(CORE(), manifold_sphere(mem(), NUM(0), (int)NUM(1)), result);
}

/* ---------------------------------------------------------- booleans */

/* boolean(a, b, op) with op 0 = add, 1 = subtract, 2 = intersect */
static bool n_boolean(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldManifold *a = SHAPE(0), *b = SHAPE(1);
    int op = (int)NUM(2);
    ManifoldOpType t = op == 1 ? MANIFOLD_SUBTRACT : op == 2 ? MANIFOLD_INTERSECT : MANIFOLD_ADD;
    return ret_handle(CORE(), manifold_boolean(mem(), a, b, t), result);
}

/* batch(handles[], op): one n-ary boolean, cheaper than a fold for unions of many parts */
static bool n_batch(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 1 || !js_is_array(args[0])) THROW(temen_type_error(core, "__cad.batch: expected an array"));
    uint32_t n = js_array_length(args[0]);
    ManifoldManifoldVec *vec = manifold_manifold_vec(malloc(manifold_manifold_vec_size()), n);
    for (uint32_t i = 0; i < n; i++) {
        JsValue h = js_array_get(args[0], i);
        ManifoldManifold *m = temen_handle_get(core, js_is_number(h) ? js_get_number(h) : 0);
        if (!m) { manifold_delete_manifold_vec(vec); THROW(temen_type_error(core, "__cad.batch: not a shape handle")); }
        manifold_manifold_vec_set(vec, i, m);
    }
    int op = (int)NUM(1);
    ManifoldOpType t = op == 1 ? MANIFOLD_SUBTRACT : op == 2 ? MANIFOLD_INTERSECT : MANIFOLD_ADD;
    ManifoldManifold *out = manifold_batch_boolean(mem(), vec, t);
    manifold_delete_manifold_vec(vec);
    return ret_handle(core, out, result);
}

static bool n_hull(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 1 || !js_is_array(args[0])) THROW(temen_type_error(core, "__cad.hull: expected an array"));
    uint32_t n = js_array_length(args[0]);
    ManifoldManifoldVec *vec = manifold_manifold_vec(malloc(manifold_manifold_vec_size()), n);
    for (uint32_t i = 0; i < n; i++) {
        JsValue h = js_array_get(args[0], i);
        ManifoldManifold *m = temen_handle_get(core, js_is_number(h) ? js_get_number(h) : 0);
        if (!m) { manifold_delete_manifold_vec(vec); THROW(temen_type_error(core, "__cad.hull: not a shape handle")); }
        manifold_manifold_vec_set(vec, i, m);
    }
    ManifoldManifold *out = manifold_batch_hull(mem(), vec);
    manifold_delete_manifold_vec(vec);
    return ret_handle(core, out, result);
}

/* ------------------------------------------------------- transforms */

static bool n_translate(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldManifold *m = SHAPE(0);
    return ret_handle(CORE(), manifold_translate(mem(), m, NUM(1), NUM(2), NUM(3)), result);
}
static bool n_rotate(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldManifold *m = SHAPE(0);
    return ret_handle(CORE(), manifold_rotate(mem(), m, NUM(1), NUM(2), NUM(3)), result);
}
static bool n_scale(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldManifold *m = SHAPE(0);
    return ret_handle(CORE(), manifold_scale(mem(), m, NUM(1), NUM(2), NUM(3)), result);
}
static bool n_mirror(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldManifold *m = SHAPE(0);
    return ret_handle(CORE(), manifold_mirror(mem(), m, NUM(1), NUM(2), NUM(3)), result);
}

/* -------------------------------------------------------- queries */

static bool n_volume(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; *result = js_number(manifold_volume(SHAPE(0))); return true;
}
static bool n_area(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; *result = js_number(manifold_surface_area(SHAPE(0))); return true;
}
static bool n_is_empty(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; *result = js_bool(manifold_is_empty(SHAPE(0)) != 0); return true;
}
static bool n_num_tri(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; *result = js_number((double)manifold_num_tri(SHAPE(0))); return true;
}

/* bounds(h) -> [minx, miny, minz, maxx, maxy, maxz] */
static bool n_bounds(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    ManifoldManifold *m = SHAPE(0);
    ManifoldBox *box = manifold_bounding_box(malloc(manifold_box_size()), m);
    ManifoldVec3 lo = manifold_box_min(box), hi = manifold_box_max(box);
    manifold_delete_box(box);
    JsValue arr = js_array_new(ctx, 6);
    if (js_is_undefined(arr)) THROW(temen_range_error(core, "out of memory"));
    js_gc_protect(core->vm, &arr);
    double v[6] = { lo.x, lo.y, lo.z, hi.x, hi.y, hi.z };
    bool ok = true;
    for (int i = 0; i < 6 && ok; i++) ok = js_array_push(core->vm, arr, js_number(v[i]));
    js_gc_unprotect(core->vm, &arr);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = arr;
    return true;
}

/* ---------------------------------------------------------- output */

static bool emit(JsContext *ctx, const JsValue *args, int argc, TemenMessageKind kind, JsValue *result) {
    TemenCore *core = CORE();
    char *text = argc > 0 ? temen_value_to_utf8(core, args[0]) : strdup("");
    const char *file = NULL;
    int line = 0;
    temen_where(core, &file, &line);
    temen_message(core, kind, text ? text : "", file, line);
    free(text);
    *result = js_undefined();
    return true;
}
static bool n_log(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) { (void)this_val; return emit(ctx, args, argc, TEMEN_LOG, result); }
static bool n_warn(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) { (void)this_val; return emit(ctx, args, argc, TEMEN_WARN, result); }

/* where() -> [file, line] of the script line that called the prelude function now running, or undefined */
static bool n_where(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; (void)args; (void)argc;
    TemenCore *core = CORE();
    const char *file = NULL;
    int line = 0;
    if (!temen_where(core, &file, &line)) { *result = js_undefined(); return true; }
    JsValue arr = js_array_new(ctx, 2);
    if (js_is_undefined(arr)) THROW(temen_range_error(core, "out of memory"));
    js_gc_protect(core->vm, &arr);
    bool ok = js_array_push(core->vm, arr, temen_string(core, file, strlen(file))) && js_array_push(core->vm, arr, js_number(line));
    js_gc_unprotect(core->vm, &arr);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = arr;
    return true;
}

/* -------------------------------------------------------- install */

typedef struct { const char *name; JsNativeFn fn; } Entry;
static const Entry ENTRIES[] = {
    { "cube", n_cube }, { "cylinder", n_cylinder }, { "sphere", n_sphere },
    { "boolean", n_boolean }, { "batch", n_batch }, { "hull", n_hull },
    { "translate", n_translate }, { "rotate", n_rotate }, { "scale", n_scale }, { "mirror", n_mirror },
    { "volume", n_volume }, { "area", n_area }, { "isEmpty", n_is_empty }, { "numTri", n_num_tri }, { "bounds", n_bounds },
    { "log", n_log }, { "warn", n_warn }, { "where", n_where },
};

bool temen_install_cad(TemenCore *core) {
    JsValue ns = js_object_new(core->ctx);
    if (js_is_undefined(ns)) return false;
    core->cad_ns = ns;
    for (size_t i = 0; i < sizeof ENTRIES / sizeof ENTRIES[0]; i++) {
        JsValue fn = js_native_new(core->ctx, ENTRIES[i].name, ENTRIES[i].fn, NULL);
        if (js_is_undefined(fn)) return false;
        core->slot_a = fn;
        if (!js_object_set(core->vm, core->cad_ns, temen_atom(core, ENTRIES[i].name), fn)) return false;
    }
    core->slot_a = js_undefined();
    return js_object_set(core->vm, js_context_globals(core->ctx), temen_atom(core, "__cad"), core->cad_ns);
}
