/* Windows has no POSIX getline(); upstream step-count/main.c needs it. */
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
static ssize_t getline(char **lineptr, size_t *n, FILE *stream) {
  size_t i = 0; int c;
  if (!*lineptr || !*n) { *n = 256; *lineptr = (char*)malloc(*n); }
  while ((c = fgetc(stream)) != EOF) {
    if (i + 2 > *n) { *n *= 2; *lineptr = (char*)realloc(*lineptr, *n); }
    (*lineptr)[i++] = (char)c;
    if (c == '\n') break;
  }
  if (i == 0) return -1;
  (*lineptr)[i] = 0; return (ssize_t)i;
}
