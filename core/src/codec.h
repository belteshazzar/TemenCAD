/* SHA-256 and base64 for the conversation format (conversation.c). */
#ifndef TEMEN_CODEC_H
#define TEMEN_CODEC_H
#include <stddef.h>
#include <stdint.h>

/* The digest of `len` bytes as 64 lowercase hex characters and a terminating 0. */
void temen_sha256_hex(const void *data, size_t len, char out[65]);

/* Standard base64 with padding; a malloc'd, 0-terminated string of *out_len characters. */
char *temen_base64_encode(const void *data, size_t len, size_t *out_len);
/* Decodes standard base64 (padding optional, no other characters); malloc'd bytes, or NULL when invalid. */
unsigned char *temen_base64_decode(const char *s, size_t len, size_t *out_len);
#endif
