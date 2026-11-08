/*
 * Text outlines from fonts, replacing opentype.js: the bundled fonts are embedded at build time,
 * project fonts (.ttf/.otf files) are registered for the run, and textOutlines() lays out a string
 * the way opentype.js's getPath does (advance, kerning, letterSpacing * size) and flattens the glyph
 * curves into rings in sketch units (y up, baseline y = 0).
 *
 * Parsing is stb_truetype (public domain): TrueType and CFF outlines, cmap lookup, hmtx advances,
 * kerning from GPOS pair adjustment or the kern table. Not covered, unlike opentype.js: GSUB
 * ligatures ('liga'), which opentype.js applies to Latin text by default — "fi" stays two glyphs here.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define STB_TRUETYPE_IMPLEMENTATION
#define STBTT_STATIC
#define STBTT_ifloor(x) ((int)floor(x))
#define STBTT_iceil(x) ((int)ceil(x))
#define STBTT_sqrt(x) sqrt(x)
#define STBTT_pow(x, y) pow(x, y)
#define STBTT_fmod(x, y) fmod(x, y)
#define STBTT_cos(x) cos(x)
#define STBTT_acos(x) acos(x)
#define STBTT_fabs(x) fabs(x)
#define STBTT_assert(x) ((void)0)
#include "stb_truetype.h"

#include "host.h"
#include "js_bytecode.h"
#include "fonts_gen.h" /* the bundled fonts: TEMEN_BUNDLED_FONTS[] of { name, bytes, len } */

#define CORE() ((TemenCore *)js_context_userdata(ctx))
#define NUM(i) (((i) < argc && js_is_number(args[i])) ? js_get_number(args[i]) : 0.0)
#define THROW(v) do { *result = (v); return false; } while (0)

/* 'Inter Bold', 'inter-bold' and 'InterBold' are the same font: lower case, no spaces, hyphens or underscores */
static void font_key(const char *name, char *out, size_t cap) {
    size_t n = 0;
    for (const char *p = name; *p && n + 1 < cap; p++) {
        if (*p == ' ' || *p == '-' || *p == '_' || *p == '\t') continue;
        out[n++] = (char)(*p >= 'A' && *p <= 'Z' ? *p - 'A' + 'a' : *p);
    }
    out[n] = 0;
}

static TemenFont *find_font(TemenCore *core, const char *name) {
    char k[256];
    font_key(name, k, sizeof k);
    for (size_t i = 0; i < core->n_fonts; i++) if (strcmp(core->fonts[i].key, k) == 0) return &core->fonts[i];
    return NULL;
}

static bool add_font(TemenCore *core, const char *name, const uint8_t *data, size_t len, bool project) {
    char k[256];
    font_key(name, k, sizeof k);
    for (size_t i = 0; i < core->n_fonts; i++) if (strcmp(core->fonts[i].key, k) == 0) { core->fonts[i].data = data; core->fonts[i].len = len; core->fonts[i].parsed = false; core->fonts[i].project = project; return true; }
    if (core->n_fonts == core->cap_fonts) {
        size_t cap = core->cap_fonts ? core->cap_fonts * 2 : 8;
        TemenFont *n = realloc(core->fonts, cap * sizeof *n);
        if (!n) return false;
        core->fonts = n; core->cap_fonts = cap;
    }
    TemenFont *f = &core->fonts[core->n_fonts++];
    memset(f, 0, sizeof *f);
    f->name = strdup(name);
    snprintf(f->key, sizeof f->key, "%s", k);
    f->data = data; f->len = len; f->project = project;
    return f->name != NULL;
}

bool temen_fonts_init(TemenCore *core) {
    for (size_t i = 0; i < TEMEN_BUNDLED_FONT_COUNT; i++)
        if (!add_font(core, TEMEN_BUNDLED_FONTS[i].name, TEMEN_BUNDLED_FONTS[i].bytes, TEMEN_BUNDLED_FONTS[i].len, false)) return false;
    return true;
}

/* Project fonts come and go with the run; the bundled ones stay. */
void temen_fonts_set_project(TemenCore *core, const TemenHostFile *files, size_t n_files) {
    size_t keep = 0;
    for (size_t i = 0; i < core->n_fonts; i++) {
        if (core->fonts[i].project) { free(core->fonts[i].name); free(core->fonts[i].info); continue; }
        core->fonts[keep++] = core->fonts[i];
    }
    core->n_fonts = keep;
    for (size_t i = 0; i < n_files; i++) {
        const char *n = files[i].name;
        size_t l = strlen(n);
        if (l > 4 && (strcasecmp(n + l - 4, ".ttf") == 0 || strcasecmp(n + l - 4, ".otf") == 0)) add_font(core, n, files[i].data, files[i].len, true);
    }
}

void temen_fonts_free(TemenCore *core) {
    for (size_t i = 0; i < core->n_fonts; i++) { free(core->fonts[i].name); free(core->fonts[i].info); }
    free(core->fonts);
    core->fonts = NULL; core->n_fonts = core->cap_fonts = 0;
}

static stbtt_fontinfo *font_info(TemenFont *f) {
    if (f->parsed) return f->info;
    if (!f->info) f->info = calloc(1, sizeof(stbtt_fontinfo));
    if (!f->info) return NULL;
    int off = stbtt_GetFontOffsetForIndex(f->data, 0);
    if (off < 0 || !stbtt_InitFont(f->info, f->data, off)) { free(f->info); f->info = NULL; return NULL; }
    f->parsed = true;
    return f->info;
}

/* ---- rings ---- */

typedef struct { double *pts; size_t n, cap; } Ring;
typedef struct { Ring *rings; size_t n, cap; } Rings;

static bool ring_push(Ring *r, double x, double y) {
    if (r->n + 2 > r->cap) {
        size_t cap = r->cap ? r->cap * 2 : 64;
        double *p = realloc(r->pts, cap * sizeof *p);
        if (!p) return false;
        r->pts = p; r->cap = cap;
    }
    r->pts[r->n++] = x; r->pts[r->n++] = y;
    return true;
}
static Ring *rings_open(Rings *rs) {
    if (rs->n == rs->cap) {
        size_t cap = rs->cap ? rs->cap * 2 : 16;
        Ring *r = realloc(rs->rings, cap * sizeof *r);
        if (!r) return NULL;
        rs->rings = r; rs->cap = cap;
    }
    Ring *r = &rs->rings[rs->n++];
    memset(r, 0, sizeof *r);
    return r;
}
static void rings_free(Rings *rs) { for (size_t i = 0; i < rs->n; i++) free(rs->rings[i].pts); free(rs->rings); }

/* De Casteljau, `steps` points after the start (fonts.js bezier()) */
static bool flatten(Ring *r, const double *ctrl, int order, int steps) {
    for (int i = 1; i <= steps; i++) {
        double t = (double)i / steps;
        double p[8];
        memcpy(p, ctrl, (size_t)order * 2 * sizeof(double));
        for (int m = order; m > 1; m--)
            for (int k = 0; k < m - 1; k++) { p[k * 2] += (p[(k + 1) * 2] - p[k * 2]) * t; p[k * 2 + 1] += (p[(k + 1) * 2 + 1] - p[k * 2 + 1]) * t; }
        if (!ring_push(r, p[0], p[1])) return false;
    }
    return true;
}

/* Append a glyph's outline at x offset `dx`, scaled; glyph y is up already (font units) */
static bool glyph_rings(stbtt_fontinfo *info, int glyph, double dx, double scale, int steps, Rings *out) {
    stbtt_vertex *v = NULL;
    int n = stbtt_GetGlyphShape(info, glyph, &v);
    Ring *r = NULL;
    double cx = 0, cy = 0;
    bool ok = true;
    for (int i = 0; i < n && ok; i++) {
        double x = dx + v[i].x * scale, y = v[i].y * scale;
        switch (v[i].type) {
        case STBTT_vmove: r = rings_open(out); ok = r && ring_push(r, x, y); break;
        case STBTT_vline: ok = r && ring_push(r, x, y); break;
        case STBTT_vcurve: { double c[6] = { cx, cy, dx + v[i].cx * scale, v[i].cy * scale, x, y }; ok = r && flatten(r, c, 3, steps); break; }
        case STBTT_vcubic: { double c[8] = { cx, cy, dx + v[i].cx * scale, v[i].cy * scale, dx + v[i].cx1 * scale, v[i].cy1 * scale, x, y }; ok = r && flatten(r, c, 4, steps); break; }
        default: break;
        }
        cx = x; cy = y;
    }
    stbtt_FreeShape(info, v);
    return ok;
}

/* ---- natives ---- */

/* textOutlines(str, font, size, align, letterSpacing, kerning, curveSegments) -> { rings: [[[x, y], ...]], width } */
static bool n_text_outlines(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val;
    TemenCore *core = CORE();
    if (argc < 7 || !js_is_string(args[0]) || !js_is_string(args[1])) THROW(temen_type_error(core, "__cad.textOutlines: bad arguments"));
    char *fname = temen_value_to_utf8(core, args[1]);
    TemenFont *f = fname ? find_font(core, fname) : NULL;
    if (!f) {
        char msg[512]; size_t n = 0;
        n += (size_t)snprintf(msg, sizeof msg, "Unknown font \"%s\". Available: ", fname ? fname : "");
        for (size_t i = 0; i < core->n_fonts && n < sizeof msg - 1; i++) n += (size_t)snprintf(msg + n, sizeof msg - n, "%s%s", i ? ", " : "", core->fonts[i].name);
        free(fname);
        THROW(error_plain(core, msg));
    }
    free(fname);
    stbtt_fontinfo *info = font_info(f);
    if (!info) THROW(temen_range_error(core, "font file could not be parsed"));

    double size = NUM(2);
    int align = (int)NUM(3); /* 0 left, 1 centre, 2 right */
    double letter_spacing = NUM(4);
    bool kerning = NUM(5) != 0;
    int steps = (int)NUM(6);
    if (steps < 1) steps = 1;
    double scale = stbtt_ScaleForMappingEmToPixels(info, (float)size);

    /* codepoints -> glyphs */
    size_t slen;
    const uint16_t *su = js_string_units(args[0], &slen);
    int *glyphs = malloc((slen + 1) * sizeof *glyphs);
    if (!glyphs) THROW(temen_range_error(core, "out of memory"));
    size_t ng = 0;
    for (size_t i = 0; i < slen; i++) {
        uint32_t cp = su[i];
        if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < slen && su[i + 1] >= 0xDC00 && su[i + 1] < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (su[i + 1] - 0xDC00); i++; }
        glyphs[ng++] = stbtt_FindGlyphIndex(info, (int)cp);
    }
    /* layout as opentype.js forEachGlyph: advance, then kerning to the next glyph, then letterSpacing * size */
    double width = 0;
    for (size_t i = 0; i < ng; i++) {
        int adv, lsb;
        stbtt_GetGlyphHMetrics(info, glyphs[i], &adv, &lsb);
        width += adv * scale;
        if (kerning && i + 1 < ng) width += stbtt_GetGlyphKernAdvance(info, glyphs[i], glyphs[i + 1]) * scale;
        if (letter_spacing != 0) width += letter_spacing * size;
    }
    double x = align == 1 ? -width / 2 : align == 2 ? -width : 0;
    Rings rs = {0};
    bool ok = true;
    for (size_t i = 0; i < ng && ok; i++) {
        ok = glyph_rings(info, glyphs[i], x, scale, steps, &rs);
        int adv, lsb;
        stbtt_GetGlyphHMetrics(info, glyphs[i], &adv, &lsb);
        x += adv * scale;
        if (kerning && i + 1 < ng) x += stbtt_GetGlyphKernAdvance(info, glyphs[i], glyphs[i + 1]) * scale;
        if (letter_spacing != 0) x += letter_spacing * size;
    }
    free(glyphs);
    if (!ok) { rings_free(&rs); THROW(temen_range_error(core, "out of memory")); }

    /* -> JS: drop a closing duplicate point and rings with fewer than 3 points, as fonts.js does */
    JsValue obj = js_object_new(ctx), arr = js_array_new(ctx, (uint32_t)rs.n);
    ok = !js_is_undefined(obj) && !js_is_undefined(arr);
    js_gc_protect(core->vm, &obj); js_gc_protect(core->vm, &arr);
    for (size_t i = 0; i < rs.n && ok; i++) {
        Ring *r = &rs.rings[i];
        size_t np = r->n / 2;
        if (np > 1 && r->pts[0] == r->pts[(np - 1) * 2] && r->pts[1] == r->pts[(np - 1) * 2 + 1]) np--;
        if (np < 3) continue;
        JsValue ring = js_array_new(ctx, (uint32_t)np);
        if (js_is_undefined(ring)) { ok = false; break; }
        js_gc_protect(core->vm, &ring);
        for (size_t k = 0; k < np && ok; k++) {
            JsValue pt = js_array_new(ctx, 2);
            if (js_is_undefined(pt)) { ok = false; break; }
            js_gc_protect(core->vm, &pt);
            ok = js_array_push(core->vm, pt, js_number(r->pts[k * 2])) && js_array_push(core->vm, pt, js_number(r->pts[k * 2 + 1])) && js_array_push(core->vm, ring, pt);
            js_gc_unprotect(core->vm, &pt);
        }
        if (ok) ok = js_array_push(core->vm, arr, ring);
        js_gc_unprotect(core->vm, &ring);
    }
    if (ok) ok = js_object_set(core->vm, obj, temen_atom(core, "rings"), arr) && js_object_set(core->vm, obj, temen_atom(core, "width"), js_number(width));
    js_gc_unprotect(core->vm, &arr); js_gc_unprotect(core->vm, &obj);
    rings_free(&rs);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = obj;
    return true;
}

/* fontNames() -> ['Inter', ...] bundled and project fonts */
static bool n_font_names(JsContext *ctx, JsValue this_val, const JsValue *args, int argc, JsValue *result) {
    (void)this_val; (void)args; (void)argc;
    TemenCore *core = CORE();
    JsValue arr = js_array_new(ctx, (uint32_t)core->n_fonts);
    if (js_is_undefined(arr)) THROW(temen_range_error(core, "out of memory"));
    js_gc_protect(core->vm, &arr);
    bool ok = true;
    for (size_t i = 0; i < core->n_fonts && ok; i++) ok = js_array_push(core->vm, arr, temen_string(core, core->fonts[i].name, strlen(core->fonts[i].name)));
    js_gc_unprotect(core->vm, &arr);
    if (!ok) THROW(temen_range_error(core, "out of memory"));
    *result = arr;
    return true;
}

bool temen_install_text(TemenCore *core, JsValue ns) {
    static const struct { const char *name; JsNativeFn fn; } entries[] = { { "textOutlines", n_text_outlines }, { "fontNames", n_font_names } };
    for (size_t i = 0; i < sizeof entries / sizeof entries[0]; i++) {
        JsValue fn = js_native_new(core->ctx, entries[i].name, entries[i].fn, NULL);
        if (js_is_undefined(fn)) return false;
        core->slot_a = fn;
        if (!js_object_set(core->vm, ns, temen_atom(core, entries[i].name), fn)) return false;
    }
    return true;
}
