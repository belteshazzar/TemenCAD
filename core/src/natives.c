/*
 * The __cad namespace: flat natives over Manifold's C binding. Shapes cross
 * the boundary as host objects that own their Manifold object; the JavaScript
 * prelude wraps them in Shape objects and does the argument checking, so
 * these functions assume well-formed arguments and only guard against
 * misuse that would be memory-unsafe.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "host.h"
#include "manifold/manifoldc.h"

/* ---------------------------------------------------------- handles */

/*
 * A shape or sketch crosses into the script as a lamassu host object that owns its Manifold
 * object: the class finalizer deletes it once the script can no longer reach it, so memory follows
 * the script's own lifetimes (a long loop of booleans frees its intermediates as it goes, and an
 * app that keeps a core between builds keeps exactly what is still referenced).
 *
 * The engine cannot see how big a Manifold object is without forcing its lazy boolean tree, so each
 * one claims a fixed estimate of external memory: enough that collections keep pace with geometry
 * rather than with the small script objects wrapped around it.
 */
#define SHAPE_EXTERNAL_BYTES ((size_t)64 * 1024)
#define SKETCH_EXTERNAL_BYTES ((size_t)8 * 1024)

static void finalize_shape(void *ptr, void *ud) { (void)ud; manifold_delete_manifold(ptr); }
static void finalize_sketch(void *ptr, void *ud) { (void)ud; manifold_delete_cross_section(ptr); }
static const JsHostClass SHAPE_CLASS = { "Shape", finalize_shape, NULL };
static const JsHostClass SKETCH_CLASS = { "Sketch", finalize_sketch, NULL };

JsValue temen_handle_new(TemenCore *core, ManifoldManifold *m) {
    if (!m) return js_undefined();
    JsValue v = js_host_object_new(core->ctx, &SHAPE_CLASS, m, SHAPE_EXTERNAL_BYTES);
    if (js_is_undefined(v)) manifold_delete_manifold(m); /* not adopted: still ours */
    return v;
}

ManifoldManifold *temen_handle_get(TemenCore *core, JsValue h) {
    (void)core;
    return js_host_object_ptr(h, &SHAPE_CLASS);
}

JsValue temen_cs_new(TemenCore *core, ManifoldCrossSection *cs) {
    if (!cs) return js_undefined();
    JsValue v = js_host_object_new(core->ctx, &SKETCH_CLASS, cs, SKETCH_EXTERNAL_BYTES);
    if (js_is_undefined(v)) manifold_delete_cross_section(cs);
    return v;
}

ManifoldCrossSection *temen_cs_get(TemenCore *core, JsValue h) {
    (void)core;
    return js_host_object_ptr(h, &SKETCH_CLASS);
}

/* --------------------------------------------------------- helpers */

#define CORE() ((TemenCore *)js_context_userdata(ctx))
#define NUM(i) (((i) < argc && js_is_number(args[i])) ? js_get_number(args[i]) : 0.0)
#define THROW(v) do { *result = (v); return false; } while (0)

static void *mem(void) { return malloc(manifold_manifold_size()); }

static bool ret_handle(TemenCore *core, ManifoldManifold *m, JsValue *result) {
    JsValue h = temen_handle_new(core, m);
    if (js_is_undefined(h)) THROW(temen_range_error(core, "geometry kernel: out of memory"));
    *result = h;
    return true;
}

static ManifoldManifold *arg_shape(JsContext *ctx, const JsValue *args, int argc, int i, JsValue *result) {
    ManifoldManifold *m = (i) < argc ? temen_handle_get(CORE(), args[i]) : NULL;
    if (!m) *result = temen_type_error(CORE(), "__cad: not a shape handle");
    return m;
}
#define SHAPE(i) ({ ManifoldManifold *m_ = arg_shape(ctx, args, argc, (i), result); if (!m_) return false; m_; })

/* What a shape whose mesh exists really holds: about 240 bytes a triangle in Manifold's half-edge
 * form (measured). Recorded only where the mesh is already built (constructors that build it, and
 * queries that force it), since asking a lazy boolean its size would evaluate it early. */
#define BYTES_PER_TRIANGLE ((size_t)240)
static void measure(TemenCore *core, JsValue h, ManifoldManifold *m) {
    size_t b = manifold_num_tri(m) * BYTES_PER_TRIANGLE;
    js_host_object_set_external(core->vm, h, &SHAPE_CLASS, b > SHAPE_EXTERNAL_BYTES ? b : SHAPE_EXTERNAL_BYTES);
}
/* ret_handle for a result Manifold builds eagerly (primitives, extrusions, hulls, meshes) */
static bool ret_solid(TemenCore *core, ManifoldManifold *m, JsValue *result) {
    if (!ret_handle(core, m, result)) return false;
    measure(core, *result, m); /* m is the host object's now, alive as long as *result */
    return true;
}

static void *cs_mem(void) { return malloc(manifold_cross_section_size()); }

static bool ret_cs(TemenCore *core, ManifoldCrossSection *cs, JsValue *result) {
    JsValue h = temen_cs_new(core, cs);
    if (js_is_undefined(h)) THROW(temen_range_error(core, "geometry kernel: out of memory"));
    *result = h;
    return true;
}

static ManifoldCrossSection *arg_cs(JsContext *ctx, const JsValue *args, int argc, int i, JsValue *result) {
    ManifoldCrossSection *cs = (i) < argc ? temen_cs_get(CORE(), args[i]) : NULL;
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
        ManifoldCrossSection *cs = temen_cs_get(core, h);
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
    return ret_solid(CORE(), y, result);
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
    return ret_solid(CORE(), y, result);
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
    return ret_solid(CORE(), manifold_cube(mem(), NUM(0), NUM(1), NUM(2), NUM(3) != 0), result);
}

/* cylinder(h, r1, r2, segments, center): Manifold builds along Z; TemenCAD is Y up, so turn it as cad.js does. */
static bool n_cylinder(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    ManifoldManifold *z = manifold_cylinder(mem(), NUM(0), NUM(1), NUM(2), (int)NUM(3), NUM(4) != 0);
    ManifoldManifold *y = manifold_rotate(mem(), z, -90, 0, 0);
    manifold_delete_manifold(z);
    return ret_solid(CORE(), y, result);
}

static bool n_sphere(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    return ret_solid(CORE(), manifold_sphere(mem(), NUM(0), (int)NUM(1)), result);
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
        ManifoldManifold *m = temen_handle_get(core, h);
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
        ManifoldManifold *m = temen_handle_get(core, h);
        if (!m) { manifold_delete_manifold_vec(vec); THROW(temen_type_error(core, "__cad.hull: not a shape handle")); }
        manifold_manifold_vec_set(vec, i, m);
    }
    ManifoldManifold *out = manifold_batch_hull(mem(), vec);
    manifold_delete_manifold_vec(vec);
    return ret_solid(core, out, result);
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
        ManifoldManifold *m = temen_handle_get(core, h);
        if (!m) THROW(temen_type_error(core, "__cad.hullPoints: not a shape handle"));
        cap += manifold_num_vert(m);
    }
    ManifoldVec3 *pts = malloc((cap ? cap : 1) * sizeof *pts);
    if (!pts) THROW(temen_range_error(core, "out of memory"));
    for (uint32_t i = 0; i < nh; i++) {
        ManifoldManifold *m = temen_handle_get(core, js_array_get(args[0], i));
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
    return ret_solid(core, out, result);
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
    return ret_solid(core, m, result);
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
    measure(core, args[0], m);
    size_t nprop = manifold_meshgl_num_prop(mesh), nv = manifold_meshgl_num_vert(mesh), nt = manifold_meshgl_num_tri(mesh);
    float *props = malloc((manifold_meshgl_vert_properties_length(mesh) + 1) * sizeof(float));
    uint32_t *tv = malloc((manifold_meshgl_tri_length(mesh) + 1) * sizeof(uint32_t));
    if (!props || !tv) { free(props); free(tv); manifold_delete_meshgl(mesh); THROW(temen_range_error(core, "out of memory")); }
    manifold_meshgl_vert_properties(props, mesh);
    manifold_meshgl_tri_verts(tv, mesh);
    manifold_delete_meshgl(mesh);
    /* each value is rooted before the next allocation: creating one is a safe point that could take the other */
    JsValue obj = js_object_new(ctx); js_gc_protect(core->vm, &obj);
    JsValue pos = js_array_new(ctx, (uint32_t)(nv * 3)); js_gc_protect(core->vm, &pos);
    JsValue tri = js_array_new(ctx, (uint32_t)(nt * 3)); js_gc_protect(core->vm, &tri);
    bool ok = !js_is_undefined(obj) && !js_is_undefined(pos) && !js_is_undefined(tri);
    for (size_t i = 0; i < nv && ok; i++) for (int k = 0; k < 3 && ok; k++) ok = js_array_push(core->vm, pos, js_number(props[i * nprop + k]));
    for (size_t i = 0; i < nt * 3 && ok; i++) ok = js_array_push(core->vm, tri, js_number(tv[i]));
    if (ok) ok = temen_object_set(core, obj, "positions", pos) && temen_object_set(core, obj, "triangles", tri);
    js_gc_unprotect(core->vm, &tri); js_gc_unprotect(core->vm, &pos); js_gc_unprotect(core->vm, &obj);
    free(props); free(tv);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = obj;
    return true;
}

static bool n_minkowski_sum(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldManifold *a = SHAPE(0), *b = SHAPE(1);
    return ret_handle(CORE(), manifold_minkowski_sum(mem(), a, b), result);
}
static bool n_minkowski_difference(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldManifold *a = SHAPE(0), *b = SHAPE(1);
    return ret_handle(CORE(), manifold_minkowski_difference(mem(), a, b), result);
}
/* trimByPlane(h, nx, ny, nz, offset): keeps the side the normal points to, of the plane n . p = offset */
static bool n_trim_by_plane(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldManifold *m = SHAPE(0);
    return ret_handle(CORE(), manifold_trim_by_plane(mem(), m, NUM(1), NUM(2), NUM(3), NUM(4)), result);
}

/* ---- a solid from raw triangles, oriented consistently (mesh.js manifoldFromTriangles) ---- */

/* Flip triangles so every shared edge is traversed in opposite directions (same walk as the JS). */
static void orient_consistently(uint32_t *tri, size_t n) {
    if (!n) return;
    /* edge -> list of faces, via a hash table of undirected edges */
    size_t cap = 1; while (cap < n * 6) cap <<= 1;
    uint64_t *keys = malloc(cap * sizeof *keys);
    int32_t *heads = malloc(cap * sizeof *heads);     /* first entry index per edge */
    int32_t *next = malloc(n * 3 * sizeof *next);     /* entry -> next entry on the same edge */
    int32_t *face = malloc(n * 3 * sizeof *face);     /* entry -> face */
    uint8_t *visited = calloc(n, 1);
    uint32_t *stack = malloc(n * sizeof *stack);
    if (!keys || !heads || !next || !face || !visited || !stack) goto done;
    for (size_t i = 0; i < cap; i++) heads[i] = -1;
    size_t entries = 0;
    for (size_t f = 0; f < n; f++) for (int k = 0; k < 3; k++) {
        uint32_t a = tri[f * 3 + k], b = tri[f * 3 + (k + 1) % 3];
        uint64_t key = a < b ? ((uint64_t)a << 32 | b) : ((uint64_t)b << 32 | a);
        size_t s = (size_t)((key * 0x9E3779B97F4A7C15ull) >> 20) & (cap - 1);
        while (heads[s] >= 0 && keys[s] != key) s = (s + 1) & (cap - 1);
        keys[s] = key;
        face[entries] = (int32_t)f; next[entries] = heads[s]; heads[s] = (int32_t)entries; entries++;
    }
    for (size_t seed = 0; seed < n; seed++) {
        if (visited[seed]) continue;
        visited[seed] = 1;
        size_t sp = 0; stack[sp++] = (uint32_t)seed;
        while (sp) {
            uint32_t i = stack[--sp];
            for (int k = 0; k < 3; k++) {
                uint32_t a = tri[i * 3 + k], b = tri[i * 3 + (k + 1) % 3];
                uint64_t key = a < b ? ((uint64_t)a << 32 | b) : ((uint64_t)b << 32 | a);
                size_t s = (size_t)((key * 0x9E3779B97F4A7C15ull) >> 20) & (cap - 1);
                while (heads[s] >= 0 && keys[s] != key) s = (s + 1) & (cap - 1);
                for (int32_t e = heads[s]; e >= 0; e = next[e]) {
                    uint32_t j = (uint32_t)face[e];
                    if (j == i || visited[j]) continue;
                    uint32_t *g = tri + j * 3;
                    bool directed = (g[0] == a && g[1] == b) || (g[1] == a && g[2] == b) || (g[2] == a && g[0] == b);
                    if (directed) { uint32_t t = g[1]; g[1] = g[2]; g[2] = t; }
                    visited[j] = 1; stack[sp++] = j;
                }
            }
        }
    }
done:
    free(keys); free(heads); free(next); free(face); free(visited); free(stack);
}

static ManifoldManifold *build_solid(const float *pos, size_t nv, const uint32_t *tri, size_t nt, ManifoldError *status) {
    ManifoldMeshGL *raw = manifold_meshgl(malloc(manifold_meshgl_size()), (float *)pos, nv, 3, (uint32_t *)tri, nt);
    ManifoldMeshGL *merged = manifold_meshgl_merge(malloc(manifold_meshgl_size()), raw);
    manifold_delete_meshgl(raw);
    ManifoldManifold *m = manifold_of_meshgl(mem(), merged);
    manifold_delete_meshgl(merged);
    *status = manifold_status(m);
    return m;
}

/* Oriented, built, and flipped when the volume comes out negative; throws "mesh status X" like meshFromTriangles. */
static bool solid_from_arrays(JsContext *ctx, float *pos, size_t nv, uint32_t *tri, size_t nt, JsValue *result) {
    TemenCore *core = CORE();
    orient_consistently(tri, nt);
    ManifoldError st;
    ManifoldManifold *m = build_solid(pos, nv, tri, nt, &st);
    if (st != MANIFOLD_NO_ERROR) {
        char msg[128];
        snprintf(msg, sizeof msg, "mesh status %s", (size_t)st < sizeof STATUS_NAMES / sizeof *STATUS_NAMES ? STATUS_NAMES[st] : "unknown");
        manifold_delete_manifold(m);
        THROW(temen_range_error(core, msg));
    }
    if (manifold_volume(m) < 0) {
        manifold_delete_manifold(m);
        for (size_t i = 0; i < nt; i++) { uint32_t t = tri[i * 3 + 1]; tri[i * 3 + 1] = tri[i * 3 + 2]; tri[i * 3 + 2] = t; }
        m = build_solid(pos, nv, tri, nt, &st);
    }
    return ret_handle(core, m, result);
}

/* Host entry (temencad.h): the part of a closed mesh with coordinate[axis] <= value, cut face filled. */
int temen_cut_mesh(TemenCore *core, const float *positions, size_t n_verts, const uint32_t *indices, size_t n_tris,
                   int axis, double value, TemenPart *out) {
    memset(out, 0, sizeof *out);
    if (axis < 0 || axis > 2 || !n_tris) return 1;
    float *pos = malloc(n_verts * 3 * sizeof *pos);
    uint32_t *tri = malloc(n_tris * 3 * sizeof *tri);
    if (!pos || !tri) { free(pos); free(tri); return 2; }
    memcpy(pos, positions, n_verts * 3 * sizeof *pos);
    memcpy(tri, indices, n_tris * 3 * sizeof *tri);
    orient_consistently(tri, n_tris);
    ManifoldError st;
    ManifoldManifold *m = build_solid(pos, n_verts, tri, n_tris, &st);
    free(pos); free(tri);
    if (st != MANIFOLD_NO_ERROR) { manifold_delete_manifold(m); return 2; }
    if (manifold_volume(m) < 0) { ManifoldManifold *f = manifold_scale(mem(), m, 1, 1, 1); manifold_delete_manifold(m); m = f; } /* sign is fixed below by the trim anyway */
    ManifoldBox *box = manifold_bounding_box(malloc(manifold_box_size()), m);
    ManifoldVec3 lo = manifold_box_min(box), hi = manifold_box_max(box);
    manifold_delete_box(box);
    double lo_k = axis == 0 ? lo.x : axis == 1 ? lo.y : lo.z, hi_k = axis == 0 ? hi.x : axis == 1 ? hi.y : hi.z;
    if (value <= lo_k) { manifold_delete_manifold(m); return 1; }
    ManifoldManifold *kept = m;
    if (value < hi_k) {
        kept = manifold_trim_by_plane(mem(), m, axis == 0 ? -1 : 0, axis == 1 ? -1 : 0, axis == 2 ? -1 : 0, -value);
        manifold_delete_manifold(m);
    }
    if (manifold_is_empty(kept)) { manifold_delete_manifold(kept); return 1; }
    ManifoldMeshGL *mesh = manifold_get_meshgl(malloc(manifold_meshgl_size()), kept);
    manifold_delete_manifold(kept);
    size_t nprop = manifold_meshgl_num_prop(mesh), nv = manifold_meshgl_num_vert(mesh), nt = manifold_meshgl_num_tri(mesh);
    float *props = malloc((manifold_meshgl_vert_properties_length(mesh) + 1) * sizeof(float));
    uint32_t *tv = malloc((manifold_meshgl_tri_length(mesh) + 1) * sizeof(uint32_t));
    float *xyz = malloc((nv * 3 + 1) * sizeof(float));
    if (!props || !tv || !xyz) { free(props); free(tv); free(xyz); manifold_delete_meshgl(mesh); return 2; }
    manifold_meshgl_vert_properties(props, mesh);
    manifold_meshgl_tri_verts(tv, mesh);
    manifold_delete_meshgl(mesh);
    for (size_t i = 0; i < nv; i++) for (int k = 0; k < 3; k++) xyz[i * 3 + k] = props[i * nprop + k];
    free(props);
    free(core->cut_positions); free(core->cut_indices);
    core->cut_positions = xyz; core->cut_indices = tv;
    out->positions = xyz; out->n_verts = nv; out->indices = tv; out->n_tris = nt;
    return 0;
}

/* solidFromTriangles(positions[], tris[]) */
static bool n_solid_from_triangles(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 2 || !js_is_array(args[0]) || !js_is_array(args[1])) THROW(temen_type_error(core, "__cad.solidFromTriangles: expected two arrays"));
    uint32_t np = js_array_length(args[0]), nt = js_array_length(args[1]);
    if (np % 3 || nt % 3) THROW(temen_type_error(core, "__cad.solidFromTriangles: lengths must be multiples of 3"));
    float *pos = malloc((np ? np : 1) * sizeof *pos);
    uint32_t *tri = malloc((nt ? nt : 1) * sizeof *tri);
    if (!pos || !tri) { free(pos); free(tri); THROW(temen_range_error(core, "out of memory")); }
    for (uint32_t i = 0; i < np; i++) { JsValue v = js_array_get(args[0], i); if (!js_is_number(v)) { free(pos); free(tri); THROW(temen_type_error(core, "__cad.solidFromTriangles: positions must be numbers")); } pos[i] = (float)js_get_number(v); }
    for (uint32_t i = 0; i < nt; i++) {
        JsValue v = js_array_get(args[1], i);
        double d = js_is_number(v) ? js_get_number(v) : -1;
        if (d < 0 || d >= np / 3 || d != floor(d)) { free(pos); free(tri); THROW(temen_range_error(core, "__cad.solidFromTriangles: triangle index out of range")); }
        tri[i] = (uint32_t)d;
    }
    bool ok = solid_from_arrays(ctx, pos, np / 3, tri, nt / 3, result);
    free(pos); free(tri);
    return ok;
}

/* heightmapSolid(gray[], nx, nz, x0, z0, width, depth, base, height): the relief plate of image.js heightmap() */
static bool n_heightmap_solid(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 9 || !js_is_array(args[0])) THROW(temen_type_error(core, "__cad.heightmapSolid: bad arguments"));
    size_t nx = (size_t)NUM(1), nz = (size_t)NUM(2);
    double x0 = NUM(3), z0 = NUM(4), width = NUM(5), depth = NUM(6), base = NUM(7), height = NUM(8);
    if (nx < 2 || nz < 2 || js_array_length(args[0]) < nx * nz) THROW(temen_range_error(core, "__cad.heightmapSolid: grid too small"));
    size_t nv = nx * nz * 2, nt = ((nx - 1) * (nz - 1) * 2 + (nx - 1) * 2 + (nz - 1) * 2) * 2;
    float *pos = malloc(nv * 3 * sizeof *pos);
    uint32_t *tri = malloc(nt * 3 * sizeof *tri);
    if (!pos || !tri) { free(pos); free(tri); THROW(temen_range_error(core, "out of memory")); }
    size_t p = 0;
    for (size_t j = 0; j < nz; j++) for (size_t i = 0; i < nx; i++) {
        JsValue gv = js_array_get(args[0], (uint32_t)(j * nx + i));
        double v = js_is_number(gv) ? js_get_number(gv) : 0;
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        pos[p++] = (float)(x0 + ((double)i / (double)(nx - 1)) * width);
        pos[p++] = (float)(base + v * height);
        pos[p++] = (float)(z0 + ((double)j / (double)(nz - 1)) * depth);
    }
    for (size_t j = 0; j < nz; j++) for (size_t i = 0; i < nx; i++) {
        pos[p++] = (float)(x0 + ((double)i / (double)(nx - 1)) * width);
        pos[p++] = 0.0f;
        pos[p++] = (float)(z0 + ((double)j / (double)(nz - 1)) * depth);
    }
#define TOP(i, j) ((uint32_t)((j) * nx + (i)))
#define BOT(i, j) ((uint32_t)(nx * nz + (j) * nx + (i)))
    size_t t = 0;
#define TRI(a, b, c) do { tri[t++] = (a); tri[t++] = (b); tri[t++] = (c); } while (0)
    for (size_t j = 0; j < nz - 1; j++) for (size_t i = 0; i < nx - 1; i++) {
        TRI(TOP(i, j), TOP(i, j + 1), TOP(i + 1, j + 1)); TRI(TOP(i, j), TOP(i + 1, j + 1), TOP(i + 1, j));
        TRI(BOT(i, j), BOT(i + 1, j + 1), BOT(i, j + 1)); TRI(BOT(i, j), BOT(i + 1, j), BOT(i + 1, j + 1));
    }
    for (size_t i = 0; i < nx - 1; i++) {
        TRI(TOP(i, 0), TOP(i + 1, 0), BOT(i + 1, 0)); TRI(TOP(i, 0), BOT(i + 1, 0), BOT(i, 0));
        TRI(TOP(i, nz - 1), BOT(i + 1, nz - 1), TOP(i + 1, nz - 1)); TRI(TOP(i, nz - 1), BOT(i, nz - 1), BOT(i + 1, nz - 1));
    }
    for (size_t j = 0; j < nz - 1; j++) {
        TRI(TOP(0, j), BOT(0, j + 1), TOP(0, j + 1)); TRI(TOP(0, j), BOT(0, j), BOT(0, j + 1));
        TRI(TOP(nx - 1, j), TOP(nx - 1, j + 1), BOT(nx - 1, j + 1)); TRI(TOP(nx - 1, j), BOT(nx - 1, j + 1), BOT(nx - 1, j));
    }
#undef TRI
#undef TOP
#undef BOT
    bool ok = solid_from_arrays(ctx, pos, nv, tri, t / 3, result);
    free(pos); free(tri);
    return ok;
}

/* ---- minWall(h, samples) -> { thickness, at }: print.js minWallThickness, the same arithmetic ---- */

typedef struct { double a[3], b[3], c[3], n[3], area, centroid[3]; } Tri;

static Tri *mesh_tris(ManifoldManifold *m, size_t *count) {
    ManifoldMeshGL *mesh = manifold_get_meshgl(malloc(manifold_meshgl_size()), m);
    size_t nprop = manifold_meshgl_num_prop(mesh), nt = manifold_meshgl_num_tri(mesh);
    float *props = malloc((manifold_meshgl_vert_properties_length(mesh) + 1) * sizeof(float));
    uint32_t *tv = malloc((manifold_meshgl_tri_length(mesh) + 1) * sizeof(uint32_t));
    Tri *out = malloc((nt + 1) * sizeof *out);
    *count = 0;
    if (props && tv && out) {
        manifold_meshgl_vert_properties(props, mesh);
        manifold_meshgl_tri_verts(tv, mesh);
        for (size_t t = 0; t < nt; t++) {
            Tri *o = &out[*count];
            for (int k = 0; k < 3; k++) { o->a[k] = props[tv[t * 3] * nprop + k]; o->b[k] = props[tv[t * 3 + 1] * nprop + k]; o->c[k] = props[tv[t * 3 + 2] * nprop + k]; }
            double e1[3] = { o->b[0] - o->a[0], o->b[1] - o->a[1], o->b[2] - o->a[2] }, e2[3] = { o->c[0] - o->a[0], o->c[1] - o->a[1], o->c[2] - o->a[2] };
            double cr[3] = { e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0] };
            double l = hypot(hypot(cr[0], cr[1]), cr[2]); /* Math.hypot(x, y, z) == hypot(hypot(x, y), z) in V8 and lamassu */
            if (l < 1e-12) continue;
            for (int k = 0; k < 3; k++) { o->n[k] = cr[k] / l; o->centroid[k] = (o->a[k] + o->b[k] + o->c[k]) / 3; }
            o->area = l / 2;
            (*count)++;
        }
    } else { free(out); out = NULL; }
    free(props); free(tv); manifold_delete_meshgl(mesh);
    return out;
}

static double ray_distance(const double *o, const double *d, const Tri *tris, size_t n, double skip) {
    double best = INFINITY;
    for (size_t i = 0; i < n; i++) {
        const Tri *t = &tris[i];
        double e1[3] = { t->b[0] - t->a[0], t->b[1] - t->a[1], t->b[2] - t->a[2] }, e2[3] = { t->c[0] - t->a[0], t->c[1] - t->a[1], t->c[2] - t->a[2] };
        double p[3] = { d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0] };
        double det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
        if (fabs(det) < 1e-12) continue;
        double inv = 1 / det, s[3] = { o[0] - t->a[0], o[1] - t->a[1], o[2] - t->a[2] };
        double u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv; if (u < -1e-9 || u > 1 + 1e-9) continue;
        double q[3] = { s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0] };
        double v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv; if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        double dist = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
        if (dist > skip && dist < best) best = dist;
    }
    return best;
}

static bool n_min_wall(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    ManifoldManifold *m = SHAPE(0);
    double samples = NUM(1);
    size_t n;
    Tri *all = mesh_tris(m, &n);
    if (!all) THROW(temen_range_error(core, "out of memory"));
    double total = 0;
    for (size_t i = 0; i < n; i++) total += all[i].area;
    double min_area = fmin(0.02, total / 1e5);
    size_t nf = 0;
    const Tri **faces = malloc((n + 1) * sizeof *faces);
    const Tri **picked = malloc((n + (size_t)samples + 2) * sizeof *picked);
    if (!faces || !picked) { free(all); free(faces); free(picked); THROW(temen_range_error(core, "out of memory")); }
    for (size_t i = 0; i < n; i++) if (all[i].area >= min_area) faces[nf++] = &all[i];
    size_t np = 0;
    if ((double)nf <= samples) { for (size_t i = 0; i < nf; i++) picked[np++] = faces[i]; }
    else {
        double per = samples / total, acc = 0;
        for (size_t i = 0; i < nf; i++) { acc += faces[i]->area * per; while (acc >= 1 && (double)np < samples) { acc -= 1; picked[np++] = faces[i]; } }
        size_t step = (size_t)ceil((double)nf / samples);
        for (size_t i = 0; (double)np < samples && i < nf; i += step) picked[np++] = faces[i];
    }
    double best = INFINITY; const double *at = NULL;
    for (size_t i = 0; i < np; i++) {
        const Tri *t = picked[i];
        double d[3] = { -t->n[0], -t->n[1], -t->n[2] };
        double dist = ray_distance(t->centroid, d, all, n, 0.05);
        if (dist < best) { best = dist; at = t->centroid; }
    }
    JsValue obj = js_object_new(ctx);
    bool ok = !js_is_undefined(obj);
    js_gc_protect(core->vm, &obj);
    if (ok) ok = temen_object_set(core, obj, "thickness", js_number(best));
    if (ok) {
        if (at) {
            JsValue arr = js_array_new(ctx, 3);
            ok = !js_is_undefined(arr);
            js_gc_protect(core->vm, &arr);
            for (int k = 0; k < 3 && ok; k++) ok = js_array_push(core->vm, arr, js_number(at[k]));
            if (ok) ok = temen_object_set(core, obj, "at", arr);
            js_gc_unprotect(core->vm, &arr);
        } else ok = temen_object_set(core, obj, "at", js_null());
    }
    js_gc_unprotect(core->vm, &obj);
    free(all); free(faces); free(picked);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = obj;
    return true;
}

/* ---- images: imageResize(gray, w, h, nw, nh) and imageBlur(gray, w, h, radius), float32 storage like the app ---- */

static float *read_gray(JsContext *ctx, JsValue arr, size_t n, JsValue *result) {
    TemenCore *core = CORE();
    if (!js_is_array(arr) || js_array_length(arr) < n) { *result = temen_type_error(core, "__cad: image data too short"); return NULL; }
    float *g = malloc((n ? n : 1) * sizeof *g);
    if (!g) { *result = temen_range_error(core, "out of memory"); return NULL; }
    for (size_t i = 0; i < n; i++) { JsValue v = js_array_get(arr, (uint32_t)i); g[i] = (float)(js_is_number(v) ? js_get_number(v) : 0); }
    return g;
}
static bool gray_to_js(JsContext *ctx, const float *g, size_t n, JsValue *result) {
    TemenCore *core = CORE();
    JsValue arr = js_array_new(ctx, (uint32_t)n);
    if (js_is_undefined(arr)) THROW(temen_range_error(core, "out of memory"));
    js_gc_protect(core->vm, &arr);
    bool ok = true;
    for (size_t i = 0; i < n && ok; i++) ok = js_array_push(core->vm, arr, js_number(g[i]));
    js_gc_unprotect(core->vm, &arr);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = arr;
    return true;
}
static double gray_at(const float *g, long w, long h, long x, long y) {
    x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
    return g[y * w + x];
}
static bool n_image_resize(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    long w = (long)NUM(1), h = (long)NUM(2), nw = (long)NUM(3), nh = (long)NUM(4);
    if (w < 1 || h < 1 || nw < 1 || nh < 1) THROW(temen_range_error(CORE(), "__cad.imageResize: bad size"));
    float *g = read_gray(ctx, argc > 0 ? args[0] : js_undefined(), (size_t)(w * h), result);
    if (!g) return false;
    float *out = malloc((size_t)(nw * nh) * sizeof *out);
    if (!out) { free(g); THROW(temen_range_error(CORE(), "out of memory")); }
    double sx = (double)w / nw, sy = (double)h / nh;
    for (long y = 0; y < nh; y++) for (long x = 0; x < nw; x++) {
        double px = (x + 0.5) * sx - 0.5, py = (y + 0.5) * sy - 0.5;
        double x0 = floor(px), y0 = floor(py), fx = px - x0, fy = py - y0;
        double a = gray_at(g, w, h, (long)x0, (long)y0), b = gray_at(g, w, h, (long)x0 + 1, (long)y0), c = gray_at(g, w, h, (long)x0, (long)y0 + 1), d = gray_at(g, w, h, (long)x0 + 1, (long)y0 + 1);
        out[y * nw + x] = (float)((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy);
    }
    bool ok = gray_to_js(ctx, out, (size_t)(nw * nh), result);
    free(g); free(out);
    return ok;
}
static bool n_image_blur(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    long w = (long)NUM(1), h = (long)NUM(2), radius = (long)NUM(3);
    if (w < 1 || h < 1 || radius < 1) THROW(temen_range_error(CORE(), "__cad.imageBlur: bad size"));
    size_t n = (size_t)(w * h);
    float *src = read_gray(ctx, argc > 0 ? args[0] : js_undefined(), n, result);
    if (!src) return false;
    float *tmp = malloc(n * sizeof *tmp), *out = malloc(n * sizeof *out);
    if (!tmp || !out) { free(src); free(tmp); free(out); THROW(temen_range_error(CORE(), "out of memory")); }
    double nn = 2 * radius + 1;
    for (int pass = 0; pass < 2; pass++) {
        const float *in = pass == 0 ? src : out;
        for (long y = 0; y < h; y++) {
            double acc = 0;
            for (long k = -radius; k <= radius; k++) acc += in[y * w + (k < 0 ? 0 : k > w - 1 ? w - 1 : k)];
            for (long x = 0; x < w; x++) {
                tmp[y * w + x] = (float)(acc / nn);
                long xr = x + radius + 1; if (xr > w - 1) xr = w - 1;
                long xl = x - radius; if (xl < 0) xl = 0;
                acc += in[y * w + xr] - in[y * w + xl];
            }
        }
        float *dst = pass == 0 ? out : src; /* second pass writes back into src's buffer */
        for (long x = 0; x < w; x++) {
            double acc = 0;
            for (long k = -radius; k <= radius; k++) acc += tmp[(k < 0 ? 0 : k > h - 1 ? h - 1 : k) * w + x];
            for (long y = 0; y < h; y++) {
                dst[y * w + x] = (float)(acc / nn);
                long yd = y + radius + 1; if (yd > h - 1) yd = h - 1;
                long yu = y - radius; if (yu < 0) yu = 0;
                acc += tmp[yd * w + x] - tmp[yu * w + x];
            }
        }
    }
    bool ok = gray_to_js(ctx, src, n, result);
    free(src); free(tmp); free(out);
    return ok;
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
    (void)this_val; ManifoldManifold *m = SHAPE(0); *result = js_number(manifold_volume(m)); measure(CORE(), args[0], m); return true;
}
static bool n_area(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldManifold *m = SHAPE(0); *result = js_number(manifold_surface_area(m)); measure(CORE(), args[0], m); return true;
}
static bool n_is_empty(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; *result = js_bool(manifold_is_empty(SHAPE(0)) != 0); return true;
}
static bool n_num_tri(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; ManifoldManifold *m = SHAPE(0); *result = js_number((double)manifold_num_tri(m)); measure(CORE(), args[0], m); return true;
}

/* bounds(h) -> [minx, miny, minz, maxx, maxy, maxz] */
static bool n_bounds(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    ManifoldManifold *m = SHAPE(0);
    ManifoldBox *box = manifold_bounding_box(malloc(manifold_box_size()), m);
    measure(core, args[0], m);
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
    /* root the string before the push: growing the array is a safe point and would let the collector take it */
    JsValue name = temen_string(core, file, strlen(file));
    js_gc_protect(core->vm, &name);
    bool ok = js_is_string(name) && js_array_push(core->vm, arr, name) && js_array_push(core->vm, arr, js_number(line));
    js_gc_unprotect(core->vm, &name);
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
    { "minGap", n_min_gap }, { "annotate", n_annotate },
    { "solidFromTriangles", n_solid_from_triangles }, { "heightmapSolid", n_heightmap_solid }, { "minWall", n_min_wall },
    { "imageResize", n_image_resize }, { "imageBlur", n_image_blur },
    { "minkowskiSum", n_minkowski_sum }, { "minkowskiDifference", n_minkowski_difference }, { "trimByPlane", n_trim_by_plane }, { "meshFromTriangles", n_mesh_from_triangles }, { "triangulate", n_triangulate }, { "mesh", n_mesh },
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
        if (!temen_object_set(core, core->cad_ns, ENTRIES[i].name, fn)) return false;
    }
    if (!temen_install_text(core, core->cad_ns)) return false;
    if (!temen_install_assets(core, core->cad_ns)) return false;
    core->slot_a = js_undefined();
    return temen_object_set(core, js_context_globals(core->ctx), "__cad", core->cad_ns);
}
