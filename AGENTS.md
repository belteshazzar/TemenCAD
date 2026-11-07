# Working on and with TemenCAD

TemenCAD is a code-driven CAD for 3D printing: a JavaScript script is the model. This file is for any agent (Claude Code, Codex, Cursor, a CI bot) working in this repository or writing TemenCAD models.

## Learn the modelling API first

- `npm run api` (or `npx temencad api`) prints the complete API reference as plain text. It is generated from `api.html`, which is the single source of truth: the in-app assistant, the editor's autocomplete catalogue (`src/api-catalog.js`) and the published `api.txt` all derive from it or must be kept in step with it.
- A model skill with the conventions and the build-check loop lives in `.claude/skills/temencad/SKILL.md`. Copy it into any project where you write TemenCAD scripts.

## Build and check a model without a browser

```sh
node bin/temencad.mjs model.js -o model.stl --png model.png   # build, export, and render a picture to look at
node bin/temencad.mjs model.js --png sheet.png --views all     # iso, top, front, right, bottom, back on one sheet, labelled
node bin/temencad.mjs model.js --png cut.png --section y=5     # cut open at a plane; cut faces are red
node bin/temencad.mjs model.js --check --report report.json    # printability warnings (exit 3) and a JSON report to parse
node bin/temencad.mjs model.js --plate prusa-mk4              # exit code 2 if it does not fit the plate
node bin/temencad.mjs project.temen -o out.3mf --parts        # a .temen archive; one STL per named part too
```

The build prints `ECHO` lines from `echo()`, warnings with file and line, and errors with a stack mapped back to the script. `assert()` stops the build with a message. Look at the PNG: part names, the size in each view, a scale bar and an axis triad are drawn on it; ghost (reference) parts are translucent. In the script, `clearance(a, b)`, `interference(a, b)`, `intersects(a, b)` and `overlap(a, b)` measure how parts relate, so `assert(clearance(part, reference) >= 0.5)` makes the build itself catch a bad fit. `printability(part)` reports overhangs past 45°, unsupported islands and bridges, and the thinnest wall; `assert(printability(part).ok)` fails the build until it prints cleanly. Prefer `--report` JSON over parsing the console.

## Repository map

- `src/cad.js`, `src/sketch.js`, `src/shape.js`: the modelling API (3D, 2D, Shape class). `src/path.js` paths and `sweep()`; `src/fillet.js` edge fillets and chamfers; `src/image.js` images, `heightmap()` and `lithophane()`; `src/mesh.js` mesh-to-Manifold helpers.
- `src/runner.js` runs a project (fonts, meshes and images are decoded first); `src/modules.js` turns project files into ES modules; `src/headless.js` is the Node entry used by the CLI and the catalogue build; `src/worker.js` the browser worker.
- `src/main.js` wires the app; `src/tabs.js` file tabs; `src/chat.js` and `src/agent.js` the in-app assistant (its system prompt embeds the API reference); `src/completions.js` autocomplete.
- `api.html` the reference; `README.md` the user guide; `src/default-script.js` the demo script that shows every feature.
- Related repositories: `TemenCAD-catalog` (shared shapes, static site, publish worker) and `TemenCAD-web` (product site), both depend on this one via `github:belteshazzar/TemenCAD`.

## When adding an API function

1. Implement it and export it through `api` in `src/cad.js` (or the relevant `*Api` object).
2. Document it in `api.html` (one operation per line with a comment, alphabetical within its section).
3. Add it to `src/api-catalog.js` for autocomplete.
4. Show it in `src/default-script.js` if it is user-facing, and mention it in `README.md`.
5. Test it headlessly with a script and `node bin/temencad.mjs script.js --png out.png`; check exact volumes where a closed form exists.
6. `npm run build` must pass (it regenerates `public/api.txt`).
