/*
 * The few things the core needs from the C library that are not in C11 itself, with a
 * Windows spelling where that differs. Everything else is standard C; Manifold is
 * portable C++17 and lamassu already builds on Windows.
 */
#ifndef TEMEN_COMPAT_H
#define TEMEN_COMPAT_H

#include <stddef.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <strings.h>
#include <time.h>
#endif

/* strtok_r: strtok_s on Windows has the same contract */
static inline char *temen_strtok_r(char *s, const char *delim, char **save) {
#ifdef _WIN32
    return strtok_s(s, delim, save);
#else
    return strtok_r(s, delim, save);
#endif
}

/* case-insensitive compares: _stricmp/_strnicmp on Windows */
static inline int temen_strcasecmp(const char *a, const char *b) {
#ifdef _WIN32
    return _stricmp(a, b);
#else
    return strcasecmp(a, b);
#endif
}
static inline int temen_strncasecmp(const char *a, const char *b, size_t n) {
#ifdef _WIN32
    return _strnicmp(a, b, n);
#else
    return strncasecmp(a, b, n);
#endif
}

/* memmem is a GNU/BSD extension; this is the plain version */
static inline const char *temen_memmem(const char *hay, size_t hay_len, const char *needle, size_t needle_len) {
    if (needle_len == 0) return hay;
    if (hay_len < needle_len) return NULL;
    for (size_t i = 0; i + needle_len <= hay_len; i++)
        if (hay[i] == needle[0] && memcmp(hay + i, needle, needle_len) == 0) return hay + i;
    return NULL;
}

/* a monotonic clock in milliseconds */
static inline double temen_now_ms(void) {
#ifdef _WIN32
    LARGE_INTEGER f, c;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
#endif
}

#endif
