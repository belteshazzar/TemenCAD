/*
 * The assistant conversation in a .temen (format 2, core/CONVERSATION.md): packing an app's conversation
 * JSON into archive entries (.assistant/conversation.json and .assistant/blobs/<sha256>) and back.
 *
 * Packing moves every inline base64 source ({"type":"base64","data":...}) into a blob and rewrites every
 * reference ({"$blob": <app key>}) to the SHA-256 of the bytes the app passed for it; unpacking restores
 * the base64 sources inline and hands back the bytes of the other references. Both check the document's
 * shape, so a file one app wrote is one any other can read.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "temencad.h"
#include "codec.h"
#include "json.h"

#define CONV_PATH ".assistant/conversation.json"
#define BLOB_DIR ".assistant/blobs/"
#define FORMAT 2

static char *msg(const char *fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    return strdup(buf);
}
static void set_err(char **error, char *m) { if (error) *error = m; else free(m); }

/* ---- the document's shape ---- */

static int is_array(const JNode *v) { return v && v->kind == JN_ARR; }

static char *check_shape(const JNode *root) {
    if (root->kind != JN_OBJ) return msg("the conversation is not a JSON object");
    const JNode *f = json_get(root, "format");
    if (!f) return msg("the conversation has no format number");
    if (f->kind != JN_NUM || strcmp(f->str, "2"))
        return msg("the conversation is format %s; this version of TemenCAD reads format %d", f->kind == JN_NUM ? f->str : "(not a number)", FORMAT);
    const JNode *entries = json_get(root, "entries"), *messages = json_get(root, "messages");
    if (!is_array(entries)) return msg("the conversation has no entries array");
    if (!is_array(messages)) return msg("the conversation has no messages array");
    for (size_t i = 0; i < entries->n; i++) {
        const JNode *kind = json_get(&entries->items[i], "kind");
        if (!kind || kind->kind != JN_STR) return msg("entry %zu has no kind", i);
    }
    static const char *const lists[] = { "notes", "attachments", "checkpoints" };
    for (size_t k = 0; k < 3; k++) {
        const JNode *v = json_get(root, lists[k]);
        if (v && !is_array(v)) return msg("%s is not an array", lists[k]);
    }
    const JNode *cps = json_get(root, "checkpoints");
    for (size_t i = 0; cps && i < cps->n; i++)
        if (cps->items[i].kind != JN_OBJ) return msg("checkpoint %zu is not an object", i);
    const JNode *app = json_get(root, "app");
    if (app && app->kind != JN_STR) return msg("app is not a string");
    return NULL;
}

/* ---- the blobs written or returned, unique by SHA-256 ---- */

typedef struct { char key[65]; unsigned char *data; size_t len; } Blob;
typedef struct { Blob *b; size_t n, cap; } BlobList;

static int has_blob(const BlobList *l, const char *key) {
    for (size_t i = 0; i < l->n; i++) if (!strcmp(l->b[i].key, key)) return 1;
    return 0;
}
/* Takes ownership of data (or copies it when copy is set). */
static int add_blob(BlobList *l, const char *key, const void *data, size_t len, int copy) {
    if (has_blob(l, key)) { if (!copy) free((void *)data); return 1; }
    if (l->n == l->cap) {
        size_t cap = l->cap ? l->cap * 2 : 16;
        Blob *nb = realloc(l->b, cap * sizeof *nb);
        if (!nb) return 0;
        l->b = nb; l->cap = cap;
    }
    Blob *b = &l->b[l->n];
    memcpy(b->key, key, 65);
    if (copy) {
        b->data = malloc(len ? len : 1);
        if (!b->data) return 0;
        memcpy(b->data, data, len);
    } else b->data = (unsigned char *)data;
    b->len = len;
    l->n++;
    return 1;
}
static void free_blobs(BlobList *l) {
    for (size_t i = 0; i < l->n; i++) free(l->b[i].data);
    free(l->b);
    memset(l, 0, sizeof *l);
}

static int is_base64_source(const JNode *o) {
    const JNode *t = json_get(o, "type");
    return t && t->kind == JN_STR && !strcmp(t->str, "base64");
}

/* ---- packing ---- */

typedef struct { const TemenBlob *src; char hash[65]; } Given;
static int cmp_given(const void *a, const void *b) { return strcmp(((const Given *)a)->src->key, ((const Given *)b)->src->key); }

typedef struct { Given *given; size_t n_given; BlobList out; char *error; } Packer;

static int pack_node(Packer *pk, JNode *v) {
    if (v->kind == JN_ARR) {
        for (size_t i = 0; i < v->n; i++) if (!pack_node(pk, &v->items[i])) return 0;
        return 1;
    }
    if (v->kind != JN_OBJ) return 1;
    int r = json_index(v, "$blob");
    if (r >= 0 && v->items[r].kind == JN_STR) {
        TemenBlob probe = { v->items[r].str, NULL, 0 };
        Given key = { &probe, { 0 } };
        Given *g = pk->n_given ? bsearch(&key, pk->given, pk->n_given, sizeof *pk->given, cmp_given) : NULL;
        if (!g) { pk->error = msg("blob \"%.80s\" is referenced but its bytes were not given", v->items[r].str); return 0; }
        if (!add_blob(&pk->out, g->hash, g->src->data, g->src->len, 1)) { pk->error = msg("out of memory"); return 0; }
        json_set_string(&v->items[r], g->hash, 64);
        return 1;
    }
    int d = json_index(v, "data");
    if (d >= 0 && v->items[d].kind == JN_STR && is_base64_source(v)) {
        size_t len;
        unsigned char *bytes = temen_base64_decode(v->items[d].str, v->items[d].len, &len);
        if (!bytes) { pk->error = msg("a base64 source holds data that is not base64"); return 0; }
        char hash[65];
        temen_sha256_hex(bytes, len, hash);
        if (!add_blob(&pk->out, hash, bytes, len, 0)) { free(bytes); pk->error = msg("out of memory"); return 0; }
        json_rename(v, (size_t)d, "$blob");
        json_set_string(&v->items[d], hash, 64);
        return 1;
    }
    for (size_t i = 0; i < v->n; i++) if (!pack_node(pk, &v->items[i])) return 0;
    return 1;
}

void temen_files_free(TemenFile *files, size_t n) {
    if (!files) return;
    for (size_t i = 0; i < n; i++) { free((void *)files[i].name); free((void *)files[i].data); }
    free(files);
}

TemenFile *temen_conversation_pack(const char *json, size_t len, const TemenBlob *blobs, size_t n_blobs,
                                   size_t *n_out, char **error) {
    if (error) *error = NULL;
    *n_out = 0;
    JNode root;
    char perr[160];
    if (!json_parse(json, len, &root, perr, sizeof perr)) { set_err(error, msg("the conversation is not valid JSON: %s", perr)); return NULL; }
    char *shape = check_shape(&root);
    if (shape) { json_free(&root); set_err(error, shape); return NULL; }

    Packer pk = { 0 };
    if (n_blobs) {
        pk.given = malloc(n_blobs * sizeof *pk.given);
        if (!pk.given) { json_free(&root); set_err(error, msg("out of memory")); return NULL; }
        for (size_t i = 0; i < n_blobs; i++) {
            pk.given[i].src = &blobs[i];
            temen_sha256_hex(blobs[i].data, blobs[i].len, pk.given[i].hash);
        }
        pk.n_given = n_blobs;
        qsort(pk.given, n_blobs, sizeof *pk.given, cmp_given);
    }
    int ok = pack_node(&pk, &root);
    free(pk.given);
    if (!ok) { json_free(&root); free_blobs(&pk.out); set_err(error, pk.error); return NULL; }

    size_t jlen;
    char *text = json_write(&root, &jlen);
    json_free(&root);
    TemenFile *files = text ? calloc(pk.out.n + 1, sizeof *files) : NULL;
    if (!files) { free(text); free_blobs(&pk.out); set_err(error, msg("out of memory")); return NULL; }
    files[0].name = strdup(CONV_PATH);
    files[0].data = text;
    files[0].len = jlen;
    for (size_t i = 0; i < pk.out.n; i++) {
        char *name = malloc(sizeof BLOB_DIR + 64);
        if (name) { memcpy(name, BLOB_DIR, sizeof BLOB_DIR - 1); memcpy(name + sizeof BLOB_DIR - 1, pk.out.b[i].key, 65); }
        files[i + 1].name = name;
        files[i + 1].data = pk.out.b[i].data; /* the files own the bytes now */
        files[i + 1].len = pk.out.b[i].len;
    }
    *n_out = pk.out.n + 1;
    free(pk.out.b);
    return files;
}

/* ---- unpacking ---- */

struct TemenConversation {
    char *json;
    size_t json_len;
    TemenBlob *blobs;
    size_t n_blobs;
};

typedef struct { const TemenFile *file; int checked; } Stored;
typedef struct { Stored *stored; size_t n_stored; BlobList out; char *error; } Unpacker;

static const TemenFile *stored_blob(Unpacker *u, const char *key) {
    if (strlen(key) != 64) { u->error = msg("blob reference \"%.80s\" is not a SHA-256", key); return NULL; }
    for (size_t i = 0; i < u->n_stored; i++) {
        const TemenFile *f = u->stored[i].file;
        if (strcmp(f->name + sizeof BLOB_DIR - 1, key)) continue;
        if (!u->stored[i].checked) {
            char hash[65];
            temen_sha256_hex(f->data, f->len, hash);
            if (strcmp(hash, key)) { u->error = msg("blob %.16s… is damaged (its contents do not match its name)", key); return NULL; }
            u->stored[i].checked = 1;
        }
        return f;
    }
    u->error = msg("blob %.16s… is referenced but missing from the file", key);
    return NULL;
}

static int unpack_node(Unpacker *u, JNode *v) {
    if (v->kind == JN_ARR) {
        for (size_t i = 0; i < v->n; i++) if (!unpack_node(u, &v->items[i])) return 0;
        return 1;
    }
    if (v->kind != JN_OBJ) return 1;
    int r = json_index(v, "$blob");
    if (r >= 0 && v->items[r].kind == JN_STR) {
        const TemenFile *f = stored_blob(u, v->items[r].str);
        if (!f) return 0;
        if (is_base64_source(v)) {
            size_t n;
            char *b64 = temen_base64_encode(f->data, f->len, &n);
            if (!b64) { u->error = msg("out of memory"); return 0; }
            json_rename(v, (size_t)r, "data");
            json_free(&v->items[r]);
            v->items[r].kind = JN_STR;
            v->items[r].str = b64;
            v->items[r].len = n;
        } else if (!add_blob(&u->out, v->items[r].str, f->data, f->len, 1)) { u->error = msg("out of memory"); return 0; }
        return 1;
    }
    for (size_t i = 0; i < v->n; i++) if (!unpack_node(u, &v->items[i])) return 0;
    return 1;
}

TemenConversation *temen_conversation_unpack(const TemenFile *files, size_t n_files, char **error) {
    if (error) *error = NULL;
    const TemenFile *conv = NULL;
    Unpacker u = { 0 };
    u.stored = calloc(n_files ? n_files : 1, sizeof *u.stored);
    if (!u.stored) { set_err(error, msg("out of memory")); return NULL; }
    for (size_t i = 0; i < n_files; i++) {
        if (!strcmp(files[i].name, CONV_PATH)) conv = &files[i];
        else if (!strncmp(files[i].name, BLOB_DIR, sizeof BLOB_DIR - 1)) u.stored[u.n_stored++].file = &files[i];
    }
    if (!conv) { free(u.stored); return NULL; } /* no conversation: not an error */

    JNode root;
    char perr[160];
    if (!json_parse(conv->data, conv->len, &root, perr, sizeof perr)) {
        free(u.stored);
        set_err(error, msg("the conversation in this file is not valid JSON: %s", perr));
        return NULL;
    }
    char *shape = check_shape(&root);
    int ok = !shape && unpack_node(&u, &root);
    free(u.stored);
    if (!ok) { json_free(&root); free_blobs(&u.out); set_err(error, shape ? shape : u.error); return NULL; }

    TemenConversation *c = calloc(1, sizeof *c);
    if (c) c->json = json_write(&root, &c->json_len);
    json_free(&root);
    if (c && c->json && (c->blobs = calloc(u.out.n ? u.out.n : 1, sizeof *c->blobs))) {
        for (size_t i = 0; i < u.out.n; i++) {
            c->blobs[i].key = strdup(u.out.b[i].key);
            c->blobs[i].data = u.out.b[i].data; /* the conversation owns the bytes now */
            c->blobs[i].len = u.out.b[i].len;
        }
        c->n_blobs = u.out.n;
        free(u.out.b);
        return c;
    }
    if (c) { free(c->json); free(c); }
    free_blobs(&u.out);
    set_err(error, msg("out of memory"));
    return NULL;
}

const char *temen_conversation_json(const TemenConversation *c, size_t *len) {
    if (len) *len = c->json_len;
    return c->json;
}
size_t temen_conversation_blob_count(const TemenConversation *c) { return c->n_blobs; }
const TemenBlob *temen_conversation_blob(const TemenConversation *c, size_t i) { return i < c->n_blobs ? &c->blobs[i] : NULL; }

void temen_conversation_free(TemenConversation *c) {
    if (!c) return;
    for (size_t i = 0; i < c->n_blobs; i++) { free((void *)c->blobs[i].key); free((void *)c->blobs[i].data); }
    free(c->blobs);
    free(c->json);
    free(c);
}
