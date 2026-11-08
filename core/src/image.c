/*
 * Project assets other than scripts and fonts: images and meshes.
 *
 *   decodeImage(name) -> { width, height, gray: [0..1, ...] }   PNG, JPEG (and what stb_image reads),
 *                        brightness = luminance composited onto white, as the app's GrayImage.fromRGBA
 *   parseSTL(name)    -> { positions: [x, y, z, ...], triangles: [...] }  binary or ASCII STL, vertices
 *                        welded by exact position, slicer Z-up turned into Y-up: (x, y, z) -> (x, z, -y)
 *
 * Decoding is stb_image (public domain). PNG decoding is exact, so reliefs built from PNGs match the
 * app bit for bit; JPEG decoders differ in rounding, so JPEG brightness can differ by a few 1/255.
 */
#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_STATIC
#define STBI_NO_STDIO
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#define STBI_ASSERT(x) ((void)0)
#include "stb_image.h"

#include "compat.h"
#include "host.h"

#define CORE() ((TemenCore *)js_context_userdata(ctx))
#define THROW(v) do { *result = (v); return false; } while (0)

static const TemenHostFile *named_file(JsContext *ctx, const JsValue *args, int argc, const char *fn, JsValue *result) {
    TemenCore *core = CORE();
    if (argc < 1 || !js_is_string(args[0])) { *result = temen_type_error(core, "__cad: expected a file name"); return NULL; }
    char *name = temen_value_to_utf8(core, args[0]);
    const TemenHostFile *f = name ? temen_find_file(core, name) : NULL;
    if (!f) {
        char msg[300];
        snprintf(msg, sizeof msg, "%s: no file \"%s\" in the project", fn, name ? name : "");
        *result = temen_plain_error(core, msg);
    }
    free(name);
    return f;
}

static bool push_numbers(TemenCore *core, JsValue arr, const double *v, size_t n) {
    for (size_t i = 0; i < n; i++) if (!js_array_push(core->vm, arr, js_number(v[i]))) return false;
    return true;
}

/* decodeImage(name) */
static bool n_decode_image(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    const TemenHostFile *f = named_file(ctx, args, argc, "image", result);
    if (!f) return false;
    int w = 0, h = 0, comp = 0;
    unsigned char *rgba = stbi_load_from_memory(f->data, (int)f->len, &w, &h, &comp, 4);
    if (!rgba) {
        char msg[300];
        snprintf(msg, sizeof msg, "Cannot read image %s: %s", f->name, stbi_failure_reason());
        THROW(temen_plain_error(core, msg));
    }
    size_t n = (size_t)w * (size_t)h;
    double *gray = malloc((n ? n : 1) * sizeof *gray);
    if (!gray) { stbi_image_free(rgba); THROW(temen_range_error(core, "out of memory")); }
    for (size_t i = 0; i < n; i++) {
        const unsigned char *p = rgba + i * 4;
        /* float arithmetic in the same order as GrayImage.fromRGBA, stored as the float32 the app keeps */
        float a = p[3] / 255.0f;
        float lum = (0.2126f * p[0] + 0.7152f * p[1] + 0.0722f * p[2]) / 255.0f;
        gray[i] = (float)(lum * a + (1 - a));
    }
    stbi_image_free(rgba);
    JsValue obj = js_object_new(ctx), arr = js_array_new(ctx, (uint32_t)n);
    bool ok = !js_is_undefined(obj) && !js_is_undefined(arr);
    js_gc_protect(core->vm, &obj); js_gc_protect(core->vm, &arr);
    if (ok) ok = push_numbers(core, arr, gray, n);
    if (ok) ok = js_object_set(core->vm, obj, temen_atom(core, "width"), js_number(w)) && js_object_set(core->vm, obj, temen_atom(core, "height"), js_number(h)) && js_object_set(core->vm, obj, temen_atom(core, "gray"), arr);
    js_gc_unprotect(core->vm, &arr); js_gc_unprotect(core->vm, &obj);
    free(gray);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = obj;
    return true;
}

/* ---- STL ---- */

static float rd_f32(const uint8_t *p) { uint32_t u = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); float f; memcpy(&f, &u, 4); return f; }
static uint32_t rd_u32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }

/* The raw triangle vertices (9 floats per facet), binary or ASCII. */
static float *stl_raw(const TemenHostFile *f, size_t *n_floats, const char **err) {
    const uint8_t *b = f->data;
    size_t len = f->len;
    bool ascii = false;
    {
        size_t i = 0;
        while (i < len && isspace(b[i])) i++;
        if (i + 5 <= len && temen_strncasecmp((const char *)b + i, "solid", 5) == 0) {
            bool binary = len >= 84 && len == 84 + (size_t)rd_u32(b + 80) * 50;
            ascii = !binary;
        }
    }
    if (!ascii) {
        if (len < 84) { *err = "STL file is truncated"; return NULL; }
        uint32_t n = rd_u32(b + 80);
        if (len < 84 + (size_t)n * 50) { *err = "STL file is truncated"; return NULL; }
        float *out = malloc(((size_t)n * 9 + 1) * sizeof *out);
        if (!out) { *err = "out of memory"; return NULL; }
        for (uint32_t t = 0; t < n; t++) for (int k = 0; k < 9; k++) out[t * 9 + k] = rd_f32(b + 84 + t * 50 + 12 + k * 4);
        *n_floats = (size_t)n * 9;
        return out;
    }
    /* ASCII: every "vertex x y z" */
    size_t cap = 1024, n = 0;
    float *out = malloc(cap * sizeof *out);
    if (!out) { *err = "out of memory"; return NULL; }
    const char *s = (const char *)b, *end = s + len;
    while (s < end) {
        const char *v = temen_memmem(s, (size_t)(end - s), "vertex", 6);
        if (!v) break;
        s = v + 6;
        if (n + 3 > cap) { cap *= 2; float *o = realloc(out, cap * sizeof *o); if (!o) { free(out); *err = "out of memory"; return NULL; } out = o; }
        char *q = (char *)s;
        for (int k = 0; k < 3; k++) { out[n++] = strtof(q, &q); }
        s = q;
    }
    if (n % 9) { free(out); *err = "ASCII STL has an incomplete facet"; return NULL; }
    *n_floats = n;
    return out;
}

/* parseSTL(name) */
static bool n_parse_stl(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    const TemenHostFile *f = named_file(ctx, args, argc, "mesh", result);
    if (!f) return false;
    const char *err = NULL;
    size_t nf = 0;
    float *raw = stl_raw(f, &nf, &err);
    if (!raw) THROW(temen_plain_error(core, err));
    size_t nv = nf / 3;
    /* weld by exact position with a hash table; Z-up -> Y-up */
    size_t cap = 1; while (cap < nv * 2) cap <<= 1;
    int32_t *slots = malloc(cap * sizeof *slots);
    double *pos = malloc((nv * 3 + 1) * sizeof *pos);
    double *tri = malloc((nv + 1) * sizeof *tri);
    if (!slots || !pos || !tri) { free(raw); free(slots); free(pos); free(tri); THROW(temen_range_error(core, "out of memory")); }
    for (size_t i = 0; i < cap; i++) slots[i] = -1;
    size_t np = 0;
    for (size_t i = 0; i < nv; i++) {
        float x = raw[i * 3], y = raw[i * 3 + 2], z = -raw[i * 3 + 1];
        uint32_t ux, uy, uz; memcpy(&ux, &x, 4); memcpy(&uy, &y, 4); memcpy(&uz, &z, 4);
        uint64_t hsh = (ux * 0x9E3779B1u) ^ ((uint64_t)uy * 0x85EBCA77u << 1) ^ ((uint64_t)uz * 0xC2B2AE3Du << 2);
        size_t s = (size_t)(hsh & (cap - 1));
        int32_t id = -1;
        for (;;) {
            int32_t cand = slots[s];
            if (cand < 0) break;
            if ((float)pos[cand * 3] == x && (float)pos[cand * 3 + 1] == y && (float)pos[cand * 3 + 2] == z) { id = cand; break; }
            s = (s + 1) & (cap - 1);
        }
        if (id < 0) { id = (int32_t)np; slots[s] = id; pos[np * 3] = x; pos[np * 3 + 1] = y; pos[np * 3 + 2] = z; np++; }
        tri[i] = id;
    }
    free(raw); free(slots);
    JsValue obj = js_object_new(ctx), parr = js_array_new(ctx, (uint32_t)(np * 3)), tarr = js_array_new(ctx, (uint32_t)nv);
    bool ok = !js_is_undefined(obj) && !js_is_undefined(parr) && !js_is_undefined(tarr);
    js_gc_protect(core->vm, &obj); js_gc_protect(core->vm, &parr); js_gc_protect(core->vm, &tarr);
    if (ok) ok = push_numbers(core, parr, pos, np * 3) && push_numbers(core, tarr, tri, nv);
    if (ok) ok = js_object_set(core->vm, obj, temen_atom(core, "positions"), parr) && js_object_set(core->vm, obj, temen_atom(core, "triangles"), tarr);
    js_gc_unprotect(core->vm, &tarr); js_gc_unprotect(core->vm, &parr); js_gc_unprotect(core->vm, &obj);
    free(pos); free(tri);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = obj;
    return true;
}

bool temen_install_assets(TemenCore *core, JsValue ns) {
    static const struct { const char *name; JsNativeFn fn; } entries[] = { { "decodeImage", n_decode_image }, { "parseSTL", n_parse_stl } };
    for (size_t i = 0; i < sizeof entries / sizeof entries[0]; i++) {
        JsValue fn = js_native_new(core->ctx, entries[i].name, entries[i].fn, NULL);
        if (js_is_undefined(fn)) return false;
        core->slot_a = fn;
        if (!js_object_set(core->vm, ns, temen_atom(core, entries[i].name), fn)) return false;
    }
    return true;
}
