/*
 * STL and 3MF writers over built parts, byte for byte the web app's src/export.js (buildSTL, build3MF),
 * which must stay in step with this file. Independent of any TemenCore and of the JavaScript engine.
 *
 * Slicers expect Z up, so output coordinates are (x, -z, y): the build plate (y = 0) becomes z = 0.
 */
#include <ctype.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "temencad.h"

static void set_error(const char **error, const char *msg) { if (error) *error = msg; }

/* ---- STL --------------------------------------------------------------------------------- */

/* Math.hypot(x, y, z) as V8 computes it (scaled, Kahan-summed), so the normals round as they do in JS. */
static double js_hypot3(double x, double y, double z) {
    double v[3] = { fabs(x), fabs(y), fabs(z) };
    double max = v[0] > v[1] ? v[0] : v[1];
    if (v[2] > max) max = v[2];
    if (isinf(max)) return INFINITY;
    if (max == 0) return 0;
    double sum = 0, compensation = 0;
    for (int i = 0; i < 3; i++) {
        double n = v[i] / max;
        double summand = n * n - compensation;
        double preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    return sqrt(sum) * max;
}

static void put_f32(unsigned char **o, double v) {
    float f = (float)v;
    uint32_t u;
    memcpy(&u, &f, 4);
    (*o)[0] = (unsigned char)u; (*o)[1] = (unsigned char)(u >> 8); (*o)[2] = (unsigned char)(u >> 16); (*o)[3] = (unsigned char)(u >> 24);
    *o += 4;
}

void *temen_write_stl(const TemenPart *parts, size_t n, size_t *out_len, const char **error) {
    set_error(error, NULL);
    if (out_len) *out_len = 0;
    uint64_t tris = 0;
    for (size_t i = 0; i < n; i++) tris += parts[i].n_tris;
    if (tris > UINT32_MAX) { set_error(error, "too many triangles for STL"); return NULL; }
    size_t size = 84 + (size_t)tris * 50;
    unsigned char *buf = malloc(size);
    if (!buf) { set_error(error, "out of memory"); return NULL; }
    memset(buf, ' ', 80);
    memcpy(buf, "TemenCAD binary STL", 19);
    buf[80] = (unsigned char)tris; buf[81] = (unsigned char)(tris >> 8); buf[82] = (unsigned char)(tris >> 16); buf[83] = (unsigned char)(tris >> 24);
    unsigned char *o = buf + 84;
    for (size_t i = 0; i < n; i++) {
        const TemenPart *p = &parts[i];
        for (size_t t = 0; t < p->n_tris; t++) {
            double c[9];
            for (int k = 0; k < 3; k++) {
                const float *v = p->positions + (size_t)p->indices[t * 3 + k] * 3;
                c[k * 3] = v[0]; c[k * 3 + 1] = -(double)v[2]; c[k * 3 + 2] = v[1];
            }
            double ux = c[3] - c[0], uy = c[4] - c[1], uz = c[5] - c[2], vx = c[6] - c[0], vy = c[7] - c[1], vz = c[8] - c[2];
            double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            double l = js_hypot3(nx, ny, nz);
            if (l == 0 || isnan(l)) l = 1;
            put_f32(&o, nx / l); put_f32(&o, ny / l); put_f32(&o, nz / l);
            for (int k = 0; k < 9; k++) put_f32(&o, c[k]);
            o[0] = 0; o[1] = 0; o += 2;
        }
    }
    if (out_len) *out_len = size;
    return buf;
}

/* ---- 3MF --------------------------------------------------------------------------------- */

typedef struct { char *s; size_t len, cap; int failed; } Buf;

static void grow(Buf *b, size_t extra) {
    if (b->failed || b->len + extra + 1 <= b->cap) return;
    size_t cap = b->cap ? b->cap : 4096;
    while (cap < b->len + extra + 1) cap *= 2;
    char *s = realloc(b->s, cap);
    if (!s) { b->failed = 1; return; }
    b->s = s; b->cap = cap;
}
static void put(Buf *b, const char *s) {
    size_t n = strlen(s);
    grow(b, n);
    if (b->failed) return;
    memcpy(b->s + b->len, s, n + 1);
    b->len += n;
}
static void putf(Buf *b, const char *fmt, ...) {
    char tmp[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    put(b, tmp);
}
static void put_escaped(Buf *b, const char *s) {
    for (; *s; s++) {
        switch (*s) {
        case '<': put(b, "&lt;"); break;
        case '>': put(b, "&gt;"); break;
        case '&': put(b, "&amp;"); break;
        case '"': put(b, "&quot;"); break;
        case '\'': put(b, "&apos;"); break;
        default: { char c[2] = { *s, 0 }; put(b, c); }
        }
    }
}
/* fmt() in export.js: (Math.abs(n) < 1e-9 ? '0' : +n.toFixed(5)).toString(). toFixed rounds an exact
 * tie away from zero where printf rounds it to even. A double is exactly halfway between two 5-decimal
 * values when v * 10^5 = k + 1/2, i.e. v = odd / (2^6 * 5^5); a double is dyadic, so that is when v * 64
 * is an odd integer. Moving such a value one ulp away from zero makes printf round it as toFixed does. */
static void put_num(Buf *b, double v) {
    if (fabs(v) < 1e-9) { put(b, "0"); return; }
    double s = v * 64; /* exact: a power of two */
    if (s == floor(s) && fabs(fmod(s, 2)) == 1) v = nextafter(v, v > 0 ? INFINITY : -INFINITY);
    char tmp[64];
    snprintf(tmp, sizeof tmp, "%.5f", v);
    char *dot = strchr(tmp, '.');
    if (dot) {
        char *end = tmp + strlen(tmp) - 1;
        while (end > dot && *end == '0') *end-- = 0;
        if (end == dot) *end = 0;
    }
    put(b, strcmp(tmp, "-0") == 0 ? "0" : tmp);
}
/* colorHex() for the '#rrggbb' the core gives parts: upper case, the default colour otherwise. */
static void put_color(Buf *b, const char *c) {
    int ok = c && c[0] == '#' && strlen(c) == 7;
    for (int i = 1; ok && i < 7; i++) ok = isxdigit((unsigned char)c[i]);
    char out[8] = "#8FB3FF";
    if (ok) for (int i = 1; i < 7; i++) out[i] = (char)toupper((unsigned char)c[i]);
    put(b, out);
}

void *temen_write_3mf(const TemenPart *parts, size_t n, size_t *out_len, const char **error) {
    set_error(error, NULL);
    if (out_len) *out_len = 0;
    Buf materials = {0}, objects = {0}, items = {0}, model = {0};
    char fallback[32];
    for (size_t i = 0; i < n; i++) {
        const TemenPart *p = &parts[i];
        const char *name = p->name;
        if (!name) { snprintf(fallback, sizeof fallback, "Part %zu", i + 1); name = fallback; }
        put(&materials, "<base name=\""); put_escaped(&materials, name); put(&materials, "\" displaycolor=\"");
        put_color(&materials, p->color); put(&materials, "\" />\n");
        if (i) put(&objects, "\n");
        putf(&objects, "<object id=\"%zu\" name=\"", i + 2);
        put_escaped(&objects, name);
        putf(&objects, "\" type=\"model\" pid=\"1\" pindex=\"%zu\">\n<mesh><vertices>\n", i);
        for (size_t k = 0; k < p->n_verts; k++) {
            const float *v = p->positions + k * 3;
            put(&objects, "<vertex x=\""); put_num(&objects, v[0]);
            put(&objects, "\" y=\""); put_num(&objects, -(double)v[2]);
            put(&objects, "\" z=\""); put_num(&objects, v[1]);
            put(&objects, k + 1 < p->n_verts ? "\" />\n" : "\" />");
        }
        put(&objects, "\n</vertices><triangles>\n");
        for (size_t t = 0; t < p->n_tris; t++)
            putf(&objects, t + 1 < p->n_tris ? "<triangle v1=\"%u\" v2=\"%u\" v3=\"%u\" />\n" : "<triangle v1=\"%u\" v2=\"%u\" v3=\"%u\" />",
                 p->indices[t * 3], p->indices[t * 3 + 1], p->indices[t * 3 + 2]);
        put(&objects, "\n</triangles></mesh></object>");
        putf(&items, i + 1 < n ? "<item objectid=\"%zu\" />\n" : "<item objectid=\"%zu\" />", i + 2);
    }
    /* materials.join('\n'): drop the last newline */
    if (!materials.failed && materials.len) materials.s[--materials.len] = 0;
    put(&model, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<model unit=\"millimeter\" xml:lang=\"en-US\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\n"
                "<metadata name=\"Application\">TemenCAD</metadata>\n<resources>\n<basematerials id=\"1\">\n");
    put(&model, materials.s ? materials.s : "");
    put(&model, "\n</basematerials>\n");
    put(&model, objects.s ? objects.s : "");
    put(&model, "\n</resources>\n<build>\n");
    put(&model, items.s ? items.s : "");
    put(&model, "\n</build>\n</model>\n");
    int failed = materials.failed || objects.failed || items.failed || model.failed;
    free(materials.s); free(objects.s); free(items.s);
    if (failed) { free(model.s); set_error(error, "out of memory"); return NULL; }

    static const char content_types[] =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n"
        "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\" />\n"
        "<Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\" />\n"
        "</Types>\n";
    static const char rels[] =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\n"
        "<Relationship Target=\"/3D/3dmodel.model\" Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\" />\n"
        "</Relationships>\n";
    TemenFile files[3] = {
        { "[Content_Types].xml", content_types, sizeof content_types - 1 },
        { "_rels/.rels", rels, sizeof rels - 1 },
        { "3D/3dmodel.model", model.s, model.len },
    };
    void *zip = temen_archive_write(files, 3, 6, out_len, error);
    free(model.s);
    return zip;
}
