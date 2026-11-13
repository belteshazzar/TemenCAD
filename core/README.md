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
 src/archive.c   .temen archives         C: zip read / write in memory, the web app's project rules
 src/export.c    STL and 3MF             C: the web app's src/export.js, byte for byte
 src/pick.c      pointing and measuring  C: the web app's src/pick-geometry.js, word for word
 src/render.c    the render sheet        C: the web app's src/render.js, pixel for pixel
 src/conversation.c  the chat in a .temen    C: format 2 (CONVERSATION.md), over json.c and codec.c (SHA-256, base64)
 ───────────────────────────────
 lamassu-js (third_party)   manifold + Clipper2 (third_party)   miniz (core/third_party)
```

`.temen` projects are plain zips. `temen_archive_read` / `temen_archive_write` read and write them in
memory with the vendored miniz 3.1.2 (MIT, compiled without stdio and without zlib names, so it cannot
clash with a system zlib); `temen_project_read` applies the rules of the web app's `Project.fromZip`
(`src/project.js`: paths normalized, folders, `__MACOSX/` and dotfiles dropped, a lone script becomes
`main.js`, `.assistant/` kept apart as extras) and must stay in step with it. None of this needs a
`TemenCore`. The browser keeps using fflate, so the WebAssembly build does not link it. The native
`temencore` tool builds a `.temen` directly; `core/test/project.temen` and `lone.temen` are fixtures
written by fflate, built by `core/test/run-native.sh` and read by the Swift tests.

`temen_write_stl` and `temen_write_3mf` (`src/export.c`) write parts as the web app's `src/export.js`
does, byte for byte (3MF compared file by file inside the zip, since the two zip writers differ): the
same Z-up coordinates, normals rounded as V8's `Math.hypot` gives them, and numbers formatted as
`toFixed(5)` rounds ties, away from zero. `npm run core:export` (`core/test/export-parity.mjs`) checks
it on every test script, the demo and a `.temen` against the JavaScript command line; keep the two
files in step. The native `temencore -o out.3mf` uses them.

`temen_pick_*` (`src/pick.c`) is what the user tapped on a part's mesh: the whole flat face, or the
hole, boss, fillet or sphere it belongs to (welded topology, coplanar facets, then a smooth region fitted
with a cylinder or sphere), with a short label for a chip and a sentence for the assistant; and the
measurement between two tapped points. It ports `src/pick-geometry.js` operation for operation, down to
summation order, V8's `Math.hypot` and `Math.atan2` (lamassu's fdlibm kernel), so the words match:
`npm run core:pick` (`core/test/pick-parity.mjs`) compares about 60 picks and measurements per part on
every test script and the demo against the JavaScript module (13,429 at the time of writing). The web
app still uses the JavaScript module; keep the two in step.

`temen_render_views` (`src/render.c`) draws the render sheet: labelled views (titles with the size,
part names, scale bar, axes), ghosts translucent, section cuts with red cut faces, the script's
dimensions and marks, as PNG through miniz. It ports `src/render.js` with its float32 colour and depth
buffers, V8's `Math.hypot`, `Math.round` and `toFixed`, lamassu's fdlibm `sin` / `cos`, and the same text
outlines, so `npm run core:render` (`core/test/render-parity.mjs`) finds every pixel identical on every
test script, the demo, sections and unlabelled renders. The native `temencore --png` uses it (`--views`,
`--size`, `--section`, `--no-labels`, as the JavaScript command line takes them).

`temen_conversation_pack` / `temen_conversation_unpack` (`src/conversation.c`) are the assistant
conversation inside a `.temen`, format 2, specified in `CONVERSATION.md`: `.assistant/conversation.json`
and content-addressed `.assistant/blobs/<sha256>`. Packing moves inline base64 sources into blobs and
rewrites references to the app's own blobs to their SHA-256; unpacking checks the format and every
blob's hash and restores the base64 inline. One implementation for every app: the web app calls it in
its worker (`packConversation` / `unpackConversation` in `wasm/index.js`), the iPhone app through
`TemenConversation` in the Swift package. `src/json.c` is a JSON tree that round-trips (key order and
number text kept). `core/test/conversation-test.c` tests it on its own (run by `run-native.sh`, and
under the sanitizers with `cc -fsanitize=address,undefined`); the WebAssembly smoke test and the Swift
tests check the bindings.

Same mesh everywhere: Manifold evaluates booleans lazily, and when it flattens a chain such as
`(a - b) - c` into `a - (b + c)` it only collapses a node nothing else holds (`shared_ptr` use
counts), so shared work is done once. A JS shape holds its node until the collector frees it, so
shapes that were unreachable but not yet collected counted as holders, and the triangulation (never
the volume) followed the collector's timing: what the script allocated before, and 32- against 64-bit
heaps, so the browser and the native core meshed the same script differently. Shapes now carry a
`lazy` flag (booleans, and transforms of lazy shapes), and `temen_settle` in `src/natives.c`
collects garbage once before anything evaluates lazy shapes, then evaluates them in the same native
call, so Manifold sees exactly the shapes the script can still reach. A query on a lazy shape costs
one collection: unmeasurable on the test scripts and the demo, about +5% for a bounds query after
every boolean with 40,000 live JS objects. Ignoring the use counts in Manifold instead was
deterministic too, but recomputes genuinely shared work (20× slower when every intermediate of a
loop is kept and evaluated newest first). `core:test` (4s) and `core:export` check it.

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
8. **Properties on functions — done.** Closures and natives carry an own-property object made on
   the first write, so `F.from = …`, constants and caches on functions work, as do `in`, `delete`,
   `hasOwnProperty`, `Object.keys`/`assign`/`hasOwn` and `freeze`/`seal` on them; builtins' own
   statics stay unlisted. The prelude still spells its statics as plain functions
   (`sketchFromPoints`, `GrayImage` helpers); they can move onto their constructors if wanted.
9. **Number to string — done.** Printing rounded a 17-digit, already rounded string a second time,
   so about 1% of doubles came out with the last digit one too high or a needless 17th digit
   (0.09983341664682816 where V8 prints 0.09983341664682815). It now rounds from a 26-digit
   expansion, asks the C library for the exact digits in the one case that can mislead (an exact
   "5000…" tail), and tries the neighbouring candidate at a power of two, where the round-trip
   interval is lopsided. 1.6 million doubles (random bit patterns, computed values, every power
   of two, subnormals) now print exactly as Node does, against 0.86% differing before.
10. **Top-level `return` in the entry — done.** main.js used to be wrapped in
   `export default async function main() {}` with its imports hoisted onto line 1, which cost a
   one-line offset in every location and kept main.js from exporting. lamassu's `js_eval_entry`
   evaluates it as written: the root module alone may `return` at top level, and the promise
   fulfils with that value. The host calls the prelude's `begin()` before evaluating and `run()`
   with the returned value after. `test_entry_return` in lamassu's `test/test_modules.c` covers it.
11. **Failed calls name their callee — done.** "value is not a function" now reads as V8 words it:
   `s.filet is not a function`, `cube(...).translate(...).rotat is not a function`,
   `a[0] is not a function`, `n is not a constructor`. The compiler records each call site's
   callee as text in a per-function side table read only when a call fails (and carried in
   bytecode caches, format version 4); an expression with no readable name still says "value".
   `test/test_callee.c` in lamassu covers it.
12. **A syntax check without running — done.** Editors mark syntax errors as the user types.
   `js_compile_module` refuses import/export and `js_bytecode_compile_module` never compiles an
   entry, so main.js's top-level `return` came back as an error. lamassu's `js_check_module`
   compiles a module as the loader would, with an `entry` flag, on a record nothing registers,
   links or runs, and returns the message and offset. The core's `temen_check_script` (wasm
   `checkScript`, Swift `TemenCore.checkSyntax`) gives the line and the column in UTF-16 units.
   `test_check_module` in lamassu's `test/test_modules.c` covers it.
14. **Number parsing the same everywhere — done.** lamassu fell back on the C library's `strtod`,
   which Windows (UCRT) does not round correctly next to a power of two, and literals kept only
   their first 19 digits. lamassu now parses with musl's decimal scanner
   (`src/runtime/fdlibm/floatscan.c`) and reads every digit, so a script's numbers are the same
   doubles on every host and in Node (checked on 28,590 strings and 256,195 printed doubles).
   The fdlibm sources also build under GCC with `-Werror` again, so lamassu's own CI is green on
   Linux and Windows for the first time since the kernel arrived.
13. **Errors worded as V8 words them — done.** A module that fails to compile rejected with its
   message as a plain string, so a build said "Error: expected expression" where V8 says
   "SyntaxError: Unexpected token ';'", and the runtime's messages were lamassu's own ("cannot
   read properties of undefined or null"). Now:
   - a module that does not compile rejects with a `SyntaxError` object, and the compiler's
     messages are V8's: `Unexpected token ';'`, `Unexpected identifier 'x'`, `Unexpected end of
     input`, `missing ) after argument list`, `Identifier 'x' has already been declared`,
     `Invalid regular expression: /(/: Unterminated group`;
   - runtime errors carry the names and values V8 puts in them: `Cannot read properties of
     null (reading 'x')`, `Cannot destructure property 'w' of 'a.size' as it is undefined.`,
     `o is not iterable`, `Cannot access 'W' before initialization`, `Cannot add property 1,
     object is not extensible`, `number 5 is not a function`, `Method Map.prototype.get called
     on incompatible receiver 5`; `JSON.parse` says what it expected and where (`Expected ':'
     after property name in JSON at position 4 (line 1 column 5)`);
   - assigning to a `const` is a `TypeError` when the assignment runs, not a compile error, and
     array destructuring of something that is not iterable throws (`const [x] = 5` used to give
     `undefined`) and takes a Map or Set apart by its entries or values.

   The compiler records the text an error needs (an iterated or destructured expression, a
   binding read before its declaration) in the call-site table from item 11, so it costs
   nothing until an error is thrown; the bytecode cache format is version 5. Checked against
   Node on 140 runtime and 76 syntax cases: the differences left are lamassu's "not supported"
   messages, a few V8 quirks, and features lamassu does not have (`Object.create`, a global
   `Function`); lamassu's `docs-site/guide/deviations.md` lists them.
14. **Declaration rules as V8 applies them — done.** A `let`/`const` written before its
   declaration ran (`w = 20` in a function called above `let w = 10`) used to store silently, and
   an exported `let`/`const` read early was `undefined`. Now both throw `Cannot access 'w' before
   initialization`, for writes too (directly, from a closure, from a later `switch` case; a `const`
   reports this before its `TypeError`). The compiler emits checked stores only where a write can
   come early, and module exports start in the TDZ (the exports object holds the marker from
   compile time, and every read of a namespace checks for it), so other code pays nothing.
   Export lists follow V8 as well: `export { a as b }` beside `export let a` writes both names
   (only the first was written), a listed `const` stays constant, an imported name exported again
   is a re-export (it was `undefined`), an undeclared name is `SyntaxError: Export 'x' is not
   defined in module`. Namespace objects are sealed, read-only and list their keys in name order.
   The bytecode cache format is version 6.
15. **Functions made before any module runs — done.** An exported function existed only once its
   own module started running, so in an import cycle the module that ran first could not call
   it from top-level code (`f is not a function`). Now, as in V8, every module's functions are
   made before any module body runs: after linking, each body runs up to a new
   `JS_OP_MODULE_READY` (emitted after its hoisted functions) and parks there, and evaluation
   resumes the parked bodies in dependency order, top-level await included. `export default
   function` is made at that point too, and a named one binds its name in the module. The
   bytecode cache format is version 7. Found on the way: lamassu's own CLI had rejected module
   files with an `export function` since 7e4a96f, and a collection at one point of module
   evaluation was a use-after-free; both are fixed.
16. **Function names as V8 gives them — done.** `f.name` was `undefined` for every function. Now
   it is V8's read-only `name`: the function's own, or for an anonymous function or arrow the
   name of what it is defined as (`const part = () => ...` is `part`, and so are object keys,
   methods, defaults and `export default`), builtins' names, `bound f`. Stack frames show the
   inferred names as V8's do. A named function expression can also call itself by name
   (`const f = function inner(n) { ... inner(n - 1) ... }` threw `inner is not defined`). The
   bytecode cache format is version 8. `String(f)` is `"[function]"` rather than the source.
17. **Function length as V8 gives it — done.** `f.length` was `undefined`. Now it is V8's: a
   script function's parameters before the first default or rest, each builtin's (a table of
   V8's values generated by `tools/gen-builtin-lengths.mjs` in lamassu), and a bound function's
   less the arguments bound. Found on the way: a function with two destructuring parameters
   (`({ x }, [y]) => ...`) did not compile. The bytecode cache format is version 9.
18. **Function source text as V8 gives it — done.** `String(f)` was `"[function]"`. Now
   `f.toString()`, `String(f)`, templates and messages that show a function give V8's text: the
   function's source exactly as written, `function max() { [native code] }` for a builtin, and
   `function () { [native code] }` for a bound function. lamassu keeps one copy of each module's
   source (the prelude's and the script's) while a function from it is alive. The bytecode cache
   format is version 10 and carries the source.
19. **e.stack as V8 gives it — done.** Errors had no `stack`. Now they have V8's: frames taken
   when the error is made, text built when `stack` is first read, V8's frame names (`Object.m`,
   `new C`, `async f`, `at Array.map (<anonymous>)`) and columns, `Error.stackTraceLimit` and
   `Error.captureStackTrace`. Error positions moved to where V8 puts them (a call at its
   callee's name, a property read at the property), which `js_context_error_pos` reports too.
   Found on the way, not yet fixed: `JSON.parse` ignores a reviver, and `replace` with a string
   pattern ignores a function replacement. The bytecode cache format is version 11.
20. **Errors as V8 has them, `instanceof` and `Object.create` — done.** An error's `message` and
   `cause` are no longer enumerated (`JSON.stringify(new Error('x'))` is `{}`). `instanceof` is
   V8's (`e instanceof TypeError`), and `Promise.prototype` is the object with `then`.
   `Object.create(proto)` works; its second argument (property descriptors) is a TypeError, as
   there are no property attributes. Found on the way, not yet fixed: every function has a
   `prototype` (V8 gives arrows, async functions, methods and builtins none), and assigning a
   non-object `F.prototype` is ignored. The bytecode cache format is version 12.

Language gaps that scripts hit, now documented in `api.html` (Script language) and the skill:
getters/setters in object literals, object rest in destructuring,
`instanceof`, `Array.from({ length })`, `flatMap`. Object keys enumerate in the language's order
(array-index names ascending, then insertion order), so parts from `return { body, lid }` come out
as body, lid in every runtime.

## Swift and native use

`include/temencad.h` is plain C with no Emscripten or POSIX dependence beyond `clock_gettime`.
`core/swift/` is the Swift package: `build-xcframework.sh` builds the core, lamassu, Manifold and
Clipper2 with CMake for macOS (arm64 + x86_64), iOS and the iOS simulator and merges them into
`TemenCore.xcframework`; the `TemenCAD` target wraps the C API (`TemenCore().build(files:)` →
parts as float and index buffers, messages with script lines, annotations, the printer profile).
`swift test` in that folder builds a cube, a multi-file project with text and a profile, and an
assert failure with its line. See `core/swift/README.md`.
