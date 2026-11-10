# Working on and with TemenCAD

TemenCAD is a code-driven CAD for 3D printing: a JavaScript script is the model. This file is for any agent (Claude Code, Codex, Cursor, a CI bot) working in this repository or writing TemenCAD models.

## Learn the modelling API first

- `npm run api` (or `npx temencad api`) prints the complete API reference as plain text. It is generated from `api.html`, which is the single source of truth: the in-app assistant, the editor's autocomplete catalogue (`src/api-catalog.js`) and the published `api.txt` all derive from it or must be kept in step with it.
- A model skill with the conventions and the build-check loop lives in `.claude/skills/temencad/SKILL.md`. Copy it into any project where you write TemenCAD scripts.

## Build and check a model without a browser

```sh
node bin/temencad.mjs model.js -o model.stl --png model.png   # build, export, and render a picture to look at
node bin/temencad.mjs model.js --plate prusa-mk4              # exit code 2 if it does not fit the plate
node bin/temencad.mjs project.temen -o out.3mf --parts        # a .temen archive; one STL per named part too
```

The build prints `ECHO` lines from `echo()`, warnings with file and line, and errors with a stack mapped back to the script. `assert()` stops the build with a message. Look at the PNG: it is the same isometric view as the app.

## Repository map

- The modelling API lives in the core: `core/src/prelude.js` (JavaScript in the lamassu subset: Shape, sketches, paths, fillets, placement, text, images, printability) over the natives in `core/src/natives.c`, `core/src/text.c` and `core/src/image.c`, with Manifold through its C binding.
- `src/core-runner.js` builds a project on the core (`core/wasm`): the only runtime in the worker (`src/worker.js`) and on the command line; `src/headless.js` is the Node entry used by the CLI and the catalogue build; `src/render.js` draws the view sheet (labels and section cuts through the core); `src/mesh-check.js` is the CLI's printability over built meshes.
- `src/main.js` wires the app; `src/tabs.js` file tabs; `src/chat.js` and `src/agent.js` the in-app assistant (its system prompt embeds the API reference); `src/completions.js` autocomplete.
- `api.html` the reference; `README.md` the user guide; `src/default-script.js` the demo script that shows every feature.
- `core/` the runtime as one C library (branch `lamassu-runtime`): lamassu-js runs the script, Manifold's C binding does the geometry, `core/src/prelude.js` defines the API on top of the `__cad` natives. `core/src/archive.c` reads and writes `.temen` zips (vendored miniz) with the same rules as `src/project.js`. `core/README.md` has the build, what works and the lamassu changes still needed; `core/swift/` is the Swift package (XCFramework built by `build-xcframework.sh`). `third_party/lamassu-js` and `third_party/manifold` are git submodules (`git submodule update --init --recursive`).
- `ios/` the iPhone and iPad app (SwiftUI chat with a SceneKit preview, the core through the Swift package, the assistant ported to Swift); `ios/README.md` has the build. Its assistant shares `src/assistant-rules.txt` and `public/api.txt` with the web one (`ios/scripts/sync-resources.sh` copies them).
- Related repositories: `TemenCAD-catalog` (shared shapes, static site, publish worker) and `TemenCAD-web` (product site), both depend on this one via `github:belteshazzar/TemenCAD`.

## When adding an API function

1. Implement it in `core/src/prelude.js` (and a native in `core/src/natives.c` only where geometry crosses into Manifold), and add it to the `api` object at the end of the prelude.
2. Document it in `api.html` (one operation per line with a comment, alphabetical within its section).
3. Add it to `src/api-catalog.js` for autocomplete.
4. Show it in `src/default-script.js` if it is user-facing, and mention it in `README.md`.
5. Test it headlessly with a script and `node bin/temencad.mjs script.js --png out.png`; check exact volumes where a closed form exists; add a check to `core/test/smoke.mjs`.
6. `npm run core:wasm`, `npm run core:test`, `npm run core:diff` and `npm run build` must pass (the last regenerates `public/api.txt`).
