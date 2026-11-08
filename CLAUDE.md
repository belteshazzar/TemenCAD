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

- `src/cad.js`, `src/sketch.js`, `src/shape.js`: the modelling API (3D, 2D, Shape class). `src/path.js` paths and `sweep()`; `src/fillet.js` edge fillets and chamfers; `src/image.js` images, `heightmap()` and `lithophane()`; `src/mesh.js` mesh-to-Manifold helpers.
- `src/core-runner.js` builds a project on the core (`core/wasm`), the default runtime in the worker and on the command line; `src/runner.js` + `src/modules.js` are the JavaScript fallback (`?runtime=js`, `TEMENCAD_RUNTIME=js`); `src/headless.js` is the Node entry used by the CLI and the catalogue build; `src/worker.js` the browser worker.
- `src/main.js` wires the app; `src/tabs.js` file tabs; `src/chat.js` and `src/agent.js` the in-app assistant (its system prompt embeds the API reference); `src/completions.js` autocomplete.
- `api.html` the reference; `README.md` the user guide; `src/default-script.js` the demo script that shows every feature.
- `core/` the runtime as one C library (branch `lamassu-runtime`): lamassu-js runs the script, Manifold's C binding does the geometry, `core/src/prelude.js` defines the API on top of the `__cad` natives. `core/README.md` has the build, what works and the lamassu changes still needed; `core/swift/` is the Swift package (XCFramework built by `build-xcframework.sh`). `third_party/lamassu-js` and `third_party/manifold` are git submodules (`git submodule update --init --recursive`).
- Related repositories: `TemenCAD-catalog` (shared shapes, static site, publish worker) and `TemenCAD-web` (product site), both depend on this one via `github:belteshazzar/TemenCAD`.

## When adding an API function

1. Implement it and export it through `api` in `src/cad.js` (or the relevant `*Api` object).
2. Document it in `api.html` (one operation per line with a comment, alphabetical within its section).
3. Add it to `src/api-catalog.js` for autocomplete.
4. Show it in `src/default-script.js` if it is user-facing, and mention it in `README.md`.
5. Test it headlessly with a script and `node bin/temencad.mjs script.js --png out.png`; check exact volumes where a closed form exists.
6. `npm run build` must pass (it regenerates `public/api.txt`).
