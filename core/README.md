# TemenCAD core

The modelling runtime as one C library: the [lamassu-js](https://github.com/mdy-docs/lamassu-js)
JavaScript engine runs the user's script, [Manifold](https://github.com/elalish/manifold) does the
geometry through its C binding, and a JavaScript prelude in between defines the TemenCAD API.
The same library links into the browser (Emscripten), a native command line tool, and later a
Swift package. Nothing in `src/` depends on the host platform.

```
 user script (main.js + imports)        JavaScript, lamassu subset
 ───────────────────────────────
 src/prelude.js                          JavaScript, lamassu subset: Shape, box(), union(), echo()…
 ───────────────────────────────
 src/natives.c   the __cad namespace     C: flat natives over manifoldc, shapes as numeric handles
 src/host.c      engine + modules + run  C: one VM, a module loader over the project files, the run loop
 ───────────────────────────────
 lamassu-js (third_party)   manifold + Clipper2 (third_party)
```

## Why a prelude in JavaScript rather than a full C port

The earlier plan was to port `src/cad.js` and friends to C. With lamassu the argument for that
mostly disappears: lamassu runs everywhere the C core runs, so a JavaScript prelude is just as
portable, and it keeps argument checking, defaults, overloads and formatting in the language
they were written in. Only the geometry crosses into C, as Manifold handles. The parts of the
app that work on meshes directly (fillets, printability checks, heightmaps) can still move into
C one at a time when the interpreter is too slow for them; the boundary is a flat function
table, so that is a local change.

The prelude must follow the same JavaScript subset scripts do (no classes, getters, `instanceof`,
typed arrays), which is why `Shape` is a constructor function with prototype methods.

## Build

Submodules first: `git submodule update --init --recursive`. Manifold fetches Clipper2 with
CMake's FetchContent, so the first configure needs network.

```sh
npm run core:native     # cmake -S core -B build/native && cmake --build build/native
build/native/temencore model.js -o model.stl
build/native/temencore project-dir/

npm run core:wasm       # emcmake cmake -S core -B build/wasm && cmake --build build/wasm  (needs emsdk on PATH)
npm run core:test       # node core/test/smoke.mjs — exact volumes through the wasm build
```

The wasm build lands in `core/wasm/dist/` (ignored by git); `core/wasm/index.js` wraps it with
`createRuntime()` → `run(files)` returning `{ ok, error, messages, parts, ms }`, the same shape the
browser worker produces today so the app can swap runtimes.

## What works

Primitives (`box`/`cube`, `sphere`, `cylinder`, `cone`), booleans (`union`, `difference`,
`intersect`, `hull`), transforms, `bounds`/`align`/`onPlate`, naming, colours, ghost/hidden,
`echo`/`log`/`assert`/`show`, multi-file projects with relative imports, font imports as names,
return of a shape, an array or a named object, mesh extraction, binary STL from the CLI.
Each run gets a fresh engine context; Manifold objects are released in bulk after the run, as
the browser app does with `releaseAll()`.

Not yet: sketches and 2D, extrude/revolve/sweep, fillets, text, images and meshes, screws and
holes, placement helpers, measurements, printability, the printer profile. These are the next
slices of `src/cad.js` and friends to bring across into `prelude.js` plus natives.

## lamassu changes needed

Found while building this. None is worked around here; each is the gap as it stands and the fix
that seems right. The host currently includes three internal headers (`js_bytecode.h`,
`js_error.h`, `js_syntax.h`) to reach the first two items.

1. **Native function values.** `js_register_native` only defines globals. Building the `__cad`
   namespace object needs a native as a *value* to store in a property. `js_native_new(ctx, name,
   fn, ud)` exists in `js_interp.c` and does exactly this; it should move to `lamassu.h`. While
   there, `JsNative.ud` is stored but never handed to the function; passing it as a parameter (or a
   `js_native_userdata(ctx)` accessor during a call) would let one C function serve many methods.
2. **Error constructors.** A native that wants to throw a `TypeError` or `RangeError` has no public
   way to make one; `js_error_new(ctx, kind, message)` and `js_error_from_ascii` in `js_error.h`
   should be public, with `JsErrorKind`.
3. **Error locations with module identity.** `js_context_error_pos` gives a source offset but not
   which module it is in, so a project with more than one file cannot map an error to a file, and a
   throw inside the prelude (every `assert()` failure, every argument error) points at the prelude,
   not at the script line that called it. Functions already know their module
   (`JsFunctionCell.module`) and have line tables (`JsLineEntry`), so the fix is a stack capture:
   `js_context_stack(ctx, JsStackFrame *out, size_t max)` returning `{ specifier, offset }` per
   frame of the current fiber, callable from a native (for `echo()` and warnings, which need the
   caller's line) and recorded on an Error object when it is created (so a rejection carries its
   trace). This replaces the browser runner's `new Error().stack` parsing. Until then the host
   reports a location only when the offset falls inside main.js and assumes it belongs there.
4. **Evicting a module from the registry.** Modules stay in a context's registry, so running
   main.js twice in one context returns the first evaluation. The host rebuilds the context per run
   (cheap: one prelude compile). A `js_context_reset_modules(ctx)` or per-module eviction would let
   the prelude stay compiled across runs.
5. **Line and column helper.** `js_source_line_col` lives in the frontend header; a public form
   (or offsets reported as line/column directly) would avoid the host keeping the wrapped source
   around just to map positions.
6. **Finalizers (later).** Shapes are released in bulk per run, so this is not blocking, but a
   long-lived interactive session that keeps shapes between runs would need a per-object hook when
   the engine collects the wrapper.
7. **Top-level `return` in the entry (nice to have).** main.js is wrapped in
   `export default async function main() {}` with imports hoisted onto line 1, as the browser app
   does, which costs a one-line offset in every location. A compile flag allowing a top-level
   `return` in a module would remove the wrapping.

Language gaps that scripts hit, now documented in `api.html` (Script language) and the skill:
getters/setters in object literals, object rest in destructuring,
`instanceof`, `Array.from({ length })`, `flatMap`. Object key order follows hash order, which the
runner relies on for part order from `return { body, lid }`; the planned "shapes" work in lamassu
fixes that.

## Swift and native use

`include/temencad.h` is plain C with no Emscripten or POSIX dependence beyond `clock_gettime`.
A Swift package would compile `src/` plus the two submodules' sources the way lamassu's own
`packages/swift` does (symlinked sources, one copy of the C), and call `temen_run` with the
project's files; parts come back as float and index buffers ready for SceneKit or Metal.
