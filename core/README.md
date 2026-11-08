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
npm run core:diff       # node core/test/diff.mjs — every test script, old runner vs core
```

The wasm build lands in `core/wasm/dist/` (ignored by git); `core/wasm/index.js` wraps it with
`createRuntime()` → `run(files)` returning `{ ok, error, messages, parts, ms }`, the same shape the
browser worker produces today so the app can swap runtimes.

## What works

Primitives (`box`/`cube`, `sphere`, `cylinder`, `cone`, `roundedBox`, `torus`, `polygon`, `prism`),
booleans (`union`, `difference`, `intersect`, `hull` including hulls of raw points), transforms,
`resize`, `bounds`/`align`/`onPlate`, arrays (`linearArray`, `polarArray`, `grid`), naming, colours,
ghost/hidden, `echo`/`log`/`assert`/`show`, multi-file projects with relative imports, font imports
as names, return of a shape, an array or a named object, mesh extraction, binary STL from the CLI.

The 2D layer: `Sketch` with translate/rotate/scale/resize/mirror, 2D booleans and hull, `offset`,
`fillet`, `chamfer`, `bounds`, `area`, `toPolygons`; `circle`, `ellipse`, `rect`/`square`,
`roundedRect`, `regularPolygon`, `polygon2d` with holes, `slot`, `teardrop`, `bridgedCircle`; the
pen (`sketch().moveTo/lineTo/line/horizontal/vertical/arcTo/tangentArcTo/fillet/close`); `extrude`
(centre, twist, scale, slices), `revolve`, `projection` (footprint or a cut). Booleans and `hull`
dispatch to 2D when every argument is a sketch, as in the app.

Screws and holes: `SCREWS`, `screw`, `screwHole` (clearance, tap, counterbore, countersunk, `bridge`),
`nutPocket`, `heatInsert`, `hole` (teardrop, bridge, round; any axis). The printer profile: `printer`,
`printProfile`, `wall`, `layers`, `fit`, `peg`, `FITS`; a declared profile compensates `hole()` and is
returned to the host (`temen_profile`, `result.profile`).

Each run gets a fresh engine context; Manifold objects are released in bulk after the run, as
the browser app does with `releaseAll()`.

Not yet: `text`/`text3d`/`emboss`/`engrave` (fonts),
placement (`Face`, `placeOn`, `alignTo`, anchors, patterns), measurements, paths and `sweep`,
3D fillets and chamfers, `loft`/`shell`/`minkowski`/`polyhedron`/`roof`, images and mesh imports,
printability. `npm run core:diff` says which test scripts the core already builds identically.

## Differential test

`core/test/diff.mjs` builds every script under `test/` and the demo script with both the
JavaScript runner and the core, and compares part names, volumes and bounds. `ok` is parity,
`UNSUPPORTED` means the core rejected the script (the port is incomplete there), `DIFF` means
both built it and disagree — the one to look at. Every script the core can build today builds identically.

## lamassu changes needed

Found while building this. None is worked around here; each is the gap as it stands and the fix
that seems right. The host currently includes two internal headers (`js_bytecode.h`,
`js_error.h`) to reach the first two items.

1. **Native function values.** `js_register_native` only defines globals. Building the `__cad`
   namespace object needs a native as a *value* to store in a property. `js_native_new(ctx, name,
   fn, ud)` exists in `js_interp.c` and does exactly this; it should move to `lamassu.h`. While
   there, `JsNative.ud` is stored but never handed to the function; passing it as a parameter (or a
   `js_native_userdata(ctx)` accessor during a call) would let one C function serve many methods.
2. **Error constructors.** A native that wants to throw a `TypeError` or `RangeError` has no public
   way to make one; `js_error_new(ctx, kind, message)` and `js_error_from_ascii` in `js_error.h`
   should be public, with `JsErrorKind`.
3. **Error locations with module identity — done** (lamassu branch `error-locations`).
   `js_context_error_stack` returns the frames captured when the last exception started unwinding,
   innermost first, each with its module specifier and source offset; `js_context_stack` gives a
   native the frames of the running fiber, so `echo()` and warnings know the script line that called
   them; a compile error in a module carries a one-frame trace naming the module. The host walks a
   trace to the first frame in one of the project's files, which skips the prelude, so an `assert()`
   or an argument error points at the script. `test/test_stack.c` in lamassu covers it.
4. **Evicting a module from the registry.** Modules stay in a context's registry, so running
   main.js twice in one context returns the first evaluation. The host rebuilds the context per run
   (cheap: one prelude compile). A `js_context_reset_modules(ctx)` or per-module eviction would let
   the prelude stay compiled across runs.
5. **Line and column helper — done.** `js_source_line_col` moved into the runtime and `lamassu.h`.
6. **Finalizers (later).** Shapes are released in bulk per run, so this is not blocking, but a
   long-lived interactive session that keeps shapes between runs would need a per-object hook when
   the engine collects the wrapper.
7. **Transcendental accuracy — done.** The kernel is now musl's fdlibm-derived code
   (`src/runtime/fdlibm/` in lamassu), < 1 ulp, built with `-ffp-contract=off` so native and wasm
   agree to the bit. `test/sketch-path.js` now matches the JavaScript runner. V8 itself has moved on
   to LLVM libc's correctly-rounded functions, so about 2% of results still differ from Node by one
   ulp; bit-identical output with modern Node would need a correctly-rounded kernel, a separate
   project.
8. **Number to string is not always the canonical shortest form.** For about 1% of doubles the
   printed digits differ from V8 in the last place while naming the same value
   (0.09983341664682816 for what V8 prints as 0.09983341664682815). Harmless for geometry; it
   shows in `echo()` text compared across runtimes.
9. **Top-level `return` in the entry (nice to have).** main.js is wrapped in
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
