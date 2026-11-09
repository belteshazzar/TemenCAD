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

Placement and measurement: `s.face()`, `Face.point`, `placeOn`, `at()` on faces and anchors,
`alignTo`, anchors that travel through transforms and booleans (`s.anchor(name, point, normal)`,
`s.anchor(name)`, `s.anchors`), `distance`, `rectPattern`, `gridPattern`, `intersects`,
`interference`, `overlap`, `clearance` (Manifold's min-gap), and the annotations `dimension` and
`mark`, delivered to the host as JSON records (`temen_annotation`, `result.annotations`).

Paths and sweeps: `Path` with transforms, `smooth`, `append`, `length`, `pointAt`, `tangentAt`;
`path`, `line`, `arc`, `helix`, `bezier`; `sweep` with minimal or upright frames, twist, scale and a
varying profile (and the tight-bend warning); `polyhedron` and `loft`, all through one native that
builds a solid from raw triangles plus Manifold's polygon triangulation for caps.

Edge fillets and chamfers: `fillet`, `chamfer`, `sharpEdges`, the edge selectors ('all', 'top',
'bottom', 'horizontal', 'vertical', 'convex', 'concave', lists, functions), concave-then-convex
passes with mitred chains; the mesh is read through the `mesh` native and the edge walk stays in the
prelude (test/fillet.js builds in 117 ms against 83 ms on V8).

Text: `text`, `text3d`, `emboss`, `engrave` on faces and anchors. Glyph outlines come from
stb_truetype in `src/text.c` (TrueType and CFF, cmap, advances, GPOS/kern kerning), laid out like
opentype.js (advance, kerning, letterSpacing * size, alignment) and flattened with `curveSegments`
points per curve. The five bundled fonts are embedded at build time; a project's `.ttf`/`.otf`
files are registered for the run and named by their path, as in the app. Not covered: GSUB
ligatures, which opentype.js applies to Latin text by default, so "fi" stays two glyphs here.

Images and mesh imports: `import photo from './photo.png'` (PNG, JPEG and the other formats
stb_image reads, in `src/image.c`) gives a `GrayImage` with `at`, `sample`, `invert`, `gamma`,
`normalize`, `blur`, `crop`, `resize`, `flip`; `heightmap` and `lithophane` build reliefs from an
image or a function; `import part from './part.stl'` reads binary or ASCII STL, welded and turned
Y-up. PNG decoding is exact, so reliefs match the app; JPEG decoders round differently, so JPEG
brightness can differ by a few 1/255. Resize, blur and the relief mesh run natively; test/images builds in
0.45 s against 1.0 s on V8.

Printability: `overhangs`, `unsupported` (islands and bridges by casting rays downward),
`minWallThickness` (rays cast inward from an area-weighted sample of faces), `printability` with
its verdict and problem list, and the first-layer rule; all over the `mesh` native in the prelude.

Minkowski and shells: `minkowski`, `s.round`, `s.erode` (exact plane trimming for convex solids,
a Minkowski difference otherwise), `shell` with open sides, and `roof`, built Y-up with the same
batching of cone cutters as the app.

Each run gets a fresh engine context; Manifold objects are released in bulk after the run, as
the browser app does with `releaseAll()`.

Every script under `test/` and the demo script build identically on both runtimes
(`npm run core:diff`: 12 ok, 0 differ, 0 unsupported). The per-triangle and per-pixel loops that
were slow on the interpreter now run natively with the same arithmetic: `solidFromTriangles`
(consistent orientation, build, volume-sign flip, used by sweep, loft, fillet, polyhedron, STL
import), `heightmapSolid`, `minWall`, `imageResize` and `imageBlur`. Timings against V8 today:
images 0.45 s vs 1.0 s, print 0.11 s vs 0.09 s, sweep 0.19 s vs 0.24 s, the demo 0.23 s vs 0.25 s;
the rest within a few tens of milliseconds. The JavaScript they replaced lives on in the app's
`src/mesh.js`, `src/image.js` and `src/print.js` until the app swap retires them.

Note on fonts: the vendored `stb_truetype.h` is patched to keep vertex coordinates as floats, so
the implied on-curve point between two off-curve points is the exact midpoint. The stock header
halves it with an integer shift, which moved TrueType outlines by half a font unit against
opentype.js. With the patch, text outlines agree with the app to the last digit. `npm run core:diff` says which test scripts the
core already builds identically.

## In the app

`src/core-runner.js` wraps `core/wasm/index.js` behind the `runScript` contract the app always used;
the worker (`src/worker.js`) and the command line (`src/headless.js`) build on it, and nothing else.
The JavaScript modelling layer that preceded the core (`runner.js`, `cad.js` and friends, the
`manifold-3d` and `opentype.js` packages) is gone: `src/render.js` draws its labels with
`temen_text_outlines` and cuts sections with `temen_cut_mesh`, both part of the C API, and the
CLI's `--check` runs `src/mesh-check.js` over the built buffers. CI installs the Emscripten SDK and
runs `npm run core:wasm` before the tests and the site build.

## Regression test

`core/test/diff.mjs` builds every script under `test/` and the demo script on the core and compares
part names, volumes, bounds, colours, flags, annotations and the printer profile with
`core/test/golden.json`: what the JavaScript modelling layer produced, recorded when the two
runtimes built every script identically, just before that layer was retired. `DIFF` means the core
has moved from that reference.

## lamassu changes needed

Found while building this. None is worked around here; each is the gap as it stands and the fix
that seems right. The core builds against `lamassu.h` alone.

1. **Native function values — done.** `js_native_new` is public, and `js_native_userdata(ctx)` hands a
   native the userdata it was created with (restored across nested `js_call`s), so one C function can
   serve many natives.
2. **Error constructors — done.** `JsErrorKind`, `js_error_new_ascii` and `js_error_new_utf16` are
   public; the core no longer includes any internal lamassu header.
3. **Error locations with module identity — done** (lamassu branch `error-locations`).
   `js_context_error_stack` returns the frames captured when the last exception started unwinding,
   innermost first, each with its module specifier and source offset; `js_context_stack` gives a
   native the frames of the running fiber, so `echo()` and warnings know the script line that called
   them; a compile error in a module carries a one-frame trace naming the module. The host walks a
   trace to the first frame in one of the project's files, which skips the prelude, so an `assert()`
   or an argument error points at the script. `test/test_stack.c` in lamassu covers it.
4. **Evicting a module from the registry — done.** `js_context_evict_module` forgets a module and
   every module that imports it; `js_context_module_count` / `js_context_module_specifier` enumerate
   the registry. The host keeps one context for the life of the core and evicts the previous
   project's modules before each run, so the prelude stays compiled: fifty small builds went from
   269 ms to 19 ms. The longer-lived context exposed four natives that created several engine
   values before rooting them (fixed; `TEMEN_GC_STRESS=1` makes the collector run at every safe
   point to shake out such bugs, and `TEMEN_GC_THRESHOLD=<bytes>` sets how much engine and host
   memory may build up before a collection).
5. **Line and column helper — done.** `js_source_line_col` moved into the runtime and `lamassu.h`.
6. **Finalizers — done.** `js_host_object_new` makes an ordinary object that owns a host pointer,
   with a per-class finalizer the collector runs when the object becomes unreachable (or the VM is
   freed); `js_host_object_ptr` checks the class. Shapes and sketches are now such objects owning
   their Manifold object, so geometry lives as long as the script can reach it rather than until
   the run ends. `external_bytes` lets host memory pace the collector: each object claims 64 KB
   (sketches 8 KB), raised to about 240 bytes a triangle wherever the mesh already exists
   (primitives, extrusions, hulls, imported meshes, and after volume/bounds/mesh queries). 300
   measured 8192-triangle spheres now peak at 17 MB instead of 576 MB, at the same speed. Running
   startup under `TEMEN_GC_STRESS=1` found the installers passing fresh, unrooted atoms to
   `js_object_set` (fixed); `test/test_host.c` in lamassu covers the API.
7. **Transcendental accuracy — done.** The kernel is now musl's fdlibm-derived code
   (`src/runtime/fdlibm/` in lamassu), < 1 ulp, built with `-ffp-contract=off` so native and wasm
   agree to the bit. `test/sketch-path.js` now matches the JavaScript runner. V8 itself has moved on
   to LLVM libc's correctly-rounded functions, so about 2% of results still differ from Node by one
   ulp; bit-identical output with modern Node would need a correctly-rounded kernel, a separate
   project.
8. **Function values take no properties.** `GrayImage.fromFunction = …` fails with "cannot create
   property on a primitive value", so the app's statics on constructor functions (`Sketch.fromPoints`,
   `GrayImage.fromRGBA`) cannot be written in the subset; the prelude keeps them as plain functions.
   With classes out, properties on functions are the natural home for statics.
9. **Number to string is not always the canonical shortest form.** For about 1% of doubles the
   printed digits differ from V8 in the last place while naming the same value
   (0.09983341664682816 for what V8 prints as 0.09983341664682815). Harmless for geometry; it
   shows in `echo()` text compared across runtimes.
10. **Top-level `return` in the entry (nice to have).** main.js is wrapped in
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
`core/swift/` is the Swift package: `build-xcframework.sh` builds the core, lamassu, Manifold and
Clipper2 with CMake for macOS (arm64 + x86_64), iOS and the iOS simulator and merges them into
`TemenCore.xcframework`; the `TemenCAD` target wraps the C API (`TemenCore().build(files:)` →
parts as float and index buffers, messages with script lines, annotations, the printer profile).
`swift test` in that folder builds a cube, a multi-file project with text and a profile, and an
assert failure with its line. See `core/swift/README.md`.
