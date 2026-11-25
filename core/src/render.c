/*
 * The render sheet: a small z-buffer rasteriser over built parts, with labels (view titles with the
 * size, part names, a scale bar, an axis triad), section cuts and the script's dimensions and marks,
 * written out as PNG. A port of the web app's src/render.js, operation for operation (float32 colour and
 * depth buffers as its Float32Arrays, V8's Math.hypot / Math.round / toFixed, lamassu's fdlibm sin and
 * cos, text outlines from the same core call), so the pixels come out the same: core/test/render-parity.mjs
 * decodes both PNGs and compares them. Keep the two in step.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "temencad.h"
#include "miniz/miniz.h"

double js_k_sin(double x);
double js_k_cos(double x);

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ---- numbers as JS computes them ---- */
static double js_round(double x) { double r = floor(x); if (x - r >= 0.5) r += 1; return r; }
static double vhypot(const double *v, int n) { /* V8's Math.hypot: scaled, Kahan-summed */
    double max = 0;
    for (int i = 0; i < n; i++) { double a = fabs(v[i]); if (isinf(a)) return INFINITY; if (a > max) max = a; }
    if (max == 0) return 0;
    double sum = 0, comp = 0;
    for (int i = 0; i < n; i++) {
        double x = fabs(v[i]) / max, summand = x * x - comp, pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    return sqrt(sum) * max;
}
static double hypot2(double a, double b) { double v[2] = { a, b }; return vhypot(v, 2); }
static void norm3(double *v) { double l = vhypot(v, 3); if (l == 0 || isnan(l)) l = 1; v[0] /= l; v[1] /= l; v[2] /= l; }
static void cross3(const double *a, const double *b, double *o) { o[0] = a[1] * b[2] - a[2] * b[1]; o[1] = a[2] * b[0] - a[0] * b[2]; o[2] = a[0] * b[1] - a[1] * b[0]; }
static double dot3(const double *a, const double *b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
static double jmin(double a, double b) { return a < b ? a : b; }
static double jmax(double a, double b) { return a > b ? a : b; }

/* fmt in render.js: a whole number when within 0.005 of one, else toFixed(1) (ties away from zero) */
static void fmt_num(char *out, size_t cap, double v) {
    double r = js_round(v);
    if (fabs(v - r) < 0.005) { snprintf(out, cap, "%.0f", r == 0 ? 0.0 : r); return; }
    double s = v * 4; /* a double is halfway at one decimal exactly when v * 4 is an odd integer */
    if (s == floor(s) && fabs(fmod(s, 2)) == 1) v = nextafter(v, v > 0 ? INFINITY : -INFINITY);
    snprintf(out, cap, "%.1f", v);
    if (strcmp(out, "-0.0") == 0) snprintf(out, cap, "0.0");
}

/* ---- a little JSON reader (text outlines, annotations) ---- */
typedef enum { J_NULL, J_NUM, J_STR, J_ARR, J_OBJ, J_BOOL } JType;
typedef struct JVal { JType t; double num; char *str; struct JVal *items; char **keys; size_t n; } JVal;
static const char *jws(const char *s) { while (*s == ' ' || *s == '\n' || *s == '\r' || *s == '\t') s++; return s; }
static const char *jparse(const char *s, JVal *v);
static const char *jstring(const char *s, char **out) {
    s++; /* opening quote */
    size_t cap = 16, n = 0;
    char *b = malloc(cap);
    while (*s && *s != '"') {
        char c = *s++;
        if (c == '\\' && *s) {
            char e = *s++;
            if (e == 'n') c = '\n'; else if (e == 't') c = '\t'; else if (e == 'u') {
                unsigned u = 0; for (int i = 0; i < 4 && *s; i++, s++) { u <<= 4; u |= (unsigned)(*s <= '9' ? *s - '0' : (*s | 32) - 'a' + 10); }
                char tmp[4]; size_t k = 0;
                if (u < 0x80) tmp[k++] = (char)u; else if (u < 0x800) { tmp[k++] = (char)(0xc0 | (u >> 6)); tmp[k++] = (char)(0x80 | (u & 63)); }
                else { tmp[k++] = (char)(0xe0 | (u >> 12)); tmp[k++] = (char)(0x80 | ((u >> 6) & 63)); tmp[k++] = (char)(0x80 | (u & 63)); }
                for (size_t i = 0; i < k; i++) { if (n + 2 > cap) b = realloc(b, cap *= 2); b[n++] = tmp[i]; }
                continue;
            } else c = e;
        }
        if (n + 2 > cap) b = realloc(b, cap *= 2);
        b[n++] = c;
    }
    b[n] = 0;
    *out = b;
    return *s ? s + 1 : s;
}
static const char *jparse(const char *s, JVal *v) {
    memset(v, 0, sizeof *v);
    s = jws(s);
    if (*s == '{' || *s == '[') {
        int obj = *s == '{';
        v->t = obj ? J_OBJ : J_ARR;
        s = jws(s + 1);
        size_t cap = 0;
        while (*s && *s != (obj ? '}' : ']')) {
            if (v->n == cap) { cap = cap ? cap * 2 : 4; v->items = realloc(v->items, cap * sizeof *v->items); if (obj) v->keys = realloc(v->keys, cap * sizeof *v->keys); }
            if (obj) { s = jstring(jws(s), &v->keys[v->n]); s = jws(s); if (*s == ':') s++; }
            s = jparse(s, &v->items[v->n]);
            v->n++;
            s = jws(s);
            if (*s == ',') s = jws(s + 1);
        }
        return *s ? s + 1 : s;
    }
    if (*s == '"') { v->t = J_STR; return jstring(s, &v->str); }
    if (!strncmp(s, "true", 4)) { v->t = J_BOOL; v->num = 1; return s + 4; }
    if (!strncmp(s, "false", 5)) { v->t = J_BOOL; return s + 5; }
    if (!strncmp(s, "null", 4)) { v->t = J_NULL; return s + 4; }
    char *end;
    v->t = J_NUM; v->num = strtod(s, &end);
    return end > s ? end : s + 1;
}
static void jfree(JVal *v) {
    for (size_t i = 0; i < v->n; i++) { jfree(&v->items[i]); if (v->keys) free(v->keys[i]); }
    free(v->items); free(v->keys); free(v->str);
}
static const JVal *jget(const JVal *o, const char *key) {
    if (o->t != J_OBJ) return NULL;
    for (size_t i = 0; i < o->n; i++) if (!strcmp(o->keys[i], key)) return &o->items[i];
    return NULL;
}

/* ---- the canvas ---- */
static const double BG[3] = { 247, 246, 242 }, GRID[3] = { 214, 211, 203 }, INK[3] = { 60, 60, 60 }, CUT[3] = { 224, 96, 74 };
static const double NOTE[3] = { 36, 72, 140 }, GREY[3] = { 110, 110, 110 };
static const double AXC[3][3] = { { 220, 70, 60 }, { 60, 170, 90 }, { 50, 110, 220 } };

typedef struct { int W, H; float *rgb, *depth; TemenCore *core; } Canvas;

static void blend(Canvas *cv, double xd, double yd, const double *col, double alpha) {
    if (isnan(xd) || isnan(yd)) return; /* JS indexes the Float32Array with NaN: a no-op */
    if (xd < 0 || yd < 0 || xd >= cv->W || yd >= cv->H) return;
    long x = (long)xd, y = (long)yd;
    size_t i = ((size_t)y * cv->W + (size_t)x) * 3;
    for (int c = 0; c < 3; c++) cv->rgb[i + c] = (float)((double)cv->rgb[i + c] * (1 - alpha) + col[c] * alpha);
}
static void line2d(Canvas *cv, double x0, double y0, double x1, double y1, const double *col, double alpha, double thick) {
    double n = ceil(hypot2(x1 - x0, y1 - y0));
    for (double k = 0; k <= n; k++) {
        double x = x0 + (x1 - x0) * (k / n), y = y0 + (y1 - y0) * (k / n);
        for (double dy = 0; dy < thick; dy++) for (double dx = 0; dx < thick; dx++)
            blend(cv, js_round(x + dx - (thick - 1) / 2), js_round(y + dy - (thick - 1) / 2), col, alpha);
    }
}
typedef struct { double *xy; size_t n; } Ring; /* n points, xy[2n] */
static int cmpd(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y; }
static void fill_rings(Canvas *cv, const Ring *rings, size_t nr, const double *col, double alpha) {
    double y0 = INFINITY, y1 = -INFINITY;
    size_t total = 0;
    for (size_t r = 0; r < nr; r++) { total += rings[r].n; for (size_t i = 0; i < rings[r].n; i++) { double y = rings[r].xy[2 * i + 1]; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    double *xs = malloc((total + 1) * sizeof *xs);
    for (double y = jmax(0, floor(y0)); y <= jmin(cv->H - 1, ceil(y1)); y++) {
        double sy = y + 0.5;
        size_t nx = 0;
        for (size_t r = 0; r < nr; r++) for (size_t i = 0; i < rings[r].n; i++) {
            const double *a = &rings[r].xy[2 * i], *b = &rings[r].xy[2 * ((i + 1) % rings[r].n)];
            if ((a[1] <= sy) != (b[1] <= sy)) xs[nx++] = a[0] + ((sy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        }
        qsort(xs, nx, sizeof *xs, cmpd);
        for (size_t k = 0; k + 1 < nx; k += 2)
            for (double x = jmax(0, js_round(xs[k])); x < jmin(cv->W, js_round(xs[k + 1])); x++) blend(cv, x, y, col, alpha);
    }
    free(xs);
}
static void fill_rect(Canvas *cv, double x0, double y0, double x1, double y1, const double *col, double alpha) {
    double xy[8] = { x0, y0, x1, y0, x1, y1, x0, y1 };
    Ring r = { xy, 4 };
    fill_rings(cv, &r, 1, col, alpha);
}
/* outlines from the core, as the web asks for them */
static int outlines(Canvas *cv, const char *str, double size, const char *font, int align, int curve, JVal *out) {
    const char *json = temen_text_outlines(cv->core, str, font, size, align, 0, 1, curve);
    if (!json) return 0;
    jparse(json, out);
    return 1;
}
/* text with its baseline starting at (x, y); returns the width */
static double text(Canvas *cv, const char *str, double x, double y, double size, const double *col, const char *weight) {
    JVal o;
    if (!outlines(cv, str, size, weight, 0, 4, &o)) return 0;
    const JVal *rings = jget(&o, "rings"), *w = jget(&o, "width");
    if (rings && rings->t == J_ARR) {
        Ring *rs = calloc(rings->n + 1, sizeof *rs);
        for (size_t r = 0; r < rings->n; r++) {
            const JVal *ring = &rings->items[r];
            rs[r].n = ring->n;
            rs[r].xy = malloc((ring->n + 1) * 2 * sizeof(double));
            for (size_t i = 0; i < ring->n; i++) { rs[r].xy[2 * i] = x + ring->items[i].items[0].num; rs[r].xy[2 * i + 1] = y - ring->items[i].items[1].num; }
        }
        fill_rings(cv, rs, rings->n, col, 1);
        for (size_t r = 0; r < rings->n; r++) free(rs[r].xy);
        free(rs);
    }
    double width = w ? w->num : 0;
    jfree(&o);
    return width;
}
static double text_width(Canvas *cv, const char *str, double size, const char *weight) {
    JVal o;
    if (!outlines(cv, str, size, weight, 0, 8, &o)) return 0;
    const JVal *w = jget(&o, "width");
    double width = w ? w->num : 0;
    jfree(&o);
    return width;
}

/* ---- views ---- */
typedef struct { const char *name; double eye[3], up[3]; int grid; const char *title; } View; /* grid: 0 none, 1 plane, 2 line */
static const View VIEWS[] = {
    { "iso", { 0 }, { 0, 1, 0 }, 1, "isometric" },
    { "top", { 0, 1, 0 }, { 0, 0, -1 }, 1, "top (X across, Z down)" },
    { "bottom", { 0, -1, 0 }, { 0, 0, 1 }, 0, "bottom (X across, Z up)" },
    { "front", { 0, 0, 1 }, { 0, 1, 0 }, 2, "front (X across, Y up)" },
    { "back", { 0, 0, -1 }, { 0, 1, 0 }, 2, "back" },
    { "right", { 1, 0, 0 }, { 0, 1, 0 }, 2, "right (Z across, Y up)" },
    { "left", { -1, 0, 0 }, { 0, 1, 0 }, 2, "left" },
};

typedef struct { const TemenPart *p; double rgb[3]; } Mesh;

static void mesh_bounds(Mesh *const *ms, size_t n, double *mn, double *mx) {
    for (int k = 0; k < 3; k++) { mn[k] = INFINITY; mx[k] = -INFINITY; }
    for (size_t m = 0; m < n; m++) {
        const float *P = ms[m]->p->positions;
        for (size_t i = 0; i < ms[m]->p->n_verts * 3; i += 3) for (int k = 0; k < 3; k++) { double v = P[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    }
    if (!isfinite(mn[0])) { mn[0] = -10; mn[1] = 0; mn[2] = -10; mx[0] = 10; mx[1] = 10; mx[2] = 10; }
}

typedef struct { double right[3], up[3], eye[3]; double rx, ry, rw, rh, scale, cx, cy; } Frame;
static void project(const Frame *f, double x, double y, double z, double *o) {
    o[0] = x * f->right[0] + y * f->right[1] + z * f->right[2];
    o[1] = x * f->up[0] + y * f->up[1] + z * f->up[2];
    o[2] = x * f->eye[0] + y * f->eye[1] + z * f->eye[2];
}
static void to_screen(const Frame *f, const double *v, double *sx, double *sy) {
    *sx = f->rx + (v[0] - f->cx) * f->scale + f->rw / 2;
    *sy = f->ry + f->rh / 2 - (v[1] - f->cy) * f->scale;
}
static void line3(Canvas *cv, const Frame *f, const double *a, const double *b, const double *col, double alpha, double thick) {
    double pa[3], pb[3], x0, y0, x1, y1;
    project(f, a[0], a[1], a[2], pa); project(f, b[0], b[1], b[2], pb);
    to_screen(f, pa, &x0, &y0); to_screen(f, pb, &x1, &y1);
    line2d(cv, x0, y0, x1, y1, col, alpha, thick);
}

static void raster(Canvas *cv, const Frame *f, const Mesh *m, double alpha, int write_depth, const double *key, const double *fill, int section_axis, double section_value) {
    const float *P = m->p->positions;
    const uint32_t *I = m->p->indices;
    size_t n = m->p->n_tris;
    for (size_t t = 0; t < n; t++) {
        size_t ia = (size_t)I[t * 3] * 3, ib = (size_t)I[t * 3 + 1] * 3, ic = (size_t)I[t * 3 + 2] * 3;
        double a[3] = { P[ia], P[ia + 1], P[ia + 2] }, b[3] = { P[ib], P[ib + 1], P[ib + 2] }, c[3] = { P[ic], P[ic + 1], P[ic + 2] };
        double e1[3] = { b[0] - a[0], b[1] - a[1], b[2] - a[2] }, e2[3] = { c[0] - a[0], c[1] - a[1], c[2] - a[2] }, nrm[3];
        cross3(e1, e2, nrm); norm3(nrm);
        if (dot3(nrm, f->eye) < 0) { nrm[0] = -nrm[0]; nrm[1] = -nrm[1]; nrm[2] = -nrm[2]; }
        double light = jmin(1, 0.42 + 0.5 * jmax(0, dot3(nrm, key)) + 0.18 * jmax(0, dot3(nrm, fill)));
        double col[3] = { m->rgb[0] * light, m->rgb[1] * light, m->rgb[2] * light };
        if (section_axis >= 0) {
            int k = section_axis;
            if (fabs(a[k] - section_value) < 1e-4 && fabs(b[k] - section_value) < 1e-4 && fabs(c[k] - section_value) < 1e-4) memcpy(col, CUT, sizeof col);
        }
        double pa[3], pb[3], pc[3], ax, ay, bx, by, cxs, cys;
        project(f, a[0], a[1], a[2], pa); project(f, b[0], b[1], b[2], pb); project(f, c[0], c[1], c[2], pc);
        to_screen(f, pa, &ax, &ay); to_screen(f, pb, &bx, &by); to_screen(f, pc, &cxs, &cys);
        double x0 = jmax(f->rx, floor(jmin(jmin(ax, bx), cxs))), x1 = jmin(f->rx + f->rw - 1, ceil(jmax(jmax(ax, bx), cxs)));
        double y0 = jmax(f->ry, floor(jmin(jmin(ay, by), cys))), y1 = jmin(f->ry + f->rh - 1, ceil(jmax(jmax(ay, by), cys)));
        double area = (bx - ax) * (cys - ay) - (cxs - ax) * (by - ay);
        if (fabs(area) < 1e-9) continue;
        for (double y = y0; y <= y1; y++) for (double x = x0; x <= x1; x++) {
            double px = x + 0.5, py = y + 0.5;
            double w0 = ((bx - px) * (cys - py) - (cxs - px) * (by - py)) / area;
            double w1 = ((cxs - px) * (ay - py) - (ax - px) * (cys - py)) / area;
            double w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            double d = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
            size_t i = (size_t)y * cv->W + (size_t)x;
            if (d <= (double)cv->depth[i]) continue;
            if (write_depth) { cv->depth[i] = (float)d; cv->rgb[i * 3] = (float)col[0]; cv->rgb[i * 3 + 1] = (float)col[1]; cv->rgb[i * 3 + 2] = (float)col[2]; }
            else blend(cv, x, y, col, alpha);
        }
    }
}

static void annotation_label(Canvas *cv, const char *s, double x, double y, double S) {
    double small = 11 * S, w = text_width(cv, s, small, "Inter Bold");
    fill_rect(cv, x - 3 * S, y - small, x + w + 3 * S, y + 3 * S, BG, 0.85);
    text(cv, s, x, y, small, NOTE, "Inter Bold");
}
static int jpoint(const JVal *v, double *o) {
    if (!v || v->t != J_ARR || v->n < 3) return 0;
    for (int k = 0; k < 3; k++) o[k] = v->items[k].num;
    return 1;
}
static const char *jtext(const JVal *v) { return v && v->t == J_STR ? v->str : v && v->t == J_NULL ? "null" : "undefined"; }
static void draw_annotations(Canvas *cv, const Frame *f, const char *const *ann, size_t n_ann, double S) {
    double small = 11 * S;
    for (size_t i = 0; i < n_ann; i++) {
        JVal a;
        jparse(ann[i], &a);
        const JVal *type = jget(&a, "type");
        double p0[3], p1[3];
        if (type && type->t == J_STR && !strcmp(type->str, "dimension") && jpoint(jget(&a, "a"), p0) && jpoint(jget(&a, "b"), p1)) {
            double q0[3], q1[3], x0, y0, x1, y1;
            project(f, p0[0], p0[1], p0[2], q0); project(f, p1[0], p1[1], p1[2], q1);
            to_screen(f, q0, &x0, &y0); to_screen(f, q1, &x1, &y1);
            double dx = x1 - x0, dy = y1 - y0, l = hypot2(dx, dy);
            const char *label = jtext(jget(&a, "label"));
            if (l < 1) { line2d(cv, x0 - 3 * S, y0, x0 + 3 * S, y0, NOTE, 1, 2 * S); annotation_label(cv, label, x0 + 6 * S, y0 + 4 * S, S); jfree(&a); continue; }
            double nx = -dy / l, ny = dx / l, t = 5 * S;
            line2d(cv, x0, y0, x1, y1, NOTE, 1, 1.5 * S);
            line2d(cv, x0 + nx * t, y0 + ny * t, x0 - nx * t, y0 - ny * t, NOTE, 1, 1.5 * S);
            line2d(cv, x1 + nx * t, y1 + ny * t, x1 - nx * t, y1 - ny * t, NOTE, 1, 1.5 * S);
            double w = text_width(cv, label, small, "Inter Bold");
            annotation_label(cv, label, (x0 + x1) / 2 - w / 2 + nx * 10 * S, (y0 + y1) / 2 + 4 * S + ny * 10 * S, S);
        } else if (type && type->t == J_STR && !strcmp(type->str, "mark") && jpoint(jget(&a, "p"), p0)) {
            double q[3], x, y;
            project(f, p0[0], p0[1], p0[2], q); to_screen(f, q, &x, &y);
            for (int k = 0; k < 8; k++) {
                double t0 = ((double)k / 8) * 2 * M_PI, t1 = ((double)(k + 1) / 8) * 2 * M_PI;
                line2d(cv, x + 3 * S * js_k_cos(t0), y + 3 * S * js_k_sin(t0), x + 3 * S * js_k_cos(t1), y + 3 * S * js_k_sin(t1), NOTE, 1, 2 * S);
            }
            const JVal *tx = jget(&a, "text");
            if (tx && !(tx->t == J_STR && tx->str[0] == 0)) annotation_label(cv, jtext(tx), x + 7 * S, y + 4 * S, S);
        }
        jfree(&a);
    }
}

static void draw_view(Canvas *cv, double rx, double ry, double rw, double rh, Mesh *meshes, size_t n_meshes, const View *view,
                      int labels, int section_axis, double section_value, int ghosts, double S, const char *const *ann, size_t n_ann) {
    Frame f;
    memcpy(f.eye, view->eye, sizeof f.eye);
    if (!strcmp(view->name, "iso")) { f.eye[0] = 8; f.eye[1] = 7; f.eye[2] = 10; norm3(f.eye); }
    cross3(view->up, f.eye, f.right); norm3(f.right);
    cross3(f.eye, f.right, f.up);
    Mesh **solid = malloc((n_meshes + 1) * sizeof *solid), **ghost = malloc((n_meshes + 1) * sizeof *ghost), **framed = malloc((n_meshes + 1) * sizeof *framed);
    size_t ns = 0, ng = 0, nf = 0;
    for (size_t i = 0; i < n_meshes; i++) if (!meshes[i].p->hidden && !meshes[i].p->ghost) solid[ns++] = &meshes[i];
    if (ghosts) for (size_t i = 0; i < n_meshes; i++) if (!meshes[i].p->hidden && meshes[i].p->ghost) ghost[ng++] = &meshes[i];
    for (size_t i = 0; i < ns; i++) framed[nf++] = solid[i];
    for (size_t i = 0; i < ng; i++) framed[nf++] = ghost[i];
    double bmin[3], bmax[3], fmin_[3], fmax_[3];
    if (ns) mesh_bounds(solid, ns, bmin, bmax); else mesh_bounds(framed, nf, bmin, bmax);
    if (nf) mesh_bounds(framed, nf, fmin_, fmax_); else mesh_bounds(solid, ns, fmin_, fmax_);

    double minX = INFINITY, minY = INFINITY, maxX = -INFINITY, maxY = -INFINITY;
#define TAKE(X, Y, Z) do { double v_[3]; project(&f, (X), (Y), (Z), v_); if (v_[0] < minX) minX = v_[0]; if (v_[0] > maxX) maxX = v_[0]; if (v_[1] < minY) minY = v_[1]; if (v_[1] > maxY) maxY = v_[1]; } while (0)
    double xs2[2] = { fmin_[0], fmax_[0] }, ys2[2] = { fmin_[1], fmax_[1] }, zs2[2] = { fmin_[2], fmax_[2] };
    for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) for (int k = 0; k < 2; k++) TAKE(xs2[i], ys2[j], zs2[k]);
    double pad = jmax(fmax_[0] - fmin_[0], fmax_[2] - fmin_[2]) * 0.2 + 4;
    double gx0 = fmin_[0] - pad, gx1 = fmax_[0] + pad, gz0 = fmin_[2] - pad, gz1 = fmax_[2] + pad;
    if (view->grid == 1) { TAKE(gx0, 0, gz0); TAKE(gx1, 0, gz0); TAKE(gx0, 0, gz1); TAKE(gx1, 0, gz1); }
#undef TAKE
    f.rx = rx; f.ry = ry; f.rw = rw; f.rh = rh;
    double margin = labels ? 0.8 : 0.92;
    double sx = maxX - minX, sy = maxY - minY;
    f.scale = jmin(rw / (sx ? sx : 1), rh / (sy ? sy : 1)) * margin;
    f.cx = (minX + maxX) / 2; f.cy = (minY + maxY) / 2;

    double step = 10;
    if (view->grid == 1) {
        double fx0 = floor(gx0 / step) * step, fx1 = ceil(gx1 / step) * step, fz0 = floor(gz0 / step) * step, fz1 = ceil(gz1 / step) * step;
        for (double x = fx0; x <= fx1; x += step) { double a[3] = { x, 0, fz0 }, b[3] = { x, 0, fz1 }; line3(cv, &f, a, b, GRID, fmod(x, 50) == 0 ? 0.9 : 0.5, 1); }
        for (double z = fz0; z <= fz1; z += step) { double a[3] = { fx0, 0, z }, b[3] = { fx1, 0, z }; line3(cv, &f, a, b, GRID, fmod(z, 50) == 0 ? 0.9 : 0.5, 1); }
    } else if (view->grid == 2) {
        double o[3], gxs, gy;
        project(&f, 0, 0, 0, o); to_screen(&f, o, &gxs, &gy);
        line2d(cv, rx, gy, rx + rw, gy, GRID, 0.9, S);
    }

    double key[3], fill[3];
    for (int k = 0; k < 3; k++) key[k] = 0.45 * f.right[k] + 0.6 * f.up[k] + 0.65 * f.eye[k];
    for (int k = 0; k < 3; k++) fill[k] = -0.5 * f.right[k] - 0.3 * f.up[k] - 0.4 * f.eye[k];
    norm3(key); norm3(fill);
    for (size_t i = 0; i < ns; i++) raster(cv, &f, solid[i], 1, 1, key, fill, section_axis, section_value);
    for (size_t i = 0; i < ng; i++) raster(cv, &f, ghost[i], 0.35, 0, key, fill, section_axis, section_value);

    draw_annotations(cv, &f, ann, n_ann, S);
    if (labels) {
        double fs = 13 * S, small = 11 * S;
        double size[3] = { bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2] };
        char a[32], b[32], c[32], dims[160];
        fmt_num(a, sizeof a, size[0]); fmt_num(b, sizeof b, size[1]); fmt_num(c, sizeof c, size[2]);
        const char *vn = view->name;
        if (!strcmp(vn, "iso")) snprintf(dims, sizeof dims, "%s × %s × %s mm (X × Y × Z)", a, b, c);
        else if (!strcmp(vn, "top") || !strcmp(vn, "bottom")) snprintf(dims, sizeof dims, "%s × %s mm", a, c);
        else if (!strcmp(vn, "front") || !strcmp(vn, "back")) snprintf(dims, sizeof dims, "%s × %s mm", a, b);
        else snprintf(dims, sizeof dims, "%s × %s mm", c, b);
        text(cv, view->title, rx + 12 * S, ry + 20 * S, fs, INK, "Inter Bold");
        text(cv, dims, rx + 12 * S, ry + 36 * S, small, GREY, "Inter");
        if (section_axis >= 0) {
            char v[32], s[64];
            fmt_num(v, sizeof v, section_value);
            snprintf(s, sizeof s, "section at %c = %s", "xyz"[section_axis], v);
            text(cv, s, rx + 12 * S, ry + 52 * S, small, CUT, "Inter");
        }
        double target = rw / 6 / f.scale;
        static const double LENS[] = { 1, 2, 5, 10, 20, 50, 100, 200, 500 };
        double len = 10;
        for (int i = 0; i < 9; i++) if (fabs(LENS[i] - target) < fabs(len - target)) len = LENS[i];
        double bx = rx + 12 * S, by = ry + rh - 14 * S, bw = len * f.scale;
        line2d(cv, bx, by, bx + bw, by, INK, 1, 2 * S);
        line2d(cv, bx, by - 4 * S, bx, by + 4 * S, INK, 1, S);
        line2d(cv, bx + bw, by - 4 * S, bx + bw, by + 4 * S, INK, 1, S);
        char lab[32];
        snprintf(lab, sizeof lab, "%.0f mm", len);
        text(cv, lab, bx + bw + 8 * S, by + 4 * S, small, INK, "Inter");
        double ox = rx + rw - 40 * S, oy = ry + rh - 30 * S, al = 22 * S;
        for (int k = 0; k < 3; k++) {
            double d[3] = { k == 0, k == 1, k == 2 }, v[3];
            project(&f, d[0], d[1], d[2], v);
            if (hypot2(v[0], v[1]) < 0.05) continue;
            double ex = ox + v[0] * al, ey = oy - v[1] * al;
            line2d(cv, ox, oy, ex, ey, AXC[k], 1, 2 * S);
            char nm[2] = { "XYZ"[k], 0 };
            text(cv, nm, ex + (v[0] >= 0 ? 3 * S : -9 * S), ey + (v[1] >= 0 ? -2 * S : 10 * S), small, AXC[k], "Inter Bold");
        }
        /* the parts the script named, at the top of each bounding box */
        double used[40][2];
        size_t nu = 0, nl = 0;
        for (size_t i = 0; i < ns && nl < 40; i++) {
            const TemenPart *p = solid[i]->p;
            if (!p->name || !p->name[0] || !p->named) continue;
            nl++;
            double mn[3], mx[3];
            Mesh *one = solid[i];
            mesh_bounds(&one, 1, mn, mx);
            double cc[3] = { (mn[0] + mx[0]) / 2, mx[1], (mn[2] + mx[2]) / 2 }, q[3], lx, ly;
            project(&f, cc[0], cc[1], cc[2], q); to_screen(&f, q, &lx, &ly);
            double ty = ly - 14 * S;
            for (size_t u = 0; u < nu; u++) if (fabs(used[u][0] - lx) < 60 * S && fabs(used[u][1] - ty) < 14 * S) ty = used[u][1] - 14 * S;
            used[nu][0] = lx; used[nu][1] = ty; nu++;
            line2d(cv, lx, ly, lx, ty + 3 * S, INK, 0.8, S);
            double w = text_width(cv, p->name, small, "Inter Bold");
            double tx = jmin(rx + rw - w - 4 * S, jmax(rx + 4 * S, lx - w / 2));
            fill_rect(cv, tx - 3 * S, ty - small, tx + w + 3 * S, ty + 3 * S, BG, 0.75);
            text(cv, p->name, tx, ty, small, INK, "Inter Bold");
        }
    }
    free(solid); free(ghost); free(framed);
}

/* colorHex for the '#rrggbb' parts carry; the default colour otherwise */
static void part_rgb(const char *c, double *rgb) {
    unsigned v = 0x8fb3ff;
    if (c && c[0] == '#' && strlen(c) == 7) { char *end; unsigned long x = strtoul(c + 1, &end, 16); if (*end == 0) v = (unsigned)x; }
    rgb[0] = (v >> 16) & 255; rgb[1] = (v >> 8) & 255; rgb[2] = v & 255;
}

void *temen_render_views(TemenCore *core, const TemenPart *parts, size_t n_parts, const TemenRenderOptions *opts, size_t *out_len, const char **error) {
    if (out_len) *out_len = 0;
    if (error) *error = NULL;
    TemenRenderOptions o = { 0 };
    if (opts) o = *opts;
    int width = o.width > 0 ? o.width : 480, height = o.height > 0 ? o.height : 360, S = o.supersample > 0 ? o.supersample : 2;
    /* the views, in the order given, unknown names skipped */
    const View *views[16];
    size_t nv = 0;
    const char *list = o.views && *o.views ? o.views : "iso";
    while (*list && nv < 16) {
        const char *end = strchr(list, ',');
        size_t k = end ? (size_t)(end - list) : strlen(list);
        for (size_t i = 0; i < sizeof VIEWS / sizeof VIEWS[0]; i++) if (strlen(VIEWS[i].name) == k && !strncmp(VIEWS[i].name, list, k)) views[nv++] = &VIEWS[i];
        list += k; if (*list == ',') list++;
    }
    if (!nv) { if (error) *error = "views must be some of iso, top, bottom, front, back, left, right"; return NULL; }
    /* a section cuts every part first (render.js sectionMeshes); a part with nothing left goes */
    TemenPart *cut = calloc(n_parts + 1, sizeof *cut);
    float **owned_p = calloc(n_parts + 1, sizeof *owned_p);
    uint32_t **owned_i = calloc(n_parts + 1, sizeof *owned_i);
    size_t n = 0;
    for (size_t i = 0; i < n_parts; i++) {
        if (o.section_axis < 0 || o.section_axis > 2 || !o.has_section) { cut[n++] = parts[i]; continue; }
        TemenPart out;
        int st = temen_cut_mesh(core, parts[i].positions, parts[i].n_verts, parts[i].indices, parts[i].n_tris, o.section_axis, o.section_value, &out);
        if (st == 1) continue;
        if (st != 0) { if (error) *error = "mesh could not be cut"; goto fail; }
        cut[n] = parts[i];
        owned_p[n] = malloc(out.n_verts * 3 * sizeof(float) + 1);
        owned_i[n] = malloc(out.n_tris * 3 * sizeof(uint32_t) + 1);
        memcpy(owned_p[n], out.positions, out.n_verts * 3 * sizeof(float));
        memcpy(owned_i[n], out.indices, out.n_tris * 3 * sizeof(uint32_t));
        cut[n].positions = owned_p[n]; cut[n].n_verts = out.n_verts;
        cut[n].indices = owned_i[n]; cut[n].n_tris = out.n_tris;
        n++;
    }
    {
        Mesh *meshes = calloc(n + 1, sizeof *meshes);
        for (size_t i = 0; i < n; i++) { meshes[i].p = &cut[i]; part_rgb(cut[i].color, meshes[i].rgb); }
        int cols = nv == 1 ? 1 : nv <= 4 ? 2 : 3, rows = (int)((nv + cols - 1) / cols);
        Canvas cv = { width * S * cols, height * S * rows, NULL, NULL, core };
        size_t px = (size_t)cv.W * cv.H;
        cv.rgb = malloc(px * 3 * sizeof(float));
        cv.depth = malloc(px * sizeof(float));
        if (!cv.rgb || !cv.depth) { free(cv.rgb); free(cv.depth); free(meshes); if (error) *error = "out of memory"; goto fail; }
        for (size_t i = 0; i < px; i++) { cv.depth[i] = -INFINITY; cv.rgb[i * 3] = (float)BG[0]; cv.rgb[i * 3 + 1] = (float)BG[1]; cv.rgb[i * 3 + 2] = (float)BG[2]; }
        int section_axis = o.has_section ? o.section_axis : -1;
        for (size_t i = 0; i < nv; i++) {
            double rx = (double)((int)i % cols) * width * S, ry = (double)((int)i / cols) * height * S, rw = (double)width * S, rh = (double)height * S;
            draw_view(&cv, rx, ry, rw, rh, meshes, n, views[i], o.labels, section_axis, o.section_value, !o.no_ghosts, S, o.annotations, o.n_annotations);
            if (nv > 1) { line2d(&cv, rx, ry, rx + rw, ry, GRID, 1, S); line2d(&cv, rx, ry, rx, ry + rh, GRID, 1, S); }
        }
        /* average the supersamples into 8-bit RGB */
        int ow = width * cols, oh = height * rows;
        unsigned char *img = malloc((size_t)ow * oh * 3 + 1);
        double s2 = (double)S * S;
        for (int y = 0; y < oh; y++) for (int x = 0; x < ow; x++) {
            double r = 0, g = 0, b = 0;
            for (int dy = 0; dy < S; dy++) for (int dx = 0; dx < S; dx++) {
                size_t i = ((size_t)(y * S + dy) * cv.W + (size_t)(x * S + dx)) * 3;
                r += cv.rgb[i]; g += cv.rgb[i + 1]; b += cv.rgb[i + 2];
            }
            unsigned char *q = &img[((size_t)y * ow + x) * 3];
            q[0] = (unsigned char)js_round(r / s2); q[1] = (unsigned char)js_round(g / s2); q[2] = (unsigned char)js_round(b / s2);
        }
        free(cv.rgb); free(cv.depth); free(meshes);
        size_t len = 0;
        void *png = tdefl_write_image_to_png_file_in_memory_ex(img, ow, oh, 3, &len, 9, MZ_FALSE);
        free(img);
        for (size_t i = 0; i < n; i++) { free(owned_p[i]); free(owned_i[i]); }
        free(owned_p); free(owned_i); free(cut);
        if (!png) { if (error) *error = "the PNG could not be written"; return NULL; }
        if (out_len) *out_len = len;
        return png; /* miniz allocates with malloc: temen_buffer_free releases it */
    }
fail:
    for (size_t i = 0; i < n_parts; i++) { free(owned_p[i]); free(owned_i[i]); }
    free(owned_p); free(owned_i); free(cut);
    return NULL;
}
