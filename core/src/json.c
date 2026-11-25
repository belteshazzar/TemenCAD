#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "json.h"

typedef struct { const char *s, *end, *start; char *err; size_t err_size; int failed; } Parser;

static int fail(Parser *p, const char *what) {
    if (!p->failed) {
        p->failed = 1;
        snprintf(p->err, p->err_size, "%s at byte %zu", what, (size_t)(p->s - p->start));
    }
    return 0;
}

static void ws(Parser *p) { while (p->s < p->end && (*p->s == ' ' || *p->s == '\t' || *p->s == '\n' || *p->s == '\r')) p->s++; }

typedef struct { char *b; size_t n, cap; } Buf;
static int put(Buf *b, const char *s, size_t n) {
    if (b->n + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 64;
        while (b->n + n + 1 > cap) cap *= 2;
        char *nb = realloc(b->b, cap);
        if (!nb) return 0;
        b->b = nb; b->cap = cap;
    }
    memcpy(b->b + b->n, s, n);
    b->n += n;
    b->b[b->n] = 0;
    return 1;
}
static int putc8(Buf *b, unsigned cp) {
    char t[4]; size_t k = 0;
    if (cp < 0x80) t[k++] = (char)cp;
    else if (cp < 0x800) { t[k++] = (char)(0xc0 | cp >> 6); t[k++] = (char)(0x80 | (cp & 63)); }
    else if (cp < 0x10000) { t[k++] = (char)(0xe0 | cp >> 12); t[k++] = (char)(0x80 | ((cp >> 6) & 63)); t[k++] = (char)(0x80 | (cp & 63)); }
    else { t[k++] = (char)(0xf0 | cp >> 18); t[k++] = (char)(0x80 | ((cp >> 12) & 63)); t[k++] = (char)(0x80 | ((cp >> 6) & 63)); t[k++] = (char)(0x80 | (cp & 63)); }
    return put(b, t, k);
}

static int hex4(Parser *p, unsigned *out) {
    if (p->end - p->s < 4) return fail(p, "short \\u escape");
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        char c = p->s[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if ((c | 32) >= 'a' && (c | 32) <= 'f') v |= (unsigned)((c | 32) - 'a' + 10);
        else return fail(p, "bad \\u escape");
    }
    p->s += 4;
    *out = v;
    return 1;
}

static int string(Parser *p, char **out, size_t *out_len) {
    p->s++; /* the opening quote */
    Buf b = { 0 };
    if (!put(&b, "", 0)) return fail(p, "out of memory");
    for (;;) {
        const char *run = p->s;
        while (p->s < p->end && *p->s != '"' && *p->s != '\\' && (unsigned char)*p->s >= 0x20) p->s++;
        if (p->s > run && !put(&b, run, (size_t)(p->s - run))) { free(b.b); return fail(p, "out of memory"); }
        if (p->s >= p->end) { free(b.b); return fail(p, "unterminated string"); }
        char c = *p->s;
        if (c == '"') { p->s++; break; }
        if ((unsigned char)c < 0x20) { free(b.b); return fail(p, "control character in string"); }
        p->s++; /* backslash */
        if (p->s >= p->end) { free(b.b); return fail(p, "unterminated string"); }
        char e = *p->s++;
        const char *lit = NULL;
        switch (e) {
        case '"': lit = "\""; break; case '\\': lit = "\\"; break; case '/': lit = "/"; break;
        case 'b': lit = "\b"; break; case 'f': lit = "\f"; break; case 'n': lit = "\n"; break;
        case 'r': lit = "\r"; break; case 't': lit = "\t"; break;
        case 'u': {
            unsigned cp;
            if (!hex4(p, &cp)) { free(b.b); return 0; }
            if (cp >= 0xd800 && cp < 0xdc00) { /* a high surrogate: a low one should follow */
                unsigned lo;
                if (p->end - p->s >= 6 && p->s[0] == '\\' && p->s[1] == 'u') {
                    const char *save = p->s;
                    p->s += 2;
                    if (!hex4(p, &lo)) { free(b.b); return 0; }
                    if (lo >= 0xdc00 && lo < 0xe000) cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                    else { p->s = save; cp = 0xfffd; }
                } else cp = 0xfffd;
            } else if (cp >= 0xdc00 && cp < 0xe000) cp = 0xfffd;
            if (!putc8(&b, cp)) { free(b.b); return fail(p, "out of memory"); }
            continue;
        }
        default: free(b.b); return fail(p, "bad escape");
        }
        if (!put(&b, lit, 1)) { free(b.b); return fail(p, "out of memory"); }
    }
    *out = b.b;
    *out_len = b.n;
    return 1;
}

static int value(Parser *p, JNode *v, int depth);

static int grow(Parser *p, JNode *v, int obj) {
    if (v->n < v->cap) return 1;
    size_t cap = v->cap ? v->cap * 2 : 4;
    JNode *items = realloc(v->items, cap * sizeof *items);
    if (!items) return fail(p, "out of memory");
    v->items = items;
    if (obj) {
        char **keys = realloc(v->keys, cap * sizeof *keys);
        if (!keys) return fail(p, "out of memory");
        v->keys = keys;
        size_t *lens = realloc(v->key_lens, cap * sizeof *lens);
        if (!lens) return fail(p, "out of memory");
        v->key_lens = lens;
    }
    v->cap = cap;
    return 1;
}

static int container(Parser *p, JNode *v, int depth, int obj) {
    v->kind = obj ? JN_OBJ : JN_ARR;
    p->s++;
    ws(p);
    if (p->s < p->end && *p->s == (obj ? '}' : ']')) { p->s++; return 1; }
    for (;;) {
        if (!grow(p, v, obj)) return 0;
        if (obj) {
            ws(p);
            if (p->s >= p->end || *p->s != '"') return fail(p, "expected a key");
            if (!string(p, &v->keys[v->n], &v->key_lens[v->n])) return 0;
            ws(p);
            if (p->s >= p->end || *p->s != ':') { free(v->keys[v->n]); return fail(p, "expected ':'"); }
            p->s++;
        }
        memset(&v->items[v->n], 0, sizeof v->items[v->n]);
        int ok = value(p, &v->items[v->n], depth + 1);
        v->n++; /* counted even when it failed, so json_free releases what it holds */
        if (!ok) return 0;
        ws(p);
        if (p->s < p->end && *p->s == ',') { p->s++; continue; }
        if (p->s < p->end && *p->s == (obj ? '}' : ']')) { p->s++; return 1; }
        return fail(p, obj ? "expected ',' or '}'" : "expected ',' or ']'");
    }
}

static int number(Parser *p, JNode *v) {
    const char *s = p->s;
    if (p->s < p->end && *p->s == '-') p->s++;
    if (p->s >= p->end) return fail(p, "bad number");
    if (*p->s == '0') p->s++;
    else if (*p->s >= '1' && *p->s <= '9') while (p->s < p->end && *p->s >= '0' && *p->s <= '9') p->s++;
    else return fail(p, "unexpected character");
    if (p->s < p->end && *p->s == '.') {
        p->s++;
        if (p->s >= p->end || *p->s < '0' || *p->s > '9') return fail(p, "bad number");
        while (p->s < p->end && *p->s >= '0' && *p->s <= '9') p->s++;
    }
    if (p->s < p->end && (*p->s == 'e' || *p->s == 'E')) {
        p->s++;
        if (p->s < p->end && (*p->s == '+' || *p->s == '-')) p->s++;
        if (p->s >= p->end || *p->s < '0' || *p->s > '9') return fail(p, "bad number");
        while (p->s < p->end && *p->s >= '0' && *p->s <= '9') p->s++;
    }
    v->kind = JN_NUM;
    v->len = (size_t)(p->s - s);
    v->str = malloc(v->len + 1);
    if (!v->str) return fail(p, "out of memory");
    memcpy(v->str, s, v->len);
    v->str[v->len] = 0;
    return 1;
}

static int word(Parser *p, const char *w, JNKind kind, JNode *v) {
    size_t n = strlen(w);
    if ((size_t)(p->end - p->s) < n || memcmp(p->s, w, n)) return fail(p, "unexpected character");
    p->s += n;
    v->kind = kind;
    return 1;
}

static int value(Parser *p, JNode *v, int depth) {
    if (depth > 512) return fail(p, "nested too deeply");
    ws(p);
    if (p->s >= p->end) return fail(p, "unexpected end");
    switch (*p->s) {
    case '{': return container(p, v, depth, 1);
    case '[': return container(p, v, depth, 0);
    case '"': v->kind = JN_STR; return string(p, &v->str, &v->len);
    case 't': return word(p, "true", JN_TRUE, v);
    case 'f': return word(p, "false", JN_FALSE, v);
    case 'n': return word(p, "null", JN_NULL, v);
    default: return number(p, v);
    }
}

int json_parse(const char *s, size_t len, JNode *out, char *err, size_t err_size) {
    Parser p = { s, s + len, s, err, err_size, 0 };
    memset(out, 0, sizeof *out);
    if (value(&p, out, 0)) {
        ws(&p);
        if (p.s == p.end) return 1;
        fail(&p, "unexpected text after the JSON");
    }
    json_free(out);
    memset(out, 0, sizeof *out);
    return 0;
}

void json_free(JNode *v) {
    if (!v) return;
    for (size_t i = 0; i < v->n; i++) {
        json_free(&v->items[i]);
        if (v->keys) free(v->keys[i]);
    }
    free(v->items); free(v->keys); free(v->key_lens); free(v->str);
    memset(v, 0, sizeof *v);
}

static int wstr(Buf *b, const char *s, size_t n) {
    if (!put(b, "\"", 1)) return 0;
    size_t run = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        const char *esc = NULL;
        char u[7];
        if (c == '"') esc = "\\\""; else if (c == '\\') esc = "\\\\";
        else if (c == '\n') esc = "\\n"; else if (c == '\r') esc = "\\r"; else if (c == '\t') esc = "\\t";
        else if (c == '\b') esc = "\\b"; else if (c == '\f') esc = "\\f";
        else if (c < 0x20) { snprintf(u, sizeof u, "\\u%04x", c); esc = u; }
        if (!esc) continue;
        if (i > run && !put(b, s + run, i - run)) return 0;
        if (!put(b, esc, strlen(esc))) return 0;
        run = i + 1;
    }
    if (n > run && !put(b, s + run, n - run)) return 0;
    return put(b, "\"", 1);
}

static int wnode(Buf *b, const JNode *v) {
    switch (v->kind) {
    case JN_NULL: return put(b, "null", 4);
    case JN_TRUE: return put(b, "true", 4);
    case JN_FALSE: return put(b, "false", 5);
    case JN_NUM: return put(b, v->str, v->len);
    case JN_STR: return wstr(b, v->str, v->len);
    case JN_ARR: case JN_OBJ: {
        int obj = v->kind == JN_OBJ;
        if (!put(b, obj ? "{" : "[", 1)) return 0;
        for (size_t i = 0; i < v->n; i++) {
            if (i && !put(b, ",", 1)) return 0;
            if (obj && (!wstr(b, v->keys[i], v->key_lens[i]) || !put(b, ":", 1))) return 0;
            if (!wnode(b, &v->items[i])) return 0;
        }
        return put(b, obj ? "}" : "]", 1);
    }
    }
    return 0;
}

char *json_write(const JNode *v, size_t *out_len) {
    Buf b = { 0 };
    if (!wnode(&b, v)) { free(b.b); return NULL; }
    if (out_len) *out_len = b.n;
    return b.b;
}

int json_index(const JNode *o, const char *key) {
    if (!o || o->kind != JN_OBJ) return -1;
    size_t n = strlen(key);
    for (size_t i = 0; i < o->n; i++) if (o->key_lens[i] == n && !memcmp(o->keys[i], key, n)) return (int)i;
    return -1;
}

JNode *json_get(const JNode *o, const char *key) {
    int i = json_index(o, key);
    return i < 0 ? NULL : &o->items[i];
}

void json_set_string(JNode *v, const char *s, size_t len) {
    json_free(v);
    v->kind = JN_STR;
    v->str = malloc(len + 1);
    if (!v->str) { v->kind = JN_NULL; return; }
    memcpy(v->str, s, len);
    v->str[len] = 0;
    v->len = len;
}

void json_rename(JNode *o, size_t i, const char *key) {
    size_t n = strlen(key);
    char *k = malloc(n + 1);
    if (!k) return;
    memcpy(k, key, n + 1);
    free(o->keys[i]);
    o->keys[i] = k;
    o->key_lens[i] = n;
}
