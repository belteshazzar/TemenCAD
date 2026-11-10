/* A JSON tree that round-trips: object key order is kept and numbers keep the text they were written
 * with, so a document read and written back changes only what was edited. Used by conversation.c. */
#ifndef TEMEN_JSON_H
#define TEMEN_JSON_H
#include <stddef.h>

typedef enum { JN_NULL, JN_FALSE, JN_TRUE, JN_NUM, JN_STR, JN_ARR, JN_OBJ } JNKind;

typedef struct JNode {
    JNKind kind;
    char *str;           /* JN_STR: the decoded UTF-8 (may hold zero bytes); JN_NUM: the number as written */
    size_t len;
    struct JNode *items; /* JN_ARR and JN_OBJ */
    char **keys;         /* JN_OBJ, 0-terminated (a key with a zero byte never matches json_get) */
    size_t *key_lens;
    size_t n, cap;
} JNode;

/* Parses the whole of s (strict JSON, nesting at most 512 deep). On failure returns 0 and writes the
 * reason, with the byte offset, into err. */
int json_parse(const char *s, size_t len, JNode *out, char *err, size_t err_size);
void json_free(JNode *node);
/* Compact JSON, malloc'd and 0-terminated, *out_len bytes; NULL when out of memory. */
char *json_write(const JNode *node, size_t *out_len);

JNode *json_get(const JNode *obj, const char *key);
int json_index(const JNode *obj, const char *key); /* -1 when absent */
/* Replaces node's contents with a string (copied). */
void json_set_string(JNode *node, const char *s, size_t len);
/* Renames key i of an object. */
void json_rename(JNode *obj, size_t i, const char *key);
#endif
