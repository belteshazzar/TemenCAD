/* The conversation format (src/conversation.c) on its own: cc -Iinclude -Isrc test/conversation-test.c
 * src/conversation.c src/json.c src/codec.c && ./a.out */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "temencad.h"
#include "codec.h"
#include "json.h"

static int failures;
#define CHECK(cond, what) do { if (!(cond)) { printf("FAIL %s (line %d)\n", what, __LINE__); failures++; } } while (0)

static const TemenFile *find(const TemenFile *f, size_t n, const char *name) {
    for (size_t i = 0; i < n; i++) if (!strcmp(f[i].name, name)) return &f[i];
    return NULL;
}

int main(void) {
    char h[65];
    temen_sha256_hex("", 0, h);
    CHECK(!strcmp(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "sha256 of nothing");
    temen_sha256_hex("abc", 3, h);
    CHECK(!strcmp(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), "sha256 of abc");
    const char *long_in = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    temen_sha256_hex(long_in, strlen(long_in), h);
    CHECK(!strcmp(h, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"), "sha256 of two blocks");

    size_t n;
    char *b64 = temen_base64_encode("hello!?", 7, &n);
    CHECK(!strcmp(b64, "aGVsbG8hPw=="), "base64 encode");
    unsigned char *raw = temen_base64_decode(b64, n, &n);
    CHECK(raw && n == 7 && !memcmp(raw, "hello!?", 7), "base64 decode");
    free(b64); free(raw);
    CHECK(!temen_base64_decode("ab$d", 4, &n), "base64 rejects junk");

    /* JSON keeps numbers as written, key order, escapes and zero bytes */
    const char *doc = "{\"b\":1.50e3,\"a\":[true,false,null,-0.0],\"s\":\"\\u00e9\\ud83d\\ude00\\u0000\\n\\\"\"}";
    JNode root;
    char err[160];
    CHECK(json_parse(doc, strlen(doc), &root, err, sizeof err), "json parses");
    char *back = json_write(&root, &n);
    CHECK(back && !strcmp(back, "{\"b\":1.50e3,\"a\":[true,false,null,-0.0],\"s\":\"\xc3\xa9\xf0\x9f\x98\x80\\u0000\\n\\\"\"}"), "json round trip");
    free(back); json_free(&root);
    CHECK(!json_parse("{\"a\":1,}", 8, &root, err, sizeof err) && strstr(err, "byte"), "json rejects a trailing comma");
    CHECK(!json_parse("[1] x", 5, &root, err, sizeof err), "json rejects trailing text");

    /* pack: inline base64 to blobs, app references to SHA-256, repeats stored once */
    const char *png = "iVBORw0KGgo="; /* 8 bytes */
    char conv[1024];
    snprintf(conv, sizeof conv,
             "{\"format\":2,\"app\":\"test\",\"entries\":[{\"kind\":\"user\",\"text\":\"hi\"},{\"kind\":\"image\",\"image\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"%s\"}}],"
             "\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"%s\"}}]}],"
             "\"checkpoints\":[{\"main.js\":{\"$blob\":\"k1\"}},{\"main.js\":{\"$blob\":\"k2\"},\"gear.stl\":{\"$blob\":\"k3\"}}],"
             "\"attachments\":[{\"name\":\"gear.stl\",\"media_type\":\"model/stl\",\"data\":{\"$blob\":\"k3\"}}]}", png, png);
    TemenBlob blobs[] = { { "k1", "return 1;", 9 }, { "k2", "return 2;", 9 }, { "k3", "solid", 5 } };
    char *perr = NULL;
    size_t nf;
    TemenFile *files = temen_conversation_pack(conv, strlen(conv), blobs, 3, &nf, &perr);
    CHECK(files && !perr, "pack succeeds");
    CHECK(nf == 5, "pack writes the json and four blobs (the image once)");
    const TemenFile *cj = files ? find(files, nf, ".assistant/conversation.json") : NULL;
    CHECK(cj && !strstr(cj->data, "\"k1\"") && !strstr(cj->data, png), "pack leaves no app keys or base64");
    temen_sha256_hex("solid", 5, h);
    char name[128];
    snprintf(name, sizeof name, ".assistant/blobs/%s", h);
    CHECK(files && find(files, nf, name), "blob named by its SHA-256");

    /* unpack: base64 back inline, references by SHA-256 with their bytes */
    char *uerr = NULL;
    TemenConversation *c = temen_conversation_unpack(files, nf, &uerr);
    CHECK(c && !uerr, "unpack succeeds");
    if (c) {
        const char *j = temen_conversation_json(c, NULL);
        char want[64];
        snprintf(want, sizeof want, "\"data\":\"%s\"", png);
        CHECK(strstr(j, want) && strstr(strstr(j, want) + 1, want), "both base64 sources inline again");
        CHECK(temen_conversation_blob_count(c) == 3, "three referenced blobs");
        int found = 0;
        for (size_t i = 0; i < temen_conversation_blob_count(c); i++) {
            const TemenBlob *b = temen_conversation_blob(c, i);
            if (!strcmp(b->key, h) && b->len == 5 && !memcmp(b->data, "solid", 5)) found = 1;
        }
        CHECK(found, "the STL's bytes under its SHA-256");
        /* packing what was unpacked gives the same file */
        size_t nf2;
        TemenFile *again = temen_conversation_pack(j, strlen(j), (const TemenBlob *)temen_conversation_blob(c, 0), temen_conversation_blob_count(c), &nf2, NULL);
        CHECK(again && nf2 == nf && find(again, nf2, ".assistant/conversation.json")->len == cj->len
              && !memcmp(find(again, nf2, ".assistant/conversation.json")->data, cj->data, cj->len), "repack is identical");
        temen_files_free(again, nf2);
        temen_conversation_free(c);
    }

    /* a damaged blob, a missing one */
    for (size_t i = 0; files && i < nf; i++) if (!strcmp(files[i].name, name)) ((char *)files[i].data)[0] = 'X';
    c = temen_conversation_unpack(files, nf, &uerr);
    CHECK(!c && uerr && strstr(uerr, "damaged"), "damaged blob is refused");
    temen_buffer_free(uerr);
    c = temen_conversation_unpack(files, 1, &uerr);
    CHECK(!c && uerr && strstr(uerr, "missing"), "missing blob is refused");
    temen_buffer_free(uerr);
    temen_files_free(files, nf);

    /* no conversation; wrong format; a reference without bytes; bad base64 */
    TemenFile other = { "main.js", "x", 1 };
    c = temen_conversation_unpack(&other, 1, &uerr);
    CHECK(!c && !uerr, "no conversation is not an error");
    const char *v1 = "{\"v\":1,\"entries\":[]}";
    CHECK(!temen_conversation_pack(v1, strlen(v1), NULL, 0, &nf, &perr) && strstr(perr, "format"), "format 1 refused");
    temen_buffer_free(perr);
    const char *f3 = "{\"format\":3,\"entries\":[],\"messages\":[]}";
    CHECK(!temen_conversation_pack(f3, strlen(f3), NULL, 0, &nf, &perr) && strstr(perr, "format 3"), "format 3 refused");
    temen_buffer_free(perr);
    const char *dangling = "{\"format\":2,\"entries\":[],\"messages\":[],\"checkpoints\":[{\"a.js\":{\"$blob\":\"nope\"}}]}";
    CHECK(!temen_conversation_pack(dangling, strlen(dangling), NULL, 0, &nf, &perr) && strstr(perr, "nope"), "reference without bytes refused");
    temen_buffer_free(perr);
    const char *badb64 = "{\"format\":2,\"entries\":[],\"messages\":[{\"type\":\"base64\",\"data\":\"@@@\"}]}";
    CHECK(!temen_conversation_pack(badb64, strlen(badb64), NULL, 0, &nf, &perr) && strstr(perr, "base64"), "bad base64 refused");
    temen_buffer_free(perr);
    const char *nokind = "{\"format\":2,\"entries\":[{\"text\":\"x\"}],\"messages\":[]}";
    CHECK(!temen_conversation_pack(nokind, strlen(nokind), NULL, 0, &nf, &perr) && strstr(perr, "kind"), "entry without kind refused");
    temen_buffer_free(perr);

    printf(failures ? "conversation: %d failed\n" : "ok   conversation format (%d failures)\n", failures);
    return failures != 0;
}
