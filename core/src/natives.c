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
#include <stdio.h>
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

uint32_t temen_cs_new(TemenCore *core, ManifoldCrossSection *cs) {
    if (!cs) return 0;
    if (core->n_cs == core->cap_cs) {
        size_t cap = core->cap_cs ? core->cap_cs * 2 : 64;
        ManifoldCrossSection **n = realloc(core->cs, cap * sizeof *n);
        if (!n) { manifold_delete_cross_section(cs); return 0; }
        core->cs = n; core->cap_cs = cap;
    }
    core->cs[core->n_cs++] = cs;
    return (uint32_t)core->n_cs;
}

ManifoldCrossSection *temen_cs_get(TemenCore *core, double h) {
    if (!(h >= 1) || h > (double)core->n_cs || h != floor(h)) return NULL;
    return core->cs[(size_t)h - 1];
}

void temen_handles_release(TemenCore *core) {
    for (size_t i = 0; i < core->n_objs; i++) manifold_delete_manifold(core->objs[i]);
    core->n_objs = 0;
    for (size_t i = 0; i < core->n_cs; i++) manifold_delete_cross_section(core->cs[i]);
    core->n_cs = 0;
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

static void *cs_mem(void) { return malloc(manifold_cross_section_size()); }

static bool ret_cs(TemenCore *core, ManifoldCrossSection *cs, JsValue *result) {
    uint32_t h = temen_cs_new(core, cs);
    if (!h) THROW(temen_range_error(core, "geometry kernel: out of memory"));
    *result = js_number(h);
    return true;
}

static ManifoldCrossSection *arg_cs(JsContext *ctx, const JsValue *args, int argc, int i, JsValue *result) {
    ManifoldCrossSection *cs = temen_cs_get(CORE(), NUM(i));
    if (!cs) *result = temen_type_error(CORE(), "__cad: not a sketch handle");
    return cs;
}
#define CS(i) ({ ManifoldCrossSection *c_ = arg_cs(ctx, args, argc, (i), result); if (!c_) return false; c_; })

static ManifoldOpType op_type(double op) { return op == 1 ? MANIFOLD_SUBTRACT : op == 2 ? MANIFOLD_INTERSECT : MANIFOLD_ADD; }

/* ---------------------------------------------------- polygons <-> JS */

/* [[ [x, y], ... ], ...] -> ManifoldPolygons (NULL with *result set to throw on bad input) */
static ManifoldPolygons *polygons_from_js(JsContext *ctx, JsValue rings, JsValue *result) {
    TemenCore *core = CORE();
    if (!js_is_array(rings)) { *result = temen_type_error(core, "__cad: polygons must be an array of rings"); return NULL; }
    uint32_t n = js_array_length(rings);
    ManifoldSimplePolygon **sps = calloc(n ? n : 1, sizeof *sps);
    if (!sps) { *result = temen_range_error(core, "out of memory"); return NULL; }
    bool ok = true;
    for (uint32_t i = 0; i < n && ok; i++) {
        JsValue ring = js_array_get(rings, i);
        if (!js_is_array(ring)) { ok = false; break; }
        uint32_t m = js_array_length(ring);
        ManifoldVec2 *pts = malloc((m ? m : 1) * sizeof *pts);
        if (!pts) { ok = false; break; }
        for (uint32_t k = 0; k < m; k++) {
            JsValue p = js_array_get(ring, k);
            JsValue x = js_array_get(p, 0), y = js_array_get(p, 1);
            if (!js_is_array(p) || !js_is_number(x) || !js_is_number(y)) { ok = false; break; }
            pts[k].x = js_get_number(x); pts[k].y = js_get_number(y);
        }
        if (ok) sps[i] = manifold_simple_polygon(malloc(manifold_simple_polygon_size()), pts, m);
        free(pts);
    }
    ManifoldPolygons *out = NULL;
    if (ok) out = manifold_polygons(malloc(manifold_polygons_size()), sps, n);
    else *result = temen_type_error(core, "__cad: polygons must be arrays of [x, y] points");
    for (uint32_t i = 0; i < n; i++) if (sps[i]) manifold_delete_simple_polygon(sps[i]);
    free(sps);
    return out;
}

/* ManifoldPolygons -> [[ [x, y], ... ], ...]; frees the polygons */
static bool polygons_to_js(JsContext *ctx, ManifoldPolygons *polys, JsValue *result) {
    TemenCore *core = CORE();
    size_t n = manifold_polygons_length(polys);
    JsValue outer = js_array_new(ctx, (uint32_t)n);
    if (js_is_undefined(outer)) { manifold_delete_polygons(polys); THROW(temen_range_error(core, "out of memory")); }
    js_gc_protect(core->vm, &outer);
    bool ok = true;
    for (size_t i = 0; i < n && ok; i++) {
        size_t m = manifold_polygons_simple_length(polys, i);
        JsValue ring = js_array_new(ctx, (uint32_t)m);
        if (js_is_undefined(ring)) { ok = false; break; }
        js_gc_protect(core->vm, &ring);
        for (size_t k = 0; k < m && ok; k++) {
            ManifoldVec2 v = manifold_polygons_get_point(polys, i, k);
            JsValue pt = js_array_new(ctx, 2);
            if (js_is_undefined(pt)) { ok = false; break; }
            js_gc_protect(core->vm, &pt);
            ok = js_array_push(core->vm, pt, js_number(v.x)) && js_array_push(core->vm, pt, js_number(v.y)) && js_array_push(core->vm, ring, pt);
            js_gc_unprotect(core->vm, &pt);
        }
        if (ok) ok = js_array_push(core->vm, outer, ring);
        js_gc_unprotect(core->vm, &ring);
    }
    js_gc_unprotect(core->vm, &outer);
    manifold_delete_polygons(polys);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = outer;
    return true;
}

/* ------------------------------------------------------ 2D sketches */

static bool n_cs_circle(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; return ret_cs(CORE(), manifold_cross_section_circle(cs_mem(), NUM(0), (int)NUM(1)), result);
}
static bool n_cs_square(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; return ret_cs(CORE(), manifold_cross_section_square(cs_mem(), NUM(0), NUM(1), NUM(2) != 0), result);
}
/* csPolygons(rings, fillRule): 0 even-odd, 1 non-zero, 2 positive */
static bool n_cs_polygons(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    if (argc < 1) THROW(temen_type_error(CORE(), "__cad.csPolygons: expected rings"));
    ManifoldPolygons *polys = polygons_from_js(ctx, args[0], result);
    if (!polys) return false;
    int fr = (int)NUM(1);
    ManifoldFillRule rule = fr == 1 ? MANIFOLD_FILL_RULE_NON_ZERO : fr == 2 ? MANIFOLD_FILL_RULE_POSITIVE : MANIFOLD_FILL_RULE_EVEN_ODD;
    ManifoldCrossSection *cs = manifold_cross_section_of_polygons(cs_mem(), polys, rule);
    manifold_delete_polygons(polys);
    return ret_cs(CORE(), cs, result);
}
static bool n_cs_boolean(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldCrossSection *a = CS(0), *b = CS(1);
    return ret_cs(CORE(), manifold_cross_section_boolean(cs_mem(), a, b, op_type(NUM(2))), result);
}
static ManifoldCrossSectionVec *cs_vec_from_js(JsContext *ctx, JsValue list, JsValue *result) {
    TemenCore *core = CORE();
    if (!js_is_array(list)) { *result = temen_type_error(core, "__cad: expected an array of sketch handles"); return NULL; }
    uint32_t n = js_array_length(list);
    ManifoldCrossSectionVec *vec = manifold_cross_section_vec(malloc(manifold_cross_section_vec_size()), n);
    for (uint32_t i = 0; i < n; i++) {
        JsValue h = js_array_get(list, i);
        ManifoldCrossSection *cs = temen_cs_get(core, js_is_number(h) ? js_get_number(h) : 0);
        if (!cs) { manifold_delete_cross_section_vec(vec); *result = temen_type_error(core, "__cad: not a sketch handle"); return NULL; }
        manifold_cross_section_vec_set(vec, i, cs);
    }
    return vec;
}
static bool n_cs_batch(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    if (argc < 1) THROW(temen_type_error(CORE(), "__cad.csBatch: expected an array"));
    ManifoldCrossSectionVec *vec = cs_vec_from_js(ctx, args[0], result);
    if (!vec) return false;
    ManifoldCrossSection *out = manifold_cross_section_batch_boolean(cs_mem(), vec, op_type(NUM(1)));
    manifold_delete_cross_section_vec(vec);
    return ret_cs(CORE(), out, result);
}
static bool n_cs_hull(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    if (argc < 1) THROW(temen_type_error(CORE(), "__cad.csHull: expected an array"));
    ManifoldCrossSectionVec *vec = cs_vec_from_js(ctx, args[0], result);
    if (!vec) return false;
    ManifoldCrossSection *out = manifold_cross_section_batch_hull(cs_mem(), vec);
    manifold_delete_cross_section_vec(vec);
    return ret_cs(CORE(), out, result);
}
/* csOffset(h, delta, join, miterLimit, segments): join 0 square, 1 round, 2 miter */
static bool n_cs_offset(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldCrossSection *cs = CS(0);
    int j = (int)NUM(2);
    ManifoldJoinType jt = j == 0 ? MANIFOLD_JOIN_TYPE_SQUARE : j == 2 ? MANIFOLD_JOIN_TYPE_MITER : MANIFOLD_JOIN_TYPE_ROUND;
    return ret_cs(CORE(), manifold_cross_section_offset(cs_mem(), cs, NUM(1), jt, NUM(3), (int)NUM(4)), result);
}
static bool n_cs_translate(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldCrossSection *cs = CS(0); return ret_cs(CORE(), manifold_cross_section_translate(cs_mem(), cs, NUM(1), NUM(2)), result);
}
static bool n_cs_rotate(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldCrossSection *cs = CS(0); return ret_cs(CORE(), manifold_cross_section_rotate(cs_mem(), cs, NUM(1)), result);
}
static bool n_cs_scale(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldCrossSection *cs = CS(0); return ret_cs(CORE(), manifold_cross_section_scale(cs_mem(), cs, NUM(1), NUM(2)), result);
}
static bool n_cs_mirror(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldCrossSection *cs = CS(0); return ret_cs(CORE(), manifold_cross_section_mirror(cs_mem(), cs, NUM(1), NUM(2)), result);
}
static bool n_cs_simplify(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldCrossSection *cs = CS(0); return ret_cs(CORE(), manifold_cross_section_simplify(cs_mem(), cs, NUM(1)), result);
}
static bool n_cs_area(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; *result = js_number(manifold_cross_section_area(CS(0))); return true;
}
static bool n_cs_is_empty(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; *result = js_bool(manifold_cross_section_is_empty(CS(0)) != 0); return true;
}
static bool n_cs_num_contour(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; *result = js_number((double)manifold_cross_section_num_contour(CS(0))); return true;
}
/* csBounds(h) -> [minx, miny, maxx, maxy] */
static bool n_cs_bounds(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    ManifoldCrossSection *cs = CS(0);
    ManifoldRect *r = manifold_cross_section_bounds(malloc(manifold_rect_size()), cs);
    ManifoldVec2 lo = manifold_rect_min(r), hi = manifold_rect_max(r);
    manifold_delete_rect(r);
    JsValue arr = js_array_new(ctx, 4);
    if (js_is_undefined(arr)) THROW(temen_range_error(core, "out of memory"));
    js_gc_protect(core->vm, &arr);
    double v[4] = { lo.x, lo.y, hi.x, hi.y };
    bool ok = true;
    for (int i = 0; i < 4 && ok; i++) ok = js_array_push(core->vm, arr, js_number(v[i]));
    js_gc_unprotect(core->vm, &arr);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = arr;
    return true;
}
static bool n_cs_to_polygons(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldCrossSection *cs = CS(0);
    return polygons_to_js(ctx, manifold_cross_section_to_polygons(malloc(manifold_polygons_size()), cs), result);
}

/* ---- 2D -> 3D and back. Manifold builds along Z; TemenCAD is Y up (shape.js Z_TO_Y = [-90, 0, 0]). */

/* extrude(cs, height, slices, twist, scaleX, scaleY) -> Y-up solid with its base on y = 0 */
static bool n_extrude(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldCrossSection *cs = CS(0);
    ManifoldPolygons *polys = manifold_cross_section_to_polygons(malloc(manifold_polygons_size()), cs);
    ManifoldManifold *z = manifold_extrude(mem(), polys, NUM(1), (int)NUM(2), NUM(3), NUM(4), NUM(5));
    manifold_delete_polygons(polys);
    ManifoldManifold *y = manifold_rotate(mem(), z, -90, 0, 0);
    manifold_delete_manifold(z);
    return ret_handle(CORE(), y, result);
}
/* revolve(cs, segments, degrees) -> Y-up solid around the Y axis */
static bool n_revolve(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldCrossSection *cs = CS(0);
    ManifoldPolygons *polys = manifold_cross_section_to_polygons(malloc(manifold_polygons_size()), cs);
    ManifoldManifold *z = manifold_revolve(mem(), polys, (int)NUM(1), NUM(2));
    manifold_delete_polygons(polys);
    ManifoldManifold *y = manifold_rotate(mem(), z, -90, 0, 0);
    manifold_delete_manifold(z);
    return ret_handle(CORE(), y, result);
}
/* project(shape) -> footprint sketch; slice(shape, y) -> the section at height y */
static bool project_or_slice(JsContext *ctx, const JsValue *args, int argc, bool slice, JsValue *result) {
    ManifoldManifold *m = SHAPE(0);
    ManifoldManifold *z = manifold_rotate(mem(), m, 90, 0, 0); /* back to Z up, so Y is the projection axis */
    ManifoldPolygons *polys = slice ? manifold_slice(malloc(manifold_polygons_size()), z, NUM(1))
                                    : manifold_project(malloc(manifold_polygons_size()), z);
    manifold_delete_manifold(z);
    ManifoldCrossSection *cs = manifold_cross_section_of_polygons(cs_mem(), polys, MANIFOLD_FILL_RULE_POSITIVE);
    manifold_delete_polygons(polys);
    return ret_cs(CORE(), cs, result);
}
static bool n_project(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) { (void)this_val; return project_or_slice(ctx, args, argc, false, result); }
static bool n_slice(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) { (void)this_val; return project_or_slice(ctx, args, argc, true, result); }

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

/* hullPoints(handles[], xyz[]) : the convex hull of the shapes' vertices together with raw points */
static bool n_hull_points(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 2 || !js_is_array(args[0]) || !js_is_array(args[1])) THROW(temen_type_error(core, "__cad.hullPoints: expected two arrays"));
    uint32_t nh = js_array_length(args[0]), np = js_array_length(args[1]) / 3;
    size_t cap = np, n = 0;
    for (uint32_t i = 0; i < nh; i++) {
        JsValue h = js_array_get(args[0], i);
        ManifoldManifold *m = temen_handle_get(core, js_is_number(h) ? js_get_number(h) : 0);
        if (!m) THROW(temen_type_error(core, "__cad.hullPoints: not a shape handle"));
        cap += manifold_num_vert(m);
    }
    ManifoldVec3 *pts = malloc((cap ? cap : 1) * sizeof *pts);
    if (!pts) THROW(temen_range_error(core, "out of memory"));
    for (uint32_t i = 0; i < nh; i++) {
        ManifoldManifold *m = temen_handle_get(core, js_get_number(js_array_get(args[0], i)));
        ManifoldMeshGL *mesh = manifold_get_meshgl(malloc(manifold_meshgl_size()), m);
        size_t nv = manifold_meshgl_num_vert(mesh), nprop = manifold_meshgl_num_prop(mesh);
        float *props = malloc(manifold_meshgl_vert_properties_length(mesh) * sizeof(float));
        if (props) {
            manifold_meshgl_vert_properties(props, mesh);
            for (size_t v = 0; v < nv; v++) { pts[n].x = props[v * nprop]; pts[n].y = props[v * nprop + 1]; pts[n].z = props[v * nprop + 2]; n++; }
            free(props);
        }
        manifold_delete_meshgl(mesh);
    }
    for (uint32_t i = 0; i < np; i++) {
        JsValue x = js_array_get(args[1], i * 3), y = js_array_get(args[1], i * 3 + 1), z = js_array_get(args[1], i * 3 + 2);
        if (!js_is_number(x) || !js_is_number(y) || !js_is_number(z)) { free(pts); THROW(temen_type_error(core, "__cad.hullPoints: points must be numbers")); }
        pts[n].x = js_get_number(x); pts[n].y = js_get_number(y); pts[n].z = js_get_number(z); n++;
    }
    ManifoldManifold *out = manifold_hull_pts(mem(), pts, n);
    free(pts);
    return ret_handle(core, out, result);
}

/* meshFromTriangles(positions[], tris[]): a solid from raw triangles (merged first, so coincident
 * vertices join). Throws naming Manifold's status when the mesh is not a closed, manifold solid. */
static const char *STATUS_NAMES[] = {
    "NoError", "NonFiniteVertex", "NotManifold", "VertexOutOfBounds", "PropertiesWrongLength", "MissingPositionProperties",
    "MergeVectorsDifferentLengths", "MergeIndexOutOfBounds", "TransformWrongLength", "RunIndexWrongLength", "FaceIDWrongLength",
    "InvalidConstruction", "ResultTooLarge",
};
static bool n_mesh_from_triangles(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 2 || !js_is_array(args[0]) || !js_is_array(args[1])) THROW(temen_type_error(core, "__cad.meshFromTriangles: expected two arrays"));
    uint32_t np = js_array_length(args[0]), nt = js_array_length(args[1]);
    if (np % 3 || nt % 3) THROW(temen_type_error(core, "__cad.meshFromTriangles: lengths must be multiples of 3"));
    float *pos = malloc((np ? np : 1) * sizeof *pos);
    uint32_t *tri = malloc((nt ? nt : 1) * sizeof *tri);
    if (!pos || !tri) { free(pos); free(tri); THROW(temen_range_error(core, "out of memory")); }
    for (uint32_t i = 0; i < np; i++) { JsValue v = js_array_get(args[0], i); if (!js_is_number(v)) { free(pos); free(tri); THROW(temen_type_error(core, "__cad.meshFromTriangles: positions must be numbers")); } pos[i] = (float)js_get_number(v); }
    for (uint32_t i = 0; i < nt; i++) {
        JsValue v = js_array_get(args[1], i);
        double d = js_is_number(v) ? js_get_number(v) : -1;
        if (d < 0 || d >= np / 3 || d != floor(d)) { free(pos); free(tri); THROW(temen_range_error(core, "__cad.meshFromTriangles: triangle index out of range")); }
        tri[i] = (uint32_t)d;
    }
    ManifoldMeshGL *raw = manifold_meshgl(malloc(manifold_meshgl_size()), pos, np / 3, 3, tri, nt / 3);
    free(pos); free(tri);
    ManifoldMeshGL *merged = manifold_meshgl_merge(malloc(manifold_meshgl_size()), raw);
    manifold_delete_meshgl(raw);
    ManifoldManifold *m = manifold_of_meshgl(mem(), merged);
    manifold_delete_meshgl(merged);
    ManifoldError st = manifold_status(m);
    if (st != MANIFOLD_NO_ERROR) {
        char msg[128];
        snprintf(msg, sizeof msg, "mesh status %s", (size_t)st < sizeof STATUS_NAMES / sizeof *STATUS_NAMES ? STATUS_NAMES[st] : "unknown");
        manifold_delete_manifold(m);
        THROW(temen_range_error(core, msg));
    }
    return ret_handle(core, m, result);
}

/* triangulate(rings, epsilon) -> flat [i0, i1, i2, ...] over the rings' points in order */
static bool n_triangulate(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 1) THROW(temen_type_error(core, "__cad.triangulate: expected rings"));
    ManifoldPolygons *polys = polygons_from_js(ctx, args[0], result);
    if (!polys) return false;
    ManifoldTriangulation *tr = manifold_triangulate(malloc(manifold_triangulation_size()), polys, NUM(1));
    manifold_delete_polygons(polys);
    size_t n = manifold_triangulation_num_tri(tr);
    int *idx = malloc((n ? n : 1) * 3 * sizeof *idx);
    if (!idx) { manifold_delete_triangulation(tr); THROW(temen_range_error(core, "out of memory")); }
    manifold_triangulation_tri_verts(idx, tr);
    manifold_delete_triangulation(tr);
    JsValue arr = js_array_new(ctx, (uint32_t)(n * 3));
    if (js_is_undefined(arr)) { free(idx); THROW(temen_range_error(core, "out of memory")); }
    js_gc_protect(core->vm, &arr);
    bool ok = true;
    for (size_t i = 0; i < n * 3 && ok; i++) ok = js_array_push(core->vm, arr, js_number(idx[i]));
    js_gc_unprotect(core->vm, &arr);
    free(idx);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = arr;
    return true;
}

/* mesh(h) -> { positions: [x, y, z, ...], triangles: [a, b, c, ...] }: a shape's mesh for mesh-level algorithms */
static bool n_mesh(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    ManifoldManifold *m = SHAPE(0);
    ManifoldMeshGL *mesh = manifold_get_meshgl(malloc(manifold_meshgl_size()), m);
    size_t nprop = manifold_meshgl_num_prop(mesh), nv = manifold_meshgl_num_vert(mesh), nt = manifold_meshgl_num_tri(mesh);
    float *props = malloc((manifold_meshgl_vert_properties_length(mesh) + 1) * sizeof(float));
    uint32_t *tv = malloc((manifold_meshgl_tri_length(mesh) + 1) * sizeof(uint32_t));
    if (!props || !tv) { free(props); free(tv); manifold_delete_meshgl(mesh); THROW(temen_range_error(core, "out of memory")); }
    manifold_meshgl_vert_properties(props, mesh);
    manifold_meshgl_tri_verts(tv, mesh);
    manifold_delete_meshgl(mesh);
    JsValue obj = js_object_new(ctx), pos = js_array_new(ctx, (uint32_t)(nv * 3)), tri = js_array_new(ctx, (uint32_t)(nt * 3));
    bool ok = !js_is_undefined(obj) && !js_is_undefined(pos) && !js_is_undefined(tri);
    js_gc_protect(core->vm, &obj); js_gc_protect(core->vm, &pos); js_gc_protect(core->vm, &tri);
    for (size_t i = 0; i < nv && ok; i++) for (int k = 0; k < 3 && ok; k++) ok = js_array_push(core->vm, pos, js_number(props[i * nprop + k]));
    for (size_t i = 0; i < nt * 3 && ok; i++) ok = js_array_push(core->vm, tri, js_number(tv[i]));
    if (ok) ok = js_object_set(core->vm, obj, temen_atom(core, "positions"), pos) && js_object_set(core->vm, obj, temen_atom(core, "triangles"), tri);
    js_gc_unprotect(core->vm, &tri); js_gc_unprotect(core->vm, &pos); js_gc_unprotect(core->vm, &obj);
    free(props); free(tv);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = obj;
    return true;
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

/* minGap(a, b, searchLength): smallest distance between two shapes' surfaces (>= searchLength when none found) */
static bool n_min_gap(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldManifold *a = SHAPE(0), *b = SHAPE(1);
    *result = js_number(manifold_min_gap(a, b, NUM(2)));
    return true;
}

/* annotate(json): a dimension or mark record for the host to draw and report; never geometry */
static bool n_annotate(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 1 || !js_is_string(args[0])) THROW(temen_type_error(core, "__cad.annotate: expected a JSON string"));
    char *json = temen_value_to_utf8(core, args[0]);
    if (!json) THROW(temen_range_error(core, "out of memory"));
    if (core->n_annotations == core->cap_annotations) {
        size_t cap = core->cap_annotations ? core->cap_annotations * 2 : 16;
        char **n = realloc(core->annotations, cap * sizeof *n);
        if (!n) { free(json); THROW(temen_range_error(core, "out of memory")); }
        core->annotations = n; core->cap_annotations = cap;
    }
    core->annotations[core->n_annotations++] = json;
    *result = js_undefined();
    return true;
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
    { "boolean", n_boolean }, { "batch", n_batch }, { "hull", n_hull }, { "hullPoints", n_hull_points },
    { "translate", n_translate }, { "rotate", n_rotate }, { "scale", n_scale }, { "mirror", n_mirror },
    { "minGap", n_min_gap }, { "annotate", n_annotate }, { "meshFromTriangles", n_mesh_from_triangles }, { "triangulate", n_triangulate }, { "mesh", n_mesh },
    { "volume", n_volume }, { "area", n_area }, { "isEmpty", n_is_empty }, { "numTri", n_num_tri }, { "bounds", n_bounds },
    { "log", n_log }, { "warn", n_warn }, { "where", n_where },
    { "csCircle", n_cs_circle }, { "csSquare", n_cs_square }, { "csPolygons", n_cs_polygons },
    { "csBoolean", n_cs_boolean }, { "csBatch", n_cs_batch }, { "csHull", n_cs_hull }, { "csOffset", n_cs_offset },
    { "csTranslate", n_cs_translate }, { "csRotate", n_cs_rotate }, { "csScale", n_cs_scale }, { "csMirror", n_cs_mirror },
    { "csSimplify", n_cs_simplify }, { "csArea", n_cs_area }, { "csIsEmpty", n_cs_is_empty }, { "csNumContour", n_cs_num_contour },
    { "csBounds", n_cs_bounds }, { "csToPolygons", n_cs_to_polygons },
    { "extrude", n_extrude }, { "revolve", n_revolve }, { "project", n_project }, { "slice", n_slice },
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
