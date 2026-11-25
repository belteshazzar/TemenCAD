/*
 * What the user tapped on a mesh: the whole flat face, or the curved surface (a hole, a boss, a fillet,
 * a sphere) the tapped triangle belongs to, described in words for the assistant; and a measurement
 * between two tapped points. A port of the web app's src/pick-geometry.js and the words in
 * src/pointer.js, operation for operation and in the same order (sums, set and map iteration), so the
 * labels and descriptions come out byte for byte the same: core/test/pick-parity.mjs checks it. Keep the
 * two in step.
 *
 * Independent of any TemenCore: hosts pass a part's mesh as it was built (Y up, millimetres).
 */
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "temencad.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

double js_k_atan2(double y, double x); /* lamassu's fdlibm kernel: the same bits as V8's Math.atan2 */

#define EPS_ANGLE 1e-6
#define AREA_RATIO 4.0
static const double SMOOTH = 0.86602540378443871; /* Math.cos(Math.PI / 6) */

/* ---- vectors, as pick-geometry.js computes them ---- */
typedef struct { double x[3]; } V;
static V v3(double a, double b, double c) { V r = { { a, b, c } }; return r; }
static V sub(V a, V b) { return v3(a.x[0] - b.x[0], a.x[1] - b.x[1], a.x[2] - b.x[2]); }
static V add(V a, V b) { return v3(a.x[0] + b.x[0], a.x[1] + b.x[1], a.x[2] + b.x[2]); }
static V scale(V a, double s) { return v3(a.x[0] * s, a.x[1] * s, a.x[2] * s); }
static double dot(V a, V b) { return a.x[0] * b.x[0] + a.x[1] * b.x[1] + a.x[2] * b.x[2]; }
static V cross(V a, V b) { return v3(a.x[1] * b.x[2] - a.x[2] * b.x[1], a.x[2] * b.x[0] - a.x[0] * b.x[2], a.x[0] * b.x[1] - a.x[1] * b.x[0]); }
/* Math.hypot(x, y, z) as V8 computes it (scaled, Kahan-summed) */
static double hypot3(double x, double y, double z) {
    double v[3] = { fabs(x), fabs(y), fabs(z) };
    double max = v[0] > v[1] ? v[0] : v[1];
    if (v[2] > max) max = v[2];
    if (isinf(max)) return INFINITY;
    if (max == 0) return 0;
    double sum = 0, comp = 0;
    for (int i = 0; i < 3; i++) {
        double n = v[i] / max, summand = n * n - comp, pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    return sqrt(sum) * max;
}
static double len(V a) { return hypot3(a.x[0], a.x[1], a.x[2]); }
static V norm(V a) { double l = len(a); if (l == 0 || isnan(l)) l = 1; return v3(a.x[0] / l, a.x[1] / l, a.x[2] / l); }
static double js_round(double x) { double r = floor(x); if (x - r >= 0.5) r += 1; return r; } /* Math.round */

/* ---- growable arrays ---- */
typedef struct { int *v; size_t n, cap; } IntVec;
static void ipush(IntVec *a, int x) {
    if (a->n == a->cap) { a->cap = a->cap ? a->cap * 2 : 8; a->v = realloc(a->v, a->cap * sizeof *a->v); }
    a->v[a->n++] = x;
}
typedef struct { char *s; size_t n, cap; } Str;
static void sput(Str *b, const char *s) {
    size_t k = strlen(s);
    if (b->n + k + 1 > b->cap) { b->cap = (b->n + k + 1) * 2; b->s = realloc(b->s, b->cap); }
    memcpy(b->s + b->n, s, k + 1);
    b->n += k;
}
static void sputf(Str *b, const char *fmt, ...) {
    char tmp[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    sput(b, tmp);
}

/* ---- hash maps keyed by integer tuples (insertion order kept by the caller's arrays) ---- */
typedef struct { int64_t k[3]; int val; int used; } Slot;
typedef struct { Slot *s; size_t cap, n; } Map;
static uint64_t hash3(const int64_t *k) {
    uint64_t h = 1469598103934665603ULL;
    for (int i = 0; i < 3; i++) { h ^= (uint64_t)k[i]; h *= 1099511628211ULL; h ^= h >> 29; }
    return h;
}
static int map_get_or_add(Map *m, const int64_t *k, int val, int *found) {
    if ((m->n + 1) * 2 > m->cap) {
        Map g = { calloc(m->cap ? m->cap * 2 : 64, sizeof(Slot)), m->cap ? m->cap * 2 : 64, 0 };
        for (size_t i = 0; i < m->cap; i++) if (m->s[i].used) { int f; map_get_or_add(&g, m->s[i].k, m->s[i].val, &f); }
        free(m->s);
        *m = g;
    }
    size_t i = hash3(k) & (m->cap - 1);
    while (m->s[i].used) {
        if (m->s[i].k[0] == k[0] && m->s[i].k[1] == k[1] && m->s[i].k[2] == k[2]) { *found = 1; return m->s[i].val; }
        i = (i + 1) & (m->cap - 1);
    }
    m->s[i].used = 1; memcpy(m->s[i].k, k, sizeof m->s[i].k); m->s[i].val = val; m->n++;
    *found = 0;
    return val;
}

/* ---- topology ---- */
typedef struct { int id; IntVec tris; V normal; double area; V centroid; } Facet;

struct TemenPick {
    size_t tri_count;
    int *tv;            /* welded vertex per triangle corner */
    V *pts;             /* welded vertex positions */
    size_t n_pts;
    double *normals, *areas, *centroids;
    IntVec *neighbors;
    double size;
    int *facet_of;
    Facet *facets;
    size_t n_facets, cap_facets;
    Str out;
};

static V tri_n(const TemenPick *p, int t) { return v3(p->normals[3 * t], p->normals[3 * t + 1], p->normals[3 * t + 2]); }
static V tri_c(const TemenPick *p, int t) { return v3(p->centroids[3 * t], p->centroids[3 * t + 1], p->centroids[3 * t + 2]); }

TemenPick *temen_pick_new(const float *positions, size_t n_verts, const uint32_t *indices, size_t n_tris) {
    TemenPick *p = calloc(1, sizeof *p);
    if (!p) return NULL;
    /* weld vertices by position at 1e-5 mm, first occurrence first */
    int *canon = malloc((n_verts ? n_verts : 1) * sizeof *canon);
    p->pts = malloc((n_verts ? n_verts : 1) * sizeof *p->pts);
    Map seen = { 0 };
    for (size_t v = 0; v < n_verts; v++) {
        int64_t k[3];
        for (int j = 0; j < 3; j++) k[j] = (int64_t)js_round((double)positions[3 * v + j] * 1e5);
        int found;
        int id = map_get_or_add(&seen, k, (int)p->n_pts, &found);
        if (!found) { p->pts[p->n_pts++] = v3(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]); }
        canon[v] = id;
    }
    free(seen.s);
    size_t tc = indices ? n_tris : n_verts / 3;
    p->tri_count = tc;
    p->tv = malloc((tc ? tc : 1) * 3 * sizeof *p->tv);
    for (size_t t = 0; t < tc * 3; t++) p->tv[t] = canon[indices ? indices[t] : t];
    free(canon);
    p->normals = calloc(tc * 3 + 1, sizeof(double));
    p->areas = calloc(tc + 1, sizeof(double));
    p->centroids = calloc(tc * 3 + 1, sizeof(double));
    /* edges in first-seen order, each with its triangles */
    Map edges = { 0 };
    IntVec *edge_tris = NULL;
    size_t n_edges = 0, cap_edges = 0;
    for (size_t t = 0; t < tc; t++) {
        V a = p->pts[p->tv[3 * t]], b = p->pts[p->tv[3 * t + 1]], c = p->pts[p->tv[3 * t + 2]];
        V n = cross(sub(b, a), sub(c, a));
        double l = len(n);
        p->areas[t] = l / 2;
        V u = l ? scale(n, 1 / l) : v3(0, 0, 0);
        memcpy(&p->normals[3 * t], u.x, sizeof u.x);
        p->centroids[3 * t] = (a.x[0] + b.x[0] + c.x[0]) / 3;
        p->centroids[3 * t + 1] = (a.x[1] + b.x[1] + c.x[1]) / 3;
        p->centroids[3 * t + 2] = (a.x[2] + b.x[2] + c.x[2]) / 3;
        for (int k = 0; k < 3; k++) {
            int i = p->tv[3 * t + k], j = p->tv[3 * t + (k + 1) % 3];
            int64_t key[3] = { i < j ? i : j, i < j ? j : i, 0 };
            int found;
            int e = map_get_or_add(&edges, key, (int)n_edges, &found);
            if (!found) {
                if (n_edges == cap_edges) { cap_edges = cap_edges ? cap_edges * 2 : 64; edge_tris = realloc(edge_tris, cap_edges * sizeof *edge_tris); }
                memset(&edge_tris[n_edges++], 0, sizeof *edge_tris);
            }
            ipush(&edge_tris[e], (int)t);
        }
    }
    free(edges.s);
    p->neighbors = calloc(tc + 1, sizeof *p->neighbors);
    for (size_t e = 0; e < n_edges; e++) {
        IntVec *l = &edge_tris[e];
        for (size_t x = 0; x < l->n; x++) for (size_t y = 0; y < l->n; y++) if (l->v[y] != l->v[x]) ipush(&p->neighbors[l->v[x]], l->v[y]);
        free(l->v);
    }
    free(edge_tris);
    V lo = v3(INFINITY, INFINITY, INFINITY), hi = v3(-INFINITY, -INFINITY, -INFINITY);
    for (size_t id = 0; id < p->n_pts; id++) for (int k = 0; k < 3; k++) {
        lo.x[k] = fmin(lo.x[k], p->pts[id].x[k]); hi.x[k] = fmax(hi.x[k], p->pts[id].x[k]);
    }
    p->size = len(sub(hi, lo));
    if (p->size == 0 || isnan(p->size)) p->size = 1;
    p->facet_of = malloc((tc ? tc : 1) * sizeof(int));
    for (size_t t = 0; t < tc; t++) p->facet_of[t] = -1;
    return p;
}

void temen_pick_free(TemenPick *p) {
    if (!p) return;
    for (size_t t = 0; t < p->tri_count; t++) free(p->neighbors[t].v);
    for (size_t f = 0; f < p->n_facets; f++) free(p->facets[f].tris.v);
    free(p->neighbors); free(p->facets); free(p->facet_of); free(p->tv); free(p->pts);
    free(p->normals); free(p->areas); free(p->centroids); free(p->out.s);
    free(p);
}

/* The flat face (coplanar, edge-connected triangles) containing t, cached. Returns its index. */
static int facet(TemenPick *p, int t) {
    if (p->facet_of[t] >= 0) return p->facet_of[t];
    V n0 = tri_n(p, t);
    double d0 = dot(n0, tri_c(p, t)), tol = 1e-5 * p->size;
    int id = (int)p->n_facets;
    IntVec tris = { 0 };
    ipush(&tris, t);
    p->facet_of[t] = id;
    for (size_t q = 0; q < tris.n; q++) {
        IntVec *nb = &p->neighbors[tris.v[q]];
        for (size_t k = 0; k < nb->n; k++) {
            int u = nb->v[k];
            if (p->facet_of[u] >= 0) continue;
            V nu = tri_n(p, u);
            if (1 - dot(nu, n0) > EPS_ANGLE || fabs(dot(n0, tri_c(p, u)) - d0) > tol) continue;
            p->facet_of[u] = id;
            ipush(&tris, u);
        }
    }
    double area = 0;
    V c = v3(0, 0, 0);
    for (size_t k = 0; k < tris.n; k++) { int u = tris.v[k]; area += p->areas[u]; c = add(c, scale(tri_c(p, u), p->areas[u])); }
    if (p->n_facets == p->cap_facets) { p->cap_facets = p->cap_facets ? p->cap_facets * 2 : 64; p->facets = realloc(p->facets, p->cap_facets * sizeof *p->facets); }
    Facet *f = &p->facets[p->n_facets++];
    f->id = id; f->tris = tris; f->normal = n0; f->area = area; f->centroid = scale(c, 1 / (area ? area : 1));
    return id;
}

/* Smallest-eigenvalue eigenvector of a symmetric 3x3 (Jacobi), and the eigenvalues ascending */
static V smallest_eigen(double m[3][3], double vals_out[3]) {
    double a[3][3], v[3][3] = { { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, 1 } };
    memcpy(a, m, sizeof a);
    for (int sweep = 0; sweep < 50; sweep++) {
        double off = 0;
        for (int p = 0; p < 3; p++) for (int q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
        if (off < 1e-18) break;
        for (int p = 0; p < 3; p++) for (int q = p + 1; q < 3; q++) {
            if (fabs(a[p][q]) < 1e-15) continue;
            double th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            double ths = (th == 0 || isnan(th)) ? 1 : th;
            double sg = ths > 0 ? 1 : ths < 0 ? -1 : ths;
            double t = sg / (fabs(th) + sqrt(th * th + 1));
            double c = 1 / sqrt(t * t + 1), s = t * c;
            for (int k = 0; k < 3; k++) { double akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
            for (int k = 0; k < 3; k++) { double apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
            for (int k = 0; k < 3; k++) { double vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
        }
    }
    double vals[3] = { a[0][0], a[1][1], a[2][2] };
    double mn = fmin(fmin(vals[0], vals[1]), vals[2]);
    int i = vals[0] == mn ? 0 : vals[1] == mn ? 1 : 2;
    /* ascending */
    double s[3] = { vals[0], vals[1], vals[2] };
    for (int x = 0; x < 3; x++) for (int y = x + 1; y < 3; y++) if (s[y] < s[x]) { double tmp = s[x]; s[x] = s[y]; s[y] = tmp; }
    memcpy(vals_out, s, sizeof s);
    return norm(v3(v[0][i], v[1][i], v[2][i]));
}

typedef struct {
    int flat;                 /* kind: flat or curved */
    int shape;                /* 0 surface, 1 cylinder, 2 sphere (curved only) */
    V normal; double offset;  /* flat */
    double radius; int convex; V axis; V center; double length; double span;
    double area; V bmin, bmax; V centroid;
    IntVec tris;              /* owned */
} Surface;

static void bounds_of(const TemenPick *p, const int *tris, size_t n, V *lo, V *hi) {
    *lo = v3(INFINITY, INFINITY, INFINITY); *hi = v3(-INFINITY, -INFINITY, -INFINITY);
    for (size_t i = 0; i < n; i++) for (int k = 0; k < 3; k++) {
        V q = p->pts[p->tv[3 * tris[i] + k]];
        for (int j = 0; j < 3; j++) { lo->x[j] = fmin(lo->x[j], q.x[j]); hi->x[j] = fmax(hi->x[j], q.x[j]); }
    }
}

static int cmp_double(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : x > y ? 1 : 0; }

static Surface surface_at(TemenPick *p, int t) {
    Surface s;
    memset(&s, 0, sizeof s);
    int f0 = facet(p, t);
    IntVec fl = { 0 };   /* facet ids in growth order */
    ipush(&fl, f0);
    char *seen = calloc(p->tri_count + 1, 1); /* facet ids are < tri_count */
    seen[f0] = 1;
    for (size_t q = 0; q < fl.n; q++) {
        Facet *fq = &p->facets[fl.v[q]];
        for (size_t a = 0; a < fq->tris.n; a++) {
            int u = fq->tris.v[a];
            for (size_t b = 0; b < p->neighbors[u].n; b++) {
                int w = p->neighbors[u].v[b];
                int g = facet(p, w);
                fq = &p->facets[fl.v[q]]; /* facet() may have grown the array */
                if (seen[g]) continue;
                Facet *fg = &p->facets[g], *ff0 = &p->facets[f0];
                double d = dot(fg->normal, tri_n(p, u));
                if (d < SMOOTH || d > 1 - EPS_ANGLE) continue;
                if (fg->area > AREA_RATIO * ff0->area || ff0->area > AREA_RATIO * fg->area * AREA_RATIO) continue;
                seen[g] = 1;
                ipush(&fl, g);
            }
        }
    }
    free(seen);
    for (size_t i = 0; i < fl.n; i++) { Facet *f = &p->facets[fl.v[i]]; for (size_t k = 0; k < f->tris.n; k++) ipush(&s.tris, f->tris.v[k]); }
    Facet *F0 = &p->facets[f0];
    if (fl.n < 3) {
        free(s.tris.v); memset(&s.tris, 0, sizeof s.tris);
        for (size_t k = 0; k < F0->tris.n; k++) ipush(&s.tris, F0->tris.v[k]);
        s.flat = 1; s.normal = F0->normal; s.offset = dot(F0->normal, F0->centroid); s.area = F0->area;
        bounds_of(p, s.tris.v, s.tris.n, &s.bmin, &s.bmax);
        s.centroid = F0->centroid;
        free(fl.v);
        return s;
    }
    bounds_of(p, s.tris.v, s.tris.n, &s.bmin, &s.bmax);
    double area = 0;
    for (size_t i = 0; i < fl.n; i++) area = area + p->facets[fl.v[i]].area;
    V centroid = v3(0, 0, 0);
    for (size_t i = 0; i < fl.n; i++) centroid = add(centroid, scale(p->facets[fl.v[i]].centroid, p->facets[fl.v[i]].area));
    centroid = scale(centroid, 1 / (area ? area : 1));
    s.area = area; s.centroid = centroid;

    /* fit: the axis is the direction the normals avoid; then the circle (or sphere) through the facets */
    double M[3][3] = { { 0 } };
    for (size_t k = 0; k < fl.n; k++) { Facet *f = &p->facets[fl.v[k]]; for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) M[i][j] += f->area * f->normal.x[i] * f->normal.x[j]; }
    double vals[3];
    V ev = smallest_eigen(M, vals);
    int cylindrical = vals[0] < 0.02 * vals[2];
    V axis = ev;
#define FLAT(v) (cylindrical ? sub((v), scale(axis, dot((v), axis))) : (v))
    V pbar = v3(0, 0, 0), nbar = v3(0, 0, 0);
    for (size_t k = 0; k < fl.n; k++) { Facet *f = &p->facets[fl.v[k]]; pbar = add(pbar, scale(FLAT(f->centroid), f->area)); nbar = add(nbar, scale(FLAT(f->normal), f->area)); }
    pbar = scale(pbar, 1 / area); nbar = scale(nbar, 1 / area);
    double num = 0, den = 0;
    for (size_t k = 0; k < fl.n; k++) { Facet *f = &p->facets[fl.v[k]]; V dp = sub(FLAT(f->centroid), pbar), dn = sub(FLAT(f->normal), nbar); num += f->area * dot(dp, dn); den += f->area * dot(dn, dn); }
    double r = den > 1e-12 ? num / den : 0;
    V c = sub(pbar, scale(nbar, r));
    double res = 0;
    for (size_t k = 0; k < fl.n; k++) { Facet *f = &p->facets[fl.v[k]]; V e = sub(sub(FLAT(f->centroid), c), scale(FLAT(f->normal), r)); res += f->area * dot(e, e); }
    int fits = fabs(r) > 1e-9 && sqrt(res / area) < 0.08 * fabs(r);
    if (!fits) { s.shape = 0; free(fl.v); return s; }
    /* the radius from the vertices (they lie on the true surface), in first-seen order */
    IntVec verts = { 0 };
    char *vs = calloc(p->n_pts + 1, 1);
    for (size_t i = 0; i < s.tris.n; i++) for (int k = 0; k < 3; k++) { int id = p->tv[3 * s.tris.v[i] + k]; if (!vs[id]) { vs[id] = 1; ipush(&verts, id); } }
    free(vs);
    double rsum = 0;
    for (size_t i = 0; i < verts.n; i++) rsum += len(sub(FLAT(p->pts[verts.v[i]]), c));
    s.radius = rsum / (double)verts.n;
    s.convex = r > 0;
    if (cylindrical) {
        V u = norm(FLAT(p->facets[fl.v[0]].normal)), w = cross(axis, u);
        double *ang = malloc(fl.n * sizeof *ang);
        for (size_t k = 0; k < fl.n; k++) { V n = FLAT(p->facets[fl.v[k]].normal); ang[k] = js_k_atan2(dot(n, w), dot(n, u)); }
        qsort(ang, fl.n, sizeof *ang, cmp_double);
        double gap = 2 * M_PI - (ang[fl.n - 1] - ang[0]);
        for (size_t i = 1; i < fl.n; i++) gap = fmax(gap, ang[i] - ang[i - 1]);
        double covered = 2 * M_PI - gap, step = covered / (double)(fl.n - 1 > 1 ? fl.n - 1 : 1);
        s.span = gap <= 1.5 * step ? 360 : js_round((covered + step) * 180 / M_PI);
        free(ang);
        double amin = INFINITY, amax = -INFINITY;
        for (size_t i = 0; i < verts.n; i++) { double s2 = dot(p->pts[verts.v[i]], axis); amin = fmin(amin, s2); amax = fmax(amax, s2); }
        s.shape = 1; s.axis = axis; s.center = add(c, scale(axis, (amin + amax) / 2)); s.length = amax - amin;
    } else {
        s.shape = 2; s.center = c;
    }
#undef FLAT
    free(verts.v);
    free(fl.v);
    return s;
}

/* ---- words (pick-geometry.js) ---- */

/* r2 as JS prints it: Math.round(x * 100) / 100, -0 as 0, shortest digits */
static void put_r2(Str *b, double x) {
    double v = js_round(x * 100) / 100;
    if (v == 0) v = 0;
    char tmp[64];
    snprintf(tmp, sizeof tmp, "%.2f", v);
    char *dot_ = strchr(tmp, '.');
    if (dot_) { char *e = tmp + strlen(tmp) - 1; while (e > dot_ && *e == '0') *e-- = 0; if (e == dot_) *e = 0; }
    if (strcmp(tmp, "-0") == 0) strcpy(tmp, "0");
    sput(b, tmp);
}
static void put_point(Str *b, V p) { sput(b, "["); for (int k = 0; k < 3; k++) { if (k) sput(b, ", "); put_r2(b, p.x[k]); } sput(b, "]"); }

static const char *AXIS_CH[3] = { "x", "y", "z" };
static const char *AXIS_UP[3] = { "X", "Y", "Z" };
/* sideName: an axis-aligned normal's side, or -1 */
static int side_of(V n, int *axis, int *positive) {
    for (int a = 0; a < 3; a++) {
        V e = v3(a == 0, a == 1, a == 2);
        double d = dot(n, e);
        if (fabs(d) > 0.9999) { *axis = a; *positive = d > 0; return 1; }
    }
    return 0;
}
static const char *side_name(int axis, int positive) {
    static const char *names[3][2] = { { "left", "right" }, { "bottom", "top" }, { "back", "front" } };
    return names[axis][positive];
}
static void put_axis_name(Str *b, V a) {
    for (int k = 0; k < 3; k++) { V e = v3(k == 0, k == 1, k == 2); if (fabs(dot(a, e)) > 0.999) { sput(b, AXIS_UP[k]); return; } }
    put_point(b, a);
}
static double along(V c, int axis) { return dot(c, v3(axis == 0, axis == 1, axis == 2)); }

static void put_json_string(Str *b, const char *s) {
    sput(b, "\"");
    for (; *s; s++) {
        unsigned char ch = (unsigned char)*s;
        if (ch == '"' || ch == '\\') { char t[3] = { '\\', (char)ch, 0 }; sput(b, t); }
        else if (ch < 0x20) sputf(b, "\\u%04x", ch);
        else { char t[2] = { (char)ch, 0 }; sput(b, t); }
    }
    sput(b, "\"");
}

static void short_label(Str *b, const char *part, const Surface *s) {
    sput(b, part); sput(b, " · ");
    if (s->flat) {
        int axis, pos;
        if (side_of(s->normal, &axis, &pos)) { sputf(b, "%s face at %s = ", side_name(axis, pos), AXIS_CH[axis]); put_r2(b, along(s->centroid, axis)); }
        else sput(b, "sloped face");
        return;
    }
    if (s->shape == 1) {
        if (s->span < 359) { sput(b, "R"); put_r2(b, s->radius); sputf(b, " %s along ", s->convex ? "rounded edge" : "inside corner"); put_axis_name(b, s->axis); }
        else { sput(b, "Ø"); put_r2(b, 2 * s->radius); sputf(b, " %s along ", s->convex ? "round" : "hole"); put_axis_name(b, s->axis); }
        return;
    }
    if (s->shape == 2) { sputf(b, "%s R", s->convex ? "sphere" : "spherical pocket"); put_r2(b, s->radius); return; }
    sput(b, "curved surface");
}

static void describe(Str *b, const char *part, const Surface *s, V point) {
    Str where = { 0 }, box = { 0 };
    sputf(&where, "on part \"%s\", clicked at ", part); put_point(&where, point); sput(&where, " (mm; Y is up, +Z is the front)");
    sput(&box, "its extent is "); put_point(&box, s->bmin); sput(&box, " to "); put_point(&box, s->bmax);
    if (s->flat) {
        int axis, pos;
        if (side_of(s->normal, &axis, &pos)) { sputf(b, "the flat %s face (normal %s%s) at %s = ", side_name(axis, pos), pos ? "+" : "-", AXIS_UP[axis], AXIS_CH[axis]); put_r2(b, along(s->centroid, axis)); }
        else { sput(b, "a flat sloped face with normal "); put_point(b, s->normal); }
        sput(b, ", "); sput(b, where.s); sput(b, "; area "); put_r2(b, s->area); sput(b, " mm², "); sput(b, box.s);
    } else if (s->shape == 1) {
        if (s->span >= 359) {
            sput(b, s->convex ? "a cylindrical surface (a round boss or rod) of diameter ≈ " : "a hole (inside of a cylinder) of diameter ≈ ");
            put_r2(b, 2 * s->radius);
        } else {
            sputf(b, "a curved %s of radius ≈ ", s->convex ? "rounded edge (convex fillet)" : "inside corner (concave fillet)");
            put_r2(b, s->radius); sputf(b, " spanning about %.0f°", s->span);
        }
        sput(b, ", axis along "); put_axis_name(b, s->axis); sput(b, " through "); put_point(b, s->center); sput(b, ", ");
        put_r2(b, s->length); sput(b, " long, "); sput(b, where.s); sput(b, "; "); sput(b, box.s);
    } else if (s->shape == 2) {
        sputf(b, "a %s of radius ≈ ", s->convex ? "spherical surface" : "spherical pocket"); put_r2(b, s->radius);
        sput(b, " centred at "); put_point(b, s->center); sput(b, ", "); sput(b, where.s); sput(b, "; "); sput(b, box.s);
    } else {
        sput(b, "a curved surface "); sput(b, where.s); sput(b, "; "); sput(b, box.s);
    }
    free(where.s); free(box.s);
}

static void put_num(Str *b, double v) { if (isfinite(v)) sputf(b, "%.17g", v); else sput(b, "null"); }
static void put_vec(Str *b, V v) { sput(b, "["); for (int k = 0; k < 3; k++) { if (k) sput(b, ","); put_num(b, v.x[k]); } sput(b, "]"); }

const char *temen_pick_surface(TemenPick *p, size_t tri, const char *part, const double point[3]) {
    if (!p || tri >= p->tri_count) return NULL;
    if (!part) part = "";
    Surface s = surface_at(p, (int)tri);
    V pt = v3(point ? point[0] : 0, point ? point[1] : 0, point ? point[2] : 0);
    Str *b = &p->out;
    b->n = 0; if (b->s) b->s[0] = 0;
    sputf(b, "{\"kind\":\"%s\"", s.flat ? "flat" : "curved");
    if (s.flat) { sput(b, ",\"normal\":"); put_vec(b, s.normal); sput(b, ",\"offset\":"); put_num(b, s.offset); }
    else {
        sputf(b, ",\"shape\":\"%s\"", s.shape == 1 ? "cylinder" : s.shape == 2 ? "sphere" : "surface");
        if (s.shape) { sput(b, ",\"radius\":"); put_num(b, s.radius); sputf(b, ",\"convex\":%s,\"center\":", s.convex ? "true" : "false"); put_vec(b, s.center); }
        if (s.shape == 1) { sput(b, ",\"axis\":"); put_vec(b, s.axis); sput(b, ",\"length\":"); put_num(b, s.length); sput(b, ",\"span\":"); put_num(b, s.span); }
    }
    sput(b, ",\"area\":"); put_num(b, s.area);
    sput(b, ",\"bounds\":{\"min\":"); put_vec(b, s.bmin); sput(b, ",\"max\":"); put_vec(b, s.bmax); sput(b, "},\"centroid\":"); put_vec(b, s.centroid);
    sput(b, ",\"tris\":[");
    for (size_t i = 0; i < s.tris.n; i++) sputf(b, i ? ",%d" : "%d", s.tris.v[i]);
    sput(b, "],\"label\":");
    Str t = { 0 };
    short_label(&t, part, &s); put_json_string(b, t.s); t.n = 0; t.s[0] = 0;
    sput(b, ",\"description\":");
    describe(&t, part, &s, pt); put_json_string(b, t.s);
    sput(b, "}");
    free(t.s);
    free(s.tris.v);
    return b->s;
}

const char *temen_pick_measure(TemenPick *pa, size_t tri_a, const char *part_a, const double a3[3], int snapped_a,
                               TemenPick *pb, size_t tri_b, const char *part_b, const double b3[3], int snapped_b) {
    if (!pa || !pb || tri_a >= pa->tri_count || tri_b >= pb->tri_count) return NULL;
    if (!part_a) part_a = "";
    if (!part_b) part_b = "";
    Surface sa = surface_at(pa, (int)tri_a), sb = surface_at(pb, (int)tri_b);
    V a = v3(a3[0], a3[1], a3[2]), b = v3(b3[0], b3[1], b3[2]);
    double dx = a.x[0] - b.x[0], dy = a.x[1] - b.x[1], dz = a.x[2] - b.x[2];
    double d = sqrt(dx * dx + dy * dy + dz * dz); /* three.js distanceTo */
    V delta = v3(fabs(b.x[0] - a.x[0]), fabs(b.x[1] - a.x[1]), fabs(b.x[2] - a.x[2]));
    int has_gap = sa.flat && sb.flat && fabs(dot(sa.normal, sb.normal)) >= 0.9999;
    double gap = has_gap ? fabs(dot(sa.normal, sub(sb.centroid, sa.centroid))) : 0;
    Str text = { 0 }, lab = { 0 };
    for (int e = 0; e < 2; e++) {
        Surface *s = e ? &sb : &sa;
        const char *part = e ? part_b : part_a;
        sput(&text, e ? " to " : "from ");
        put_point(&text, e ? b : a);
        sputf(&text, " on part \"%s\"%s, ", part, (e ? snapped_b : snapped_a) ? " (a corner)" : "");
        lab.n = 0; if (lab.s) lab.s[0] = 0;
        short_label(&lab, part, s);
        /* shortLabel(...).split(' · ')[1] */
        const char *first = strstr(lab.s, " · ");
        if (first) {
            const char *rest = first + strlen(" · ");
            const char *next = strstr(rest, " · ");
            size_t k = next ? (size_t)(next - rest) : strlen(rest);
            char *piece = malloc(k + 1); memcpy(piece, rest, k); piece[k] = 0;
            sput(&text, piece); free(piece);
        } else sput(&text, "undefined");
    }
    sput(&text, ": "); put_r2(&text, d); sput(&text, " mm (|Δx| "); put_r2(&text, delta.x[0]); sput(&text, ", |Δy| "); put_r2(&text, delta.x[1]);
    sput(&text, ", |Δz| "); put_r2(&text, delta.x[2]); sput(&text, ")");
    if (has_gap) { sput(&text, "; the two faces are parallel and "); put_r2(&text, gap); sput(&text, " mm apart"); }
    lab.n = 0; lab.s[0] = 0;
    sput(&lab, "Measured "); put_r2(&lab, d); sput(&lab, " mm");
    Str *o = &pa->out;
    o->n = 0; if (o->s) o->s[0] = 0;
    sput(o, "{\"distance\":"); put_num(o, d); sput(o, ",\"delta\":"); put_vec(o, delta);
    sput(o, ",\"gap\":"); if (has_gap) put_num(o, gap); else sput(o, "null");
    sput(o, ",\"label\":"); put_json_string(o, lab.s);
    sput(o, ",\"text\":"); put_json_string(o, text.s);
    sput(o, "}");
    free(text.s); free(lab.s); free(sa.tris.v); free(sb.tris.v);
    return o->s;
}
