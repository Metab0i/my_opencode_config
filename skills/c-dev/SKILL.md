---
name: c-dev
description: Write, consult on, and debug C programs. Covers the C language, memory management, GCC compilation, GDB debugging, common patterns, and undefined behavior avoidance. Includes live examples for core patterns and webfetch references for detailed API, compiler flag, and debugger command lookup.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  domain: c-development
---

## How to Use This Skill

- **Live examples** are provided for patterns that recur constantly (memory allocation, string handling, file I/O, error handling, struct design). Use these as templates.
- **Webfetch references** are provided for detailed lookup: function signatures, GCC flags, GDB commands, standard library details. Fetch the relevant URL when you need exact syntax or behavior.
- **Always consider undefined behavior** -- C's power comes with responsibility. When in doubt, fetch the standard or GNU C manual to verify semantics.

## Language Fundamentals

### Target Standard

Default to **C11** (ISO/IEC 9899:2011) unless the user specifies otherwise. C11 is widely supported and provides `_Static_assert`, `_Generic`, threads, and atomic operations. Use `-std=c11` with GCC.

Key differences between standards to be aware of:
- C99: `//` comments, `long long`, VLAs, designated initializers, `restrict`, `stdbool.h`, `stdint.h`
- C11: `_Static_assert`, `_Generic`, `_Atomic`, `threads.h`, `stdalign.h`, `stdnoreturn.h`
- C23: `typeof`, `constexpr`, `nullptr`, `bool` as keyword, `bit_cast`, `has_include`, improved `enum` scoping

### Basic Program Structure

```c
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char *argv[])
{
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <argument>\n", argv[0]);
        return EXIT_FAILURE;
    }

    printf("Hello, %s!\n", argv[1]);
    return EXIT_SUCCESS;
}
```

### Types and Sizes

- Use `<stdint.h>` types (`int32_t`, `uint64_t`, etc.) when size matters. Avoid bare `int`, `long` for data that crosses platform boundaries.
- Use `<stddef.h>` `size_t` for sizes and counts, `ptrdiff_t` for pointer differences, `intptr_t`/`uintptr_t` for pointer-to-integer conversion.
- `sizeof` yields `size_t`. Never store `sizeof` results in `int`.

```c
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>

int main(void)
{
    int32_t id = 42;
    size_t count = 100;
    printf("id=%" PRId32 " count=%zu\n", id, count);
    return 0;
}
```

Use `PRId32`, `PRIu64`, etc. from `<inttypes.h>` for portable `printf` format specifiers for fixed-width types.

### Strings

C strings are null-terminated byte arrays. Key rules:
- Always account for the null terminator when allocating: `strlen(s) + 1`
- `strncpy` does NOT guarantee null termination. Prefer `snprintf` or manual bounds checking.
- Never use `gets()` -- it is removed from the standard.

```c
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* Safe string copy into a fixed buffer */
static void safe_copy(char *dest, size_t dest_size, const char *src)
{
    if (dest_size == 0) return;
    size_t len = strlen(src);
    if (len >= dest_size) {
        len = dest_size - 1;
    }
    memcpy(dest, src, len);
    dest[len] = '\0';
}

/* Or use snprintf (always null-terminates if size > 0) */
char buf[64];
snprintf(buf, sizeof(buf), "value: %d", 42);
```

### Control Flow

```c
/* Switch with fallthrough annotation (C23) or comment (pre-C23) */
switch (code) {
case 0:
    handle_zero();
    break;
case 1:
    /* fallthrough */
case 2:
    handle_one_or_two();
    break;
default:
    handle_other();
    break;
}

/* For loop with size_t (never use int for sizes) */
for (size_t i = 0; i < count; i++) {
    process(items[i]);
}

/* Reverse iteration with size_t (watch for underflow) */
for (size_t i = count; i > 0; i--) {
    process(items[i - 1]);
}
```

## Memory Management

### Allocation Pattern

```c
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* Allocate and check for NULL */
int *arr = malloc(count * sizeof(*arr));
if (!arr) {
    perror("malloc");
    return EXIT_FAILURE;
}

/* Zero-initialized allocation */
int *zeros = calloc(count, sizeof(*zeros));
if (!zeros) {
    perror("calloc");
    return EXIT_FAILURE;
}

/* Resize (preserves content up to min of old and new size) */
int *tmp = realloc(arr, new_count * sizeof(*arr));
if (!tmp && new_count > 0) {
    perror("realloc");
    free(arr);  /* original is still valid */
    return EXIT_FAILURE;
}
arr = tmp;

/* Always free */
free(arr);
free(zeros);
```

Key rules:
- `realloc(ptr, 0)` is implementation-defined (may free or return a unique pointer). Don't rely on it.
- `realloc(NULL, size)` == `malloc(size)`
- After `free(ptr)`, set `ptr = NULL` to avoid use-after-free in complex code.
- Never `free` the same pointer twice. Never `free` a pointer not returned by `malloc`/`calloc`/`realloc`.

### Struct with Dynamic Members

```c
typedef struct {
    char *name;
    int *values;
    size_t value_count;
} Record;

Record *record_create(const char *name, size_t value_count)
{
    Record *r = calloc(1, sizeof(*r));
    if (!r) return NULL;

    r->name = strdup(name);
    if (!r->name) { free(r); return NULL; }

    r->values = calloc(value_count, sizeof(*r->values));
    if (!r->values) { free(r->name); free(r); return NULL; }

    r->value_count = value_count;
    return r;
}

void record_destroy(Record *r)
{
    if (!r) return;
    free(r->name);
    free(r->values);
    free(r);
}
```

### Stack vs Heap

- Prefer stack allocation for small, bounded-size data.
- Use heap for large arrays, data that outlives the function, or variable-size data.
- VLAs (variable-length arrays) are optional in C11, removed in C23. Avoid for portability.

## File I/O

```c
#include <stdio.h>
#include <stdlib.h>

/* Read entire file into memory */
char *read_file(const char *path, size_t *out_size)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    if (size < 0) { fclose(f); return NULL; }
    fseek(f, 0, SEEK_SET);

    char *buf = malloc((size_t)size + 1);
    if (!buf) { fclose(f); return NULL; }

    size_t n = fread(buf, 1, (size_t)size, f);
    fclose(f);

    buf[n] = '\0';
    if (out_size) *out_size = n;
    return buf;
}

/* Write to file with error checking */
int write_file(const char *path, const void *data, size_t size)
{
    FILE *f = fopen(path, "wb");
    if (!f) return -1;

    size_t written = fwrite(data, 1, size, f);
    if (written != size) { fclose(f); return -1; }

    if (fclose(f) != 0) return -1;  /* catches flush errors */
    return 0;
}

/* Line-by-line reading */
void read_lines(const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) return;

    char *line = NULL;
    size_t cap = 0;
    ssize_t len;
    while ((len = getline(&line, &cap, f)) != -1) {
        /* line includes trailing newline, len is bytes read */
        process_line(line, (size_t)len);
    }
    free(line);
    fclose(f);
}
```

## Function Pointers and Callbacks

```c
#include <stdio.h>
#include <stdlib.h>

typedef int (*compare_fn)(const void *, const void *);

/* qsort with function pointer */
int cmp_int(const void *a, const void *b)
{
    int ia = *(const int *)a;
    int ib = *(const int *)b;
    return (ia > ib) - (ia < ib);  /* avoids overflow of ia - ib */
}

int arr[] = { 5, 2, 8, 1, 9 };
qsort(arr, 5, sizeof(*arr), cmp_int);

/* Callback pattern */
typedef void (*event_handler)(int event_code, void *user_data);

void register_handler(event_handler fn, void *user_data)
{
    fn(42, user_data);
}
```

## Error Handling Patterns

```c
/* Return code pattern */
int do_something(void)
{
    if (!resource) return -1;
    if (!init()) { return -2; }
    if (!validate()) { cleanup(); return -3; }
    return 0;
}

/* Or use errno for system-level errors */
#include <errno.h>
#include <string.h>

FILE *f = fopen("missing.txt", "r");
if (!f) {
    fprintf(stderr, "Error: %s\n", strerror(errno));
}

/* goto cleanup pattern for complex resource management */
int complex_operation(void)
{
    FILE *f = NULL;
    char *buf = NULL;
    int result = -1;

    f = fopen("data.bin", "rb");
    if (!f) goto cleanup;

    buf = malloc(1024);
    if (!buf) goto cleanup;

    if (fread(buf, 1, 1024, f) != 1024) goto cleanup;

    result = process(buf, 1024);

cleanup:
    free(buf);
    if (f) fclose(f);
    return result;
}
```

## Build with GCC

### Basic Compilation

```bash
# Compile single file
gcc -std=c11 -Wall -Wextra -Wpedantic -o prog main.c

# Multiple files
gcc -std=c11 -Wall -Wextra -Wpedantic -o prog main.c utils.c parser.c

# With debug info
gcc -std=c11 -g -O0 -Wall -Wextra -Wpedantic -o prog main.c

# With optimization
gcc -std=c11 -O2 -Wall -Wextra -Wpedantic -o prog main.c

# Link with library
gcc -std=c11 -Wall -o prog main.c -lm -lpthread
```

### Essential Warning Flags

Always use at minimum: `-Wall -Wextra -Wpedantic`

Additional useful warnings:
- `-Werror` -- treat warnings as errors (use in CI, not during development)
- `-Wnull-dereference` -- detect potential null dereferences
- `-Wuninitialized` -- catch uninitialized variable use
- `-Wstrict-prototypes` -- require full function prototypes (C23 default)
- `-Wconversion` -- warn on implicit conversions that may change value
- `-Wshadow` -- warn on variable shadowing
- `-Wmissing-prototypes` -- warn on non-static functions without prior declaration
- `-Wold-style-definition` -- require modern function definitions
- `-Wformat=2` -- strict format string checking
- `-Wimplicit-fallthrough` -- require fallthrough annotation/comment

### Optimization Levels

- `-O0` -- no optimization (debugging)
- `-O1` -- basic optimization
- `-O2` -- recommended for production (most optimizations without size/speed tradeoffs)
- `-O3` -- aggressive optimization (may increase binary size, can expose UB)
- `-Os` -- optimize for size
- `-Og` -- optimize for debugging experience
- `-flto` -- link-time optimization (use at link step)
- `-fno-omit-frame-pointer` -- keep frame pointer for profiling/debugging

### Sanitizers (Development Only)

```bash
# Address sanitizer (memory errors, use-after-free, buffer overflow)
gcc -std=c11 -g -O1 -fsanitize=address -fno-omit-frame-pointer -o prog main.c

# Undefined behavior sanitizer (UB detection)
gcc -std=c11 -g -O1 -fsanitize=undefined -o prog main.c

# Thread sanitizer (data races)
gcc -std=c11 -g -O1 -fsanitize=thread -o prog main.c -lpthread

# Memory sanitizer (use of uninitialized memory, clang only)
# gcc does not support -fsanitize=memory
```

### Preprocessor and Macros

```c
/* Include guard */
#ifndef MY_HEADER_H
#define MY_HEADER_H
/* ... declarations ... */
#endif

/* Static assert (C11) */
_Static_assert(sizeof(int) == 4, "int must be 32 bits");

/* _Generic for type-generic macros (C11) */
#define cbrt(X) _Generic((X), \
    long double: cbrtl, \
    double: cbrt, \
    float: cbrtf \
)(X)

/* Stringification and token pasting */
#define STRINGIFY(x) #x
#define CONCAT(a, b) a##b

/* Conditional compilation */
#ifdef NDEBUG
    /* release build */
#else
    /* debug build */
#endif
```

## Debug with GDB

### Basic Workflow

```bash
# Compile with debug info
gcc -std=c11 -g -O0 -Wall -o prog main.c

# Start GDB
gdb ./prog

# Inside GDB:
(gdb) run arg1 arg2          # run with arguments
(gdb) break main             # breakpoint at main
(gdb) break file.c:42        # breakpoint at line
(gdb) break func             # breakpoint at function
(gdb) break file.c:42 if x > 0  # conditional breakpoint
(gdb) continue               # continue to next breakpoint
(gdb) step                   # step into function
(gdb) next                   # step over function
(gdb) finish                 # run until current function returns
(gdb) print variable         # print variable value
(gdb) print *ptr             # dereference pointer
(gdb) print array[0]@10      # print 10 elements of array
(gdb) display variable       # auto-print variable on each stop
(gdb) backtrace              # show call stack
(gdb) frame 2                # switch to frame 2
(gdb) info locals            # show local variables
(gdb) info args              # show function arguments
(gdb) info breakpoints       # list breakpoints
(gdb) delete 1               # delete breakpoint 1
(gdb) watch variable         # watchpoint: break when variable changes
(gdb) catch assert           # break on failed assert
(gdb) quit                   # exit GDB
```

### Core Dump Analysis

```bash
# Enable core dumps
ulimit -c unlimited

# After crash, analyze
gdb ./prog core
(gdb) bt          # backtrace at crash point
(gdb) frame N     # examine specific frame
(gdb) print var   # inspect variables
```

### Attaching to Running Process

```bash
gdb -p <pid>
# or
gdb ./prog <pid>
```

## Common Patterns and Idioms

### Safe Array Iteration

```c
/* Forward */
for (size_t i = 0; i < len; i++) { ... }

/* Backward (avoid i-- with size_t when i == 0) */
for (size_t i = len; i > 0; i--) {
    /* use items[i-1] */
}

/* Pointer iteration */
for (int *p = arr; p < arr + len; p++) {
    process(*p);
}
```

### Bit Manipulation

```c
/* Set bit n */
flags |= (1U << n);

/* Clear bit n */
flags &= ~(1U << n);

/* Toggle bit n */
flags ^= (1U << n);

/* Test bit n */
if (flags & (1U << n)) { ... }

/* Extract bits [lo, hi] (inclusive) */
#define EXTRACT(val, lo, hi) (((val) >> (lo)) & ((1U << ((hi) - (lo) + 1)) - 1))

/* Round up to power of 2 (for sizes up to 2^31) */
static inline uint32_t round_up_pow2(uint32_t v)
{
    v--;
    v |= v >> 1;
    v |= v >> 2;
    v |= v >> 4;
    v |= v >> 8;
    v |= v >> 16;
    v++;
    return v;
}
```

### Dynamic Array (Grow-on-Demand)

```c
typedef struct {
    int *data;
    size_t len;
    size_t cap;
} IntVec;

#define INTVEC_INIT { NULL, 0, 0 }

int vec_push(IntVec *v, int val)
{
    if (v->len >= v->cap) {
        size_t new_cap = v->cap == 0 ? 8 : v->cap * 2;
        int *tmp = realloc(v->data, new_cap * sizeof(*tmp));
        if (!tmp) return -1;
        v->data = tmp;
        v->cap = new_cap;
    }
    v->data[v->len++] = val;
    return 0;
}

void vec_free(IntVec *v)
{
    free(v->data);
    *v = (IntVec)INTVEC_INIT;
}
```

## Critical Gotchas and Undefined Behavior

### Undefined Behavior to Avoid

- **Signed integer overflow**: `INT_MAX + 1` is UB. Use unsigned arithmetic or check before overflow.
- **Null pointer dereference**: Always check pointers from `malloc`, `fopen`, etc.
- **Use after free**: Set pointers to NULL after freeing.
- **Buffer overflow**: Always check bounds. Use `snprintf` over `sprintf`, `strncpy` alternatives, `fread` with correct size.
- **Strict aliasing violation**: Accessing an object through a pointer of incompatible type is UB (exceptions: `char *`, `signed char *`, `unsigned char *`).
- **Uninitialized variables**: Reading uninitialized automatic variables is UB. Compile with `-Wuninitialized`.
- **Out-of-bounds pointer arithmetic**: Pointer arithmetic is only valid within the same allocated object (or one past the end).
- **Modifying string literals**: `"hello"[0] = 'H'` is UB. String literals are read-only.
- **Shifting by >= width**: `x << 32` on a 32-bit int is UB. Shift amount must be `< width` of the promoted type.
- **Negative shift count**: `x << -1` is UB.
- **Dangling pointers to local variables**: Never return address of a local variable.
- **Multiple unsequenced modifications**: `i = i++` or `f(i++, i++)` is UB.

### Common Mistakes

- `sizeof(pointer)` vs `sizeof(array)` -- `sizeof` on a pointer gives pointer size, not array size.
- `==` on strings compares pointers, not content. Use `strcmp`.
- `feof()` does not predict EOF -- it returns true only AFTER a read has failed. Check the return value of the read function instead.
- `realloc` may return NULL -- always assign to a temporary pointer first.
- `strtok` is not thread-safe and modifies the input string. Use `strtok_r` for reentrancy.
- `asctime` and `ctime` return pointers to static internal buffers. Use `asctime_r` and `ctime_r`.

### Portability Notes

- `char` may be signed or unsigned depending on platform. Use `signed char` or `unsigned char` explicitly when it matters.
- `int` is not always 32 bits. Use `int32_t` when size matters.
- Endianness differs across architectures. Use `<endian.h>` or explicit byte-order functions for network protocols.
- Path separators differ (`/` on Unix, `\` on Windows). Use platform abstraction or conditional compilation.

## Documentation Reference Index

Fetch these URLs for detailed lookup of function signatures, compiler flags, and debugger commands.

### C Language Reference

- **GNU C Manual** (complete language reference, examples, standard library): https://www.gnu.org/software/gnu-c-manual/gnu-c-manual.html
- **C standard library reference** (within GNU C manual): https://www.gnu.org/software/gnu-c-manual/gnu-c-manual.html#Standard-Library

### GCC Compiler

- **GCC main documentation**: https://gcc.gnu.org/
- **GCC option summary** (all command-line flags by category): https://gcc.gnu.org/onlinedocs/gcc/Option-Summary.html
- **GCC warning options** (detailed explanation of each -W flag): https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html
- **GCC optimization options** (-O levels, specific optimizations): https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html
- **GCC sanitizer options** (AddressSanitizer, UBSan, ThreadSanitizer): https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html
- **GCC C dialect options** (-std=c11, -std=c23, extensions): https://gcc.gnu.org/onlinedocs/gcc/C-Dialect-Options.html
- **GCC preprocessor options** (-D, -I, -include, -M): https://gcc.gnu.org/onlinedocs/cpp/Invocation.html
- **GCC linker options** (-l, -L, -shared, -static): https://gcc.gnu.org/onlinedocs/gcc/Link-Options.html
- **GCC function attributes** (noreturn, pure, const, malloc, format): https://gcc.gnu.org/onlinedocs/gcc/Common-Function-Attributes.html
- **GCC variable attributes** (aligned, packed, section): https://gcc.gnu.org/onlinedocs/gcc/Common-Variable-Attributes.html
- **GCC type attributes**: https://gcc.gnu.org/onlinedocs/gcc/Common-Type-Attributes.html
- **GCC built-in functions** (__builtin_expect, __builtin_clz, etc.): https://gcc.gnu.org/onlinedocs/gcc/Other-Builtins.html
- **GCC C extensions** (statement expressions, typeof, zero-length arrays, etc.): https://gcc.gnu.org/onlinedocs/gcc/C-Extensions.html

### GDB Debugger

- **GDB documentation** (full manual): https://www.sourceware.org/gdb/documentation/
- **GDB command reference** (all commands alphabetically): https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/Command-Index.html
- **GDB breakpoints** (break, tbreak, hbreak, watch, catch, conditions): https://www.sourceware.org/gdb/documentation/breakpoints.html
- **GDB examining data** (print, display, examine, print arrays/structs): https://www.sourceware.org/gdb/documentation/data.html
- **GDB stack frames** (backtrace, frame, up, down, info frame): https://www.sourceware.org/gdb/documentation/stack.html
- **GDB source listing** (list, search, edit): https://www.sourceware.org/gdb/documentation/symbols.html
- **GDB reverse debugging** (record, reverse-step, reverse-continue): https://www.sourceware.org/gdb/documentation/reverse.html
- **GDB TUI mode** (text user interface for source+assembly): https://www.sourceware.org/gdb/documentation/tui.html
- **GDB Python scripting** (extending GDB with Python): https://www.sourceware.org/gdb/documentation/python.html
- **GDB MI interface** (machine interface for IDE integration): https://www.sourceware.org/gdb/documentation/gdbmi.html

### POSIX / System APIs

- **POSIX standard** (system calls, pthreads, signals, file I/O): https://pubs.opengroup.org/onlinepubs/9799919799/
- **Linux man pages online** (system calls, library functions, file formats): https://man7.org/linux/man-pages/

## Makefile Template

```makefile
CC      = gcc
CFLAGS  = -std=c11 -Wall -Wextra -Wpedantic -Wmissing-prototypes -Wstrict-prototypes
LDFLAGS =
LDLIBS  = -lm

SRCS    = main.c utils.c parser.c
OBJS    = $(SRCS:.c=.o)
TARGET  = prog

# Default target
$(TARGET): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $^ $(LDLIBS)

# Pattern rule for .c -> .o
%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

# Debug build
debug: CFLAGS += -g -O0 -fsanitize=address -fno-omit-frame-pointer
debug: $(TARGET)

# Release build
release: CFLAGS += -O2 -DNDEBUG
release: $(TARGET)

clean:
	rm -f $(OBJS) $(TARGET)

.PHONY: clean debug release
```

## Consulting Workflow

1. **Identify the C standard** -- ask or assume C11. Check if C23 features are available.
2. **Check for GCC extensions** -- if the code uses `__attribute__`, `typeof`, statement expressions, note that these are GCC-specific.
3. **Fetch documentation** for exact function signatures, flags, or commands before writing code.
4. **Write safe code** -- check all return values, handle NULL, avoid UB, use sanitizers during development.
5. **Provide build commands** -- always include the GCC invocation with appropriate flags.
6. **Suggest debugging approach** -- if the user has a bug, suggest compiling with sanitizers first, then GDB if needed.
