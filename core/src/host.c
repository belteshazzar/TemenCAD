/*
 * The host: one lamassu VM, a module loader over the project's files, the
 * JavaScript prelude that defines the modelling API on top of the __cad
 * natives, and the run loop that turns a script's result into mesh buffers.
 *
 * Module layout mirrors src/modules.js of the browser app:
 *   - main.js is the entry (js_eval_entry): loaded as written, its top-level `return`
 *     hands back the parts, so its lines are the module's lines
 *   - every other script is loaded as it is; relative specifiers are resolved by the
 *     canonicalizer against the importing file
 *   - a font file is a module whose default export is its own name
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "compat.h"
#include "host.h"
#include "lamassu_compile.h"
#include "temencad.h"

#include "prelude_js.h"       /* generated from prelude.js at build time */

#define ENTRY "main.js"
#define PRELUDE_SPEC "temencad:prelude"

/* ---------------------------------------------------------------- strings */

uint16_t *temen_utf8_to_utf16(const char *s, size_t len, size_t *out_len) {
    uint16_t *out = malloc((len + 1) * sizeof *out); /* UTF-16 never needs more units than UTF-8 bytes */
    if (!out) return NULL;
    size_t n = 0;
    for (size_t i = 0; i < len;) {
        unsigned char c = (unsigned char)s[i];
        uint32_t cp;
        int extra;
        if (c < 0x80) { cp = c; extra = 0; }
        else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; extra = 1; }
        else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; extra = 2; }
        else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; extra = 3; }
        else { cp = 0xFFFD; extra = 0; }
        i++;
        for (int k = 0; k < extra; k++) {
            if (i >= len || ((unsigned char)s[i] & 0xC0) != 0x80) { cp = 0xFFFD; break; }
            cp = (cp << 6) | ((unsigned char)s[i] & 0x3F);
            i++;
        }
        if (cp >= 0x10000) {
            cp -= 0x10000;
            out[n++] = (uint16_t)(0xD800 + (cp >> 10));
            out[n++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
        } else out[n++] = (uint16_t)cp;
    }
    *out_len = n;
    return out;
}

char *temen_utf16_to_utf8(const uint16_t *u, size_t len) {
    char *out = malloc(len * 3 + 1);
    if (!out) return NULL;
    size_t n = 0;
    for (size_t i = 0; i < len; i++) {
        uint32_t cp = u[i];
        if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < len && u[i + 1] >= 0xDC00 && u[i + 1] < 0xE000) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (u[i + 1] - 0xDC00);
            i++;
        }
        if (cp < 0x80) out[n++] = (char)cp;
        else if (cp < 0x800) { out[n++] = (char)(0xC0 | (cp >> 6)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { out[n++] = (char)(0xE0 | (cp >> 12)); out[n++] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
        else { out[n++] = (char)(0xF0 | (cp >> 18)); out[n++] = (char)(0x80 | ((cp >> 12) & 0x3F)); out[n++] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
    }
    out[n] = 0;
    return out;
}

char *temen_value_to_utf8(TemenCore *core, JsValue v) {
    JsValue s = js_to_string(core->ctx, v);
    size_t n;
    const uint16_t *u = js_string_units(s, &n);
    if (!u) return strdup("");
    return temen_utf16_to_utf8(u, n);
}

JsValue temen_atom(TemenCore *core, const char *ascii) {
    uint16_t buf[256];
    size_t n = strlen(ascii);
    if (n > 256) n = 256;
    for (size_t i = 0; i < n; i++) buf[i] = (uint16_t)(unsigned char)ascii[i];
    return js_atom(core->vm, buf, n);
}

JsValue temen_string(TemenCore *core, const char *utf8, size_t len) {
    size_t n;
    uint16_t *u = temen_utf8_to_utf16(utf8, len, &n);
    if (!u) return js_undefined();
    JsValue s = js_string_new(core->vm, u, n);
    free(u);
    return s;
}

bool temen_object_set(TemenCore *core, JsValue obj, const char *name, JsValue value) {
    JsValue key = temen_atom(core, name);
    if (!js_is_string(key)) return false;
    js_gc_protect(core->vm, &key);
    js_gc_protect(core->vm, &value);
    bool ok = js_object_set(core->vm, obj, key, value);
    js_gc_unprotect(core->vm, &value);
    js_gc_unprotect(core->vm, &key);
    return ok;
}

/* Error values to throw from a native; the messages are ASCII or UTF-8 that happens to be ASCII (file names, numbers). */
JsValue temen_type_error(TemenCore *core, const char *msg) { return js_error_new_ascii(core->ctx, JS_ERROR_TYPE, msg); }
JsValue temen_range_error(TemenCore *core, const char *msg) { return js_error_new_ascii(core->ctx, JS_ERROR_RANGE, msg); }
JsValue temen_plain_error(TemenCore *core, const char *msg) {
    size_t n;
    uint16_t *u = temen_utf8_to_utf16(msg, strlen(msg), &n); /* file names in messages may not be ASCII */
    if (!u) return js_undefined();
    JsValue e = js_error_new_utf16(core->ctx, JS_ERROR_PLAIN, u, n);
    free(u);
    return e;
}

/* --------------------------------------------------------------- messages */

void temen_message(TemenCore *core, TemenMessageKind kind, const char *text, const char *file, int line) {
    if (core->message_fn) core->message_fn(core->message_ud, kind, text, file, line);
}

static void set_error(TemenCore *core, const char *msg, const char *file, int line) {
    free(core->error); free(core->error_file);
    core->error = strdup(msg);
    core->error_file = file ? strdup(file) : NULL;
    core->error_line = line;
}

/* ------------------------------------------------------------- promises */

static JsValue fulfilled(TemenCore *core, JsValue v) {
    js_gc_protect(core->vm, &v);
    JsValue p = js_promise_new(core->ctx);
    if (!js_is_undefined(p)) js_resolve(core->ctx, p, v);
    js_gc_unprotect(core->vm, &v);
    return p;
}

static JsValue rejected(TemenCore *core, const char *msg) {
    JsValue reason = temen_string(core, msg, strlen(msg));
    js_gc_protect(core->vm, &reason);
    JsValue p = js_promise_new(core->ctx);
    if (!js_is_undefined(p)) js_reject(core->ctx, p, reason);
    js_gc_unprotect(core->vm, &reason);
    return p;
}

/* ------------------------------------------------------- module loading */

static TemenHostFile *find_file(TemenCore *core, const char *name) {
    for (size_t i = 0; i < core->n_files; i++)
        if (strcmp(core->files[i].name, name) == 0) return &core->files[i];
    return NULL;
}

const TemenHostFile *temen_find_file(TemenCore *core, const char *name) { return find_file(core, name); }

/* Remember the source a module was compiled from, so an offset in it can become a line. */
static void remember_source(TemenHostFile *f, const char *utf8, size_t len) {
    free(f->src16);
    f->src16 = temen_utf8_to_utf16(utf8, len, &f->len16);
    f->user_lines = 1;
    for (size_t i = 0; i < f->len; i++) if (f->data[i] == '\n') f->user_lines++;
    if (f->len && f->data[f->len - 1] == '\n') f->user_lines--; /* a trailing newline is not a line */
    if (f->user_lines < 1) f->user_lines = 1;
}

bool temen_locate(TemenCore *core, const JsStackFrame *frames, size_t n, const char **file, int *line) {
    for (size_t i = 0; i < n; i++) {
        size_t sl;
        const uint16_t *su = js_string_units(frames[i].specifier, &sl);
        if (!su) continue;
        char *name = temen_utf16_to_utf8(su, sl);
        TemenHostFile *f = name ? find_file(core, name) : NULL;
        free(name);
        if (!f || !f->src16) continue;
        uint32_t l, c;
        js_source_line_col(f->src16, f->len16, frames[i].pos, &l, &c);
        int ln = (int)l;
        /* an error at the very end (an unterminated statement) can sit past a trailing newline: show the last line */
        if (ln > f->user_lines) ln = f->user_lines;
        *file = f->name;
        *line = ln < 1 ? 1 : ln;
        return true;
    }
    return false;
}

bool temen_where(TemenCore *core, const char **file, int *line) {
    JsStackFrame fr[JS_TRACE_MAX];
    size_t n = js_context_stack(core->ctx, fr, JS_TRACE_MAX);
    return temen_locate(core, fr, n, file, line);
}

static bool has_ext(const char *name, const char *ext) {
    size_t n = strlen(name), e = strlen(ext);
    if (n < e) return false;
    for (size_t i = 0; i < e; i++) {
        char a = name[n - e + i], b = ext[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (a != b) return false;
    }
    return true;
}
static bool is_script(const char *n) { return has_ext(n, ".js") || has_ext(n, ".mjs"); }
static bool is_font(const char *n) { return has_ext(n, ".ttf") || has_ext(n, ".otf"); }
static bool is_mesh(const char *n) { return has_ext(n, ".stl"); }
static bool is_image(const char *n) { return has_ext(n, ".png") || has_ext(n, ".jpg") || has_ext(n, ".jpeg"); }
static bool is_svg(const char *n) { return has_ext(n, ".svg"); }

/*
 * Resolve `spec` against `referrer` the way src/project.js resolveImport does:
 * "./x" and "../x" are relative to the referrer's folder, anything else is a
 * path from the project root. Segments "." and ".." are normalised.
 */
static size_t resolve_path(const char *spec, const char *referrer, char *out, size_t cap) {
    char joined[2048];
    if (spec[0] == '.' && (spec[1] == '/' || (spec[1] == '.' && spec[2] == '/'))) {
        const char *slash = strrchr(referrer, '/');
        size_t base = slash ? (size_t)(slash - referrer) : 0;
        if (base) snprintf(joined, sizeof joined, "%.*s/%s", (int)base, referrer, spec);
        else snprintf(joined, sizeof joined, "%s", spec);
    } else snprintf(joined, sizeof joined, "%s", spec);

    /* normalise segments */
    char *segs[256];
    int n = 0;
    char *save = NULL;
    for (char *tok = temen_strtok_r(joined, "/", &save); tok; tok = temen_strtok_r(NULL, "/", &save)) {
        if (strcmp(tok, ".") == 0 || *tok == 0) continue;
        if (strcmp(tok, "..") == 0) { if (n) n--; continue; }
        if (n < 256) segs[n++] = tok;
    }
    size_t len = 0;
    out[0] = 0;
    for (int i = 0; i < n; i++) {
        int w = snprintf(out + len, cap - len, "%s%s", i ? "/" : "", segs[i]);
        if (w < 0 || (size_t)w >= cap - len) break;
        len += (size_t)w;
    }
    return len;
}

static bool canonicalize(void *ud, const uint16_t *spec, size_t spec_len, const uint16_t *ref, size_t ref_len,
                         const uint16_t **out, size_t *out_len) {
    TemenCore *core = ud;
    char *s = temen_utf16_to_utf8(spec, spec_len);
    char *r = temen_utf16_to_utf8(ref, ref_len);
    if (!s || !r) { free(s); free(r); return false; }
    if (strchr(s, ':')) { /* temencad:prelude and the like: identity */
        size_t n = spec_len < 1024 ? spec_len : 1024;
        memcpy(core->canon_buf, spec, n * sizeof(uint16_t));
        *out = core->canon_buf; *out_len = n;
        free(s); free(r);
        return true;
    }
    char path[1024];
    size_t len = resolve_path(s, r, path, sizeof path);
    for (size_t i = 0; i < len; i++) core->canon_buf[i] = (uint16_t)(unsigned char)path[i];
    *out = core->canon_buf; *out_len = len;
    free(s); free(r);
    return true;
}

static JsValue loader(void *ud, JsContext *ctx, const uint16_t *spec, size_t spec_len,
                      const uint16_t *ref, size_t ref_len) {
    (void)ctx; (void)ref; (void)ref_len;
    TemenCore *core = ud;
    char *name = temen_utf16_to_utf8(spec, spec_len);
    if (!name) return rejected(core, "out of memory");
    JsValue result;
    if (strcmp(name, PRELUDE_SPEC) == 0) {
        result = fulfilled(core, temen_string(core, (const char *)temen_prelude_js, temen_prelude_js_len));
    } else {
        TemenHostFile *f = find_file(core, name);
        char msg[1200];
        if (!f) {
            snprintf(msg, sizeof msg, "Cannot find '%s'", name);
            result = rejected(core, msg);
        } else if (is_script(name)) {
            remember_source(f, (const char *)f->data, f->len);
            result = fulfilled(core, temen_string(core, (const char *)f->data, f->len));
        } else if (is_font(name)) {
            snprintf(msg, sizeof msg, "export default \"%s\";", name);
            result = fulfilled(core, temen_string(core, msg, strlen(msg)));
        } else if (is_mesh(name)) {
            /* the prelude's __temenMesh parses the STL (natively) into a Shape, as modules.js's loadMesh */
            snprintf(msg, sizeof msg, "export default __temenMesh(\"%s\");", name);
            result = fulfilled(core, temen_string(core, msg, strlen(msg)));
        } else if (is_image(name)) {
            snprintf(msg, sizeof msg, "export default __temenImage(\"%s\");", name);
            result = fulfilled(core, temen_string(core, msg, strlen(msg)));
        } else if (is_svg(name)) {
            /* the prelude's __temenSvg parses the drawing into a Sketch; `markup` is the file's text for svg(markup, opts) */
            snprintf(msg, sizeof msg, "export const markup = __temenText(\"%s\");\nexport default __temenSvg(\"%s\", markup);", name, name);
            result = fulfilled(core, temen_string(core, msg, strlen(msg)));
        } else {
            snprintf(msg, sizeof msg, "'%s' is not a script, font, mesh, image or SVG file", name);
            result = rejected(core, msg);
        }
    }
    free(name);
    return result;
}

/* ----------------------------------------------------------- lifecycle */

static bool load_prelude(TemenCore *core);

/*
 * The context is built once (natives, prelude) and kept for the life of the
 * core; each run evicts the previous project's modules from the engine's
 * registry (js_context_evict_module) so main.js loads afresh while the
 * prelude stays compiled. Rebuilt only if an eviction is refused.
 */
static bool fresh_context(TemenCore *core) {
    core->cad_ns = core->api_begin = core->api_run = core->slot_a = core->slot_b = core->slot_c = js_undefined();
    if (core->ctx) js_context_free(core->ctx);
    core->ctx = js_context_new(core->vm);
    core->prelude_loaded = false;
    if (!core->ctx) { set_error(core, "out of memory", NULL, 0); return false; }
    js_context_set_userdata(core->ctx, core);
    js_set_module_loader(core->ctx, loader, canonicalize, core);
    js_enable_source_modules(core->ctx);
    if (!temen_install_cad(core)) { set_error(core, "out of memory installing __cad", NULL, 0); return false; }
    return load_prelude(core);
}

TemenCore *temen_new(void) {
    TemenCore *core = calloc(1, sizeof *core);
    if (!core) return NULL;
    JsVmConfig cfg = {0};
    cfg.gc_stress = getenv("TEMEN_GC_STRESS") != NULL; /* collect at every safe point: shakes out unrooted values in the natives */
    const char *thr = getenv("TEMEN_GC_THRESHOLD"); /* bytes of engine + host memory before a collection (floor after each) */
    if (thr) cfg.gc_threshold = (size_t)strtoull(thr, NULL, 10);
    core->vm = js_vm_new(&cfg);
    if (!core->vm) { temen_free(core); return NULL; }
    core->cad_ns = core->api_begin = core->api_run = core->slot_a = core->slot_b = core->slot_c = js_undefined();
    js_gc_protect(core->vm, &core->cad_ns);
    js_gc_protect(core->vm, &core->api_begin);
    js_gc_protect(core->vm, &core->api_run);
    js_gc_protect(core->vm, &core->slot_a);
    js_gc_protect(core->vm, &core->slot_b);
    js_gc_protect(core->vm, &core->slot_c);
    if (!temen_fonts_init(core)) { temen_free(core); return NULL; }
    if (!fresh_context(core)) {
        if (core->error) fprintf(stderr, "temencore: %s\n", core->error);
        temen_free(core);
        return NULL;
    }
    return core;
}

static void free_parts(TemenCore *core) {
    for (size_t i = 0; i < core->n_parts; i++) {
        TemenPart *p = &core->parts[i];
        free((void *)p->name); free((void *)p->color); free((void *)p->positions); free((void *)p->indices);
    }
    core->n_parts = 0;
}

static void free_files(TemenCore *core) {
    for (size_t i = 0; i < core->n_files; i++) { free(core->files[i].name); free(core->files[i].src16); }
    free(core->files);
    core->files = NULL; core->n_files = 0;
}

void temen_free(TemenCore *core) {
    if (!core) return;
    free_parts(core);
    free(core->parts);
    free_files(core);
    temen_fonts_free(core);
    for (size_t i = 0; i < core->n_annotations; i++) free(core->annotations[i]);
    free(core->annotations);
    free(core->scratch_text); free(core->cut_positions); free(core->cut_indices);
    free((void *)core->profile.material);
    free(core->error); free(core->error_file);
    if (core->ctx) js_context_free(core->ctx);
    if (core->vm) js_vm_free(core->vm);
    free(core);
}

void temen_set_message_fn(TemenCore *core, TemenMessageFn fn, void *ud) { core->message_fn = fn; core->message_ud = ud; }
const char *temen_error(const TemenCore *core) { return core->error; }
const char *temen_error_file(const TemenCore *core) { return core->error_file; }
int temen_error_line(const TemenCore *core) { return core->error_line; }
size_t temen_part_count(const TemenCore *core) { return core->n_parts; }
const TemenPart *temen_part(const TemenCore *core, size_t i) { return i < core->n_parts ? &core->parts[i] : NULL; }
double temen_last_run_ms(const TemenCore *core) { return core->last_ms; }
const TemenProfile *temen_profile(const TemenCore *core) { return &core->profile; }
size_t temen_annotation_count(const TemenCore *core) { return core->n_annotations; }
const char *temen_annotation(const TemenCore *core, size_t i) { return i < core->n_annotations ? core->annotations[i] : NULL; }
const char *temen_version(void) { return "temencore 0.1 (lamassu-js, manifold " TEMEN_MANIFOLD_VERSION ")"; }

/* ---------------------------------------------------------------- run */

static double now_ms(void) { return temen_now_ms(); }

/* Waits for a promise by draining microtasks; the loader settles every promise synchronously. */
static int settle(TemenCore *core, JsValue promise) {
    js_run_jobs(core->ctx);
    return js_promise_state(promise);
}

/* The thrown value as a message, with the script location when the engine can tell us. */
static void report_rejection(TemenCore *core, JsValue reason) {
    char *text = temen_value_to_utf8(core, reason);
    const char *msg = text ? text : "error";
    /* assert() failures and plain throws are reported without an "Error:" prefix, like the browser runner */
    if (js_is_object(reason)) {
        JsValue name = js_object_get(core->vm, reason, temen_atom(core, "name"));
        if (js_is_string(name)) {
            char *n = temen_value_to_utf8(core, name);
            if (n && strcmp(n, "AssertionError") == 0) {
                JsValue m = js_object_get(core->vm, reason, temen_atom(core, "message"));
                free(text);
                text = temen_value_to_utf8(core, m);
                msg = text;
            }
            free(n);
        }
    }
    /* The engine's trace, innermost first; the first frame in one of the project's own files is
     * the line to show — frames inside the prelude (assert, argument checks) are skipped. */
    JsStackFrame fr[JS_TRACE_MAX];
    size_t n = js_context_error_stack(core->ctx, fr, JS_TRACE_MAX);
    const char *file = NULL;
    int line = 0;
    temen_locate(core, fr, n, &file, &line);
    set_error(core, msg, file, line);
    free(text);
}

static bool load_prelude(TemenCore *core) {
    uint16_t spec[32];
    size_t n = strlen(PRELUDE_SPEC);
    for (size_t i = 0; i < n; i++) spec[i] = (uint16_t)PRELUDE_SPEC[i];
    core->slot_a = js_eval_module(core->ctx, spec, n);
    if (settle(core, core->slot_a) != 1) {
        char *t = temen_value_to_utf8(core, js_promise_result(core->slot_a));
        char msg[512];
        uint32_t l = 0, c = 0;
        size_t pl;
        uint16_t *pu = temen_utf8_to_utf16((const char *)temen_prelude_js, temen_prelude_js_len, &pl);
        if (pu) { js_source_line_col(pu, pl, js_context_error_pos(core->ctx), &l, &c); free(pu); }
        snprintf(msg, sizeof msg, "prelude failed: %s (prelude.js:%u:%u)", t ? t : "?", l, c);
        free(t);
        set_error(core, msg, NULL, 0);
        return false;
    }
    JsValue ns = js_promise_result(core->slot_a);
    static const uint16_t run_name[] = { 'r', 'u', 'n' };
    static const uint16_t begin_name[] = { 'b', 'e', 'g', 'i', 'n' };
    static const uint16_t api_name[] = { 'a', 'p', 'i' };
    core->api_run = js_module_get_export(core->ctx, ns, run_name, 3);
    core->api_begin = js_module_get_export(core->ctx, ns, begin_name, 5);
    core->slot_b = js_module_get_export(core->ctx, ns, api_name, 3);
    if (!js_is_function(core->api_run) || !js_is_function(core->api_begin) || !js_is_object(core->slot_b)) { set_error(core, "prelude exports missing", NULL, 0); return false; }
    /* every api entry becomes a global, so scripts use box() and friends unqualified */
    JsValue globals = js_context_globals(core->ctx);
    size_t count = js_object_size(core->slot_b);
    for (size_t i = 0; i < count; i++) {
        JsValue key = js_object_key_at(core->slot_b, i);
        JsValue val = js_object_get(core->vm, core->slot_b, key);
        core->slot_c = val;
        if (!js_object_set(core->vm, globals, key, val)) { set_error(core, "out of memory installing the api", NULL, 0); return false; }
    }
    core->slot_a = core->slot_b = core->slot_c = js_undefined();
    core->prelude_loaded = true;
    return true;
}

/*
 * Forget last run's project modules so main.js and its imports load afresh, while the prelude
 * (temencad:prelude) stays compiled. Evicting a module takes its importers with it, so this loops
 * until only the prelude is left.
 */
static void evict_project_modules(TemenCore *core) {
    for (;;) {
        size_t n = js_context_module_count(core->ctx), i = 0;
        for (; i < n; i++) {
            size_t sl;
            const uint16_t *su = js_string_units(js_context_module_specifier(core->ctx, i), &sl);
            if (!su) continue;
            static const uint16_t prelude[] = { 't','e','m','e','n','c','a','d',':','p','r','e','l','u','d','e' };
            if (sl == 16 && memcmp(su, prelude, sizeof prelude) == 0) continue;
            if (!js_context_evict_module(core->ctx, su, sl)) { fresh_context(core); return; } /* in flight: start over */
            break;
        }
        if (i == n) return;
    }
}

/* Reads one part descriptor { h, name, named, color, ghost, hidden } into a TemenPart with its mesh. */
static bool collect_part(TemenCore *core, JsValue desc);

int temen_run(TemenCore *core, const TemenFile *files, size_t n_files) {
    double t0 = now_ms();
    free_parts(core);
    free_files(core);
    free(core->error); free(core->error_file);
    core->error = core->error_file = NULL; core->error_line = 0;
    free((void *)core->profile.material);
    memset(&core->profile, 0, sizeof core->profile);
    for (size_t i = 0; i < core->n_annotations; i++) free(core->annotations[i]);
    core->n_annotations = 0;

    core->files = calloc(n_files ? n_files : 1, sizeof *core->files);
    if (!core->files) { set_error(core, "out of memory", NULL, 0); return 2; }
    for (size_t i = 0; i < n_files; i++) {
        core->files[i].name = strdup(files[i].name);
        core->files[i].data = files[i].data;
        core->files[i].len = files[i].len;
    }
    core->n_files = n_files;
    temen_fonts_set_project(core, core->files, core->n_files);
    if (!find_file(core, ENTRY)) { set_error(core, "The project has no " ENTRY, NULL, 0); return 1; }

    if (!core->ctx) { if (!fresh_context(core)) return 2; }
    else evict_project_modules(core);

    int status = 0;
    JsValue out;
    /* the run's state is reset before any of the project's modules evaluate (their top level can show()) */
    if (!js_call(core->ctx, core->api_begin, js_undefined(), NULL, 0, &out)) { core->slot_c = out; report_rejection(core, out); status = 1; goto done; }
    static const uint16_t entry[] = { 'm', 'a', 'i', 'n', '.', 'j', 's' };
    /* main.js is the entry: its top-level `return` is what the promise fulfills with */
    core->slot_a = js_eval_entry(core->ctx, entry, 7);
    if (js_is_undefined(core->slot_a)) { set_error(core, "out of memory", NULL, 0); status = 2; goto done; }
    if (settle(core, core->slot_a) != 1) { report_rejection(core, js_promise_result(core->slot_a)); status = 1; goto done; }
    {
        JsValue returned = js_promise_result(core->slot_a);
        core->slot_b = returned;
        JsValue args[1] = { returned };
        if (!js_call(core->ctx, core->api_run, js_undefined(), args, 1, &out)) { core->slot_c = out; report_rejection(core, out); status = 1; goto done; }
        core->slot_c = out; /* the promise run() returns */
        if (!js_is_promise(out)) { set_error(core, "prelude run() did not return a promise", NULL, 0); status = 2; goto done; }
        if (settle(core, out) != 1) { report_rejection(core, js_promise_result(out)); status = 1; goto done; }
        JsValue res = js_promise_result(out);
        core->slot_a = res;
        JsValue list = js_object_get(core->vm, res, temen_atom(core, "parts"));
        uint32_t n = js_array_length(list);
        {   /* evaluate every part after one collection (they are rooted through res) */
            JsValue *hs = malloc((n ? n : 1) * sizeof *hs);
            if (!hs) { set_error(core, "out of memory", NULL, 0); status = 2; goto done; }
            for (uint32_t i = 0; i < n; i++) {
                JsValue d = js_array_get(list, i);
                hs[i] = js_is_object(d) ? js_object_get(core->vm, d, temen_atom(core, "h")) : js_undefined();
            }
            temen_settle(core, hs, n);
            free(hs);
        }
        for (uint32_t i = 0; i < n; i++) {
            if (!collect_part(core, js_array_get(list, i))) { status = 2; goto done; }
        }
        JsValue prof = js_object_get(core->vm, res, temen_atom(core, "profile"));
        if (js_is_object(prof)) {
            core->profile.declared = 1;
            core->profile.nozzle = js_get_number(js_object_get(core->vm, prof, temen_atom(core, "nozzle")));
            core->profile.layer = js_get_number(js_object_get(core->vm, prof, temen_atom(core, "layer")));
            core->profile.hole_compensation = js_get_number(js_object_get(core->vm, prof, temen_atom(core, "holeCompensation")));
            JsValue mat = js_object_get(core->vm, prof, temen_atom(core, "material"));
            core->profile.material = js_is_string(mat) ? temen_value_to_utf8(core, mat) : NULL;
        }
    }
done:
    core->slot_a = core->slot_b = core->slot_c = js_undefined();
    /* the run's geometry is garbage now except what modules still hold at top level: free it
     * (Manifold objects are released by their finalizers) rather than wait for the next build */
    js_gc_collect(core->vm);
    core->last_ms = now_ms() - t0;
    return status;
}

#include "manifold/manifoldc.h"

static bool collect_part(TemenCore *core, JsValue desc) {
    if (!js_is_object(desc)) return true;
    JsValue h = js_object_get(core->vm, desc, temen_atom(core, "h"));
    ManifoldManifold *m = temen_handle_get(core, h);
    if (!m) { set_error(core, "part descriptor has no shape", NULL, 0); return false; }
    if (core->n_parts == core->cap_parts) {
        size_t cap = core->cap_parts ? core->cap_parts * 2 : 8;
        TemenPart *np = realloc(core->parts, cap * sizeof *np);
        if (!np) { set_error(core, "out of memory", NULL, 0); return false; }
        core->parts = np; core->cap_parts = cap;
    }
    TemenPart *p = &core->parts[core->n_parts];
    memset(p, 0, sizeof *p);
    p->name = temen_value_to_utf8(core, js_object_get(core->vm, desc, temen_atom(core, "name")));
    p->color = temen_value_to_utf8(core, js_object_get(core->vm, desc, temen_atom(core, "color")));
    p->named = js_get_bool(js_object_get(core->vm, desc, temen_atom(core, "named")));
    p->ghost = js_get_bool(js_object_get(core->vm, desc, temen_atom(core, "ghost")));
    p->hidden = js_get_bool(js_object_get(core->vm, desc, temen_atom(core, "hidden")));
    p->volume = manifold_volume(m);

    ManifoldMeshGL *mesh = manifold_get_meshgl(malloc(manifold_meshgl_size()), m);
    size_t n_prop = manifold_meshgl_num_prop(mesh);
    size_t n_verts = manifold_meshgl_num_vert(mesh);
    size_t n_tris = manifold_meshgl_num_tri(mesh);
    float *props = malloc(manifold_meshgl_vert_properties_length(mesh) * sizeof(float));
    uint32_t *tris = malloc(manifold_meshgl_tri_length(mesh) * sizeof(uint32_t));
    if (!props || !tris) { free(props); free(tris); manifold_delete_meshgl(mesh); set_error(core, "out of memory", NULL, 0); return false; }
    manifold_meshgl_vert_properties(props, mesh);
    manifold_meshgl_tri_verts(tris, mesh);
    manifold_delete_meshgl(mesh);
    if (n_prop != 3) { /* keep xyz only */
        float *xyz = malloc(n_verts * 3 * sizeof(float));
        if (!xyz) { free(props); free(tris); set_error(core, "out of memory", NULL, 0); return false; }
        for (size_t i = 0; i < n_verts; i++) for (int k = 0; k < 3; k++) xyz[i * 3 + k] = props[i * n_prop + k];
        free(props);
        props = xyz;
    }
    p->positions = props; p->n_verts = n_verts;
    p->indices = tris; p->n_tris = n_tris;
    core->n_parts++;
    return true;
}
