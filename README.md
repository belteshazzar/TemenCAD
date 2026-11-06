# TextCAD

A text-driven 3D modelling playground. Write JavaScript on the left, see the model on the right.

```sh
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

- **Left pane**: CodeMirror editor. The script auto-runs on change (or press Ctrl/Cmd+Enter; a ▶ Run button appears when Auto-run is off).
- **Right pane**: Three.js WebGL viewport. Left-drag rotates, right-drag pans, wheel zooms.
- **Menu** (☰ button in the top-right of the viewport): File section with New, Open… (⌘/Ctrl+O), Save (⌘/Ctrl+S), Save As… (⇧⌘/Ctrl+Shift+S) read and write the script as a plain `.js` file. In Chromium browsers Save overwrites the opened file in place; elsewhere it downloads a copy. **Export STL…** downloads the visible parts as one binary STL; **Export 3MF…** downloads them as a 3MF with each part as a named, colored object (what Prusa, Bambu, Orca and Cura prefer). Both are written Z-up in millimetres.
- **Named parts**: `shape.name('lid')`, `show(shape, { name, ghost, hidden })`, or `return { body, lid }`. The Parts flyout in the menu toggles visibility and ghosting per part, solos on double-click, and exports a single part as STL. Ghosts and hidden parts are never exported.
- **Variables panel**: top-level `const NAME = 12; // Label [min, max, step]` lines appear as sliders (booleans as checkboxes). Dragging a slider rewrites the value in the script.
- **View → Plate** flyout: overlays a printer build plate (Bambu, Prusa, Creality, Elegoo, Voron presets or a custom size) with a 10 mm grid and the printable volume. After each build the visible parts are checked against it; the outline turns red and the console says by how much they don't fit.
- **API reference** (last menu item) opens the full reference (`api.html`) in a new tab. Highlights: 3D primitives incl. `roundedBox`, 2D sketches (`circle`, `rect`, `roundedRect`, `slot`, …) with 2D booleans, `extrude` (twist/scale) and `revolve`, CSG `union`/`difference`/`intersect`, `hull`, `linearArray`/`polarArray`/`grid`, alignment helpers (`onPlate`, `align`), metric screw cutters (`screwHole`, `nutPocket`, `heatInsert`), `polyhedron`, `loft`, `minkowski` / `round` / `erode`, `shell`, 2D `fillet` / `chamfer`, and `text` / `text3d` (bundled Inter font, SIL OFL; see `src/assets/Inter-LICENSE.txt`).
- Units are millimetres, Y is up, the build plate is y = 0. 2D sketches also support `offset()` and `hull()`.
- Your script is saved to `localStorage` between reloads.

Stack: Vite, Three.js (viewer), opentype.js (font outlines), [Manifold](https://github.com/elalish/manifold) (C++ geometry kernel via WebAssembly: booleans, hull, 2D ops, extrude, revolve), CodeMirror 6.

Architecture: the script and all geometry work run in a module Web Worker (`src/worker.js` → `src/runner.js`), so the editor and camera stay responsive during long builds. The worker loads the Manifold wasm once, posts back indexed vertex buffers as transferables, and the viewer (`src/viewer.js`) builds flat-shaded Three.js meshes from them. Cancel terminates and respawns the worker. Every wasm object created during a run is tracked (`src/engine.js`) and freed when the run ends.
