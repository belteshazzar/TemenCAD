---
name: temencad
description: Write, build and check TemenCAD models (code-driven CAD for 3D printing, JavaScript scripts built with the Manifold kernel). Use when asked to model a part, a bracket, an enclosure, a lithophane or any printable object with TemenCAD, or to edit a .js model script or a .temen project.
---

# Modelling with TemenCAD

A TemenCAD model is a JavaScript script. Units are millimetres, **Y is up**, the build plate is y = 0 and +Z is the front. Every operation returns a new shape; nothing is mutated. Return a shape, an array of shapes, or an object of named parts (`return { body, lid }`).

## Before writing a script

Run `npx temencad api --list` (in this repository: `node bin/temencad.mjs api`) for the headings, then `npx temencad api <section or function>` for the parts you need, e.g. `api sweep`, `api edges`, `api placement`. Only the functions it lists exist. `npx temencad eval "screw('M4')"` answers a quick question (an expression, or statements that `echo`/`return`). If you cannot run it, fetch https://belteshazzar.github.io/TemenCAD/api.txt.

## The loop

1. Write `model.js`. Declare dimensions as named constants at the top so the part stays parametric.
2. Build and look: `npx temencad model.js -o model.stl --png model.png --views iso,top,front,right`, then view the PNG: each view is labelled with the part names, its size, a scale bar and axes; ghosts (reference parts) are translucent. `--section y=5` cuts the model open to inspect holes and cavities. (In the app the same sheet comes from Menu → Render views…, and the in-app assistant has it as the `render_views` tool.) Read every `Warning` and `ECHO` line. Use `echo(shape.bounds())` and `assert()` liberally while developing.
   - Add `dimension(a, b, { offset })` between the points or faces that matter and `mark(point, 'text')` on key features: they are drawn on the sheet and listed in the report, so a wrong offset shows up as a wrong number. They are never geometry.
   - Model the thing the part must fit as a ghost (`show(ref, { ghost: true })`) and check it in code: `assert(clearance(part, ref) >= 0.5, 'binds')`, `assert(!intersects(cutter, wall))`, `echo(interference(a, b))`. `overlap(a, b)` returns the shared volume as a shape you can show.
3. Run `--check` (overhangs past 45°, islands and bridges, walls under 0.8 mm, below the plate) and read `--report report.json` instead of parsing the console: it holds every part's bounds, volume, surface area and centre of mass, the warnings with file and line, the echo lines and the plate check. In the script, `assert(printability(part).ok, 'needs supports')` makes the build fail until the design prints cleanly.
4. Check the plate when the printer is known: `--plate prusa-mk4` (`--list-plates` for presets, or `220x220x250`).
5. For a folder of models, `npx temencad test folder/ --check` builds them all and fails on any error, failed assert or printability problem; `--json` for tooling.
6. Export STL for single-material prints or `-o model.3mf` for named, coloured parts.

## Conventions that avoid most mistakes

- Put parts on the plate with `.onPlate()`. Sketches live on the ground plane: sketch x is world X, sketch y is world −Z, `extrude` goes up Y.
- Cutters for screws (`screwHole`, `nutPocket`, `heatInsert`) have their top at y = 0: put them on a face with `cutter.at(part.face('top'), [x, z])` (works for any face: +Y turns along the normal) rather than translating by hand.
- Record the points that matter as anchors on the shape they belong to: `board.anchor('lens', [0, 1.2, -4.8], [0, 1, 0])`; after `placeOn`, `rotate` or a union, `assembly.anchor('lens')` still gives the world point, and `at(anchor)`, `distance`, `dimension` and `mark` all accept it.
- Draw profiles with the pen: `sketch().moveTo(0, 0).lineTo(30, 0).arcTo(30, 10, { r: 5 }).lineTo(0, 10).fillet(2).close()`, `tangentArcTo` for smooth blends, `close({ mirror: 'y' })` for symmetric outlines; then `extrude`, `revolve` or `sweep` it.
- Place by named features, not coordinates: `boss.placeOn(plate, 'top', { at: [x, z] })`, `lid.alignTo(body, { x: 'center', z: 'center', y: 'above' }, { gap: 0.3 })`, `rectPattern(21, 12.5)` for a hole pattern, `distance(a.face('top'), b.face('bottom'))` to check. Offsets in `at` and `placeOn` are from the face centre, so do not add the part's own position to them.
- `union`, `difference`, `intersect` accept arrays; `grid`, `linearArray`, `polarArray` return arrays, so wrap them in `union()`.
- Name parts with `.name('lid')` or by returning an object; set colours with `.color('#hex')` for multi-material 3MF.
- Keep segment counts moderate (`segments: 48` for visible cylinders) and fillets small relative to the faces they sit on.

## Design for printing

- Labels and logos: `part.emboss('v2', part.face('front'), { depth: 0.8, size: 6 })` or `engrave`; both take a sketch too, orient it to read from outside, centre it on the face (or `at: [u, v]`), and work on anchors with a direction.
- Declare the printer at the top: `printer({ nozzle: 0.4, layer: 0.2, holeCompensation: 0.2 })`. Then `wall(1)` gives a wall of whole extrusion lines (1.2), `layers(3.1)` a height of whole layers (3.2), `fit(6, 'slide')` the hole diameter for a 6 mm peg and `peg(6, 'slide')` the peg for a 6 mm hole; `hole()` compensates itself. Kinds: press, snug, slide, clearance, loose, or an allowance in mm.

- Horizontal holes: `hole(r, length, { axis: 'z' })` gives a teardrop that prints without sagging; `shape: 'bridge'` keeps it round with a flat ceiling; `flat` clips the point near a surface.
- Counterbores printed head-down: `screwHole('M4', L, { type: 'counterbore', bridge: 0.2 })` leaves a sacrificial layer to drill out.
- Where a boss or wall meets a plate: `part.fillet(r, { edges: 'concave' })` adds strength. `edges: 'top'` softens outer edges; `chamfer(0.5, { edges: 'bottom' })` counters elephant's foot. Fillets work on solids with flat faces; the facets of cylinders are left alone.
- Handles, hooks, channels, springs: `sweep(profile, path)` with `path([...]).smooth()`, `arc`, `helix` or `bezier`; `frame: 'upright'` keeps a rail level.
- Pictures: add a `.png` or `.jpg` to the project folder, `import photo from './photo.png'`, then `lithophane(photo, { width: 80, upright: true })` or `heightmap(photo, { width: 60, height: 4 })`.
- Multi-file projects: other `.js` files are ES modules (`export const lid = ...`, `import { lid } from './lid.js'`); fonts (`.ttf`), meshes (`.stl`) and images import the same way. A `.temen` file is a zip of those files with `main.js` as the entry.
- Shared shapes: `npx temencad add parametric-hinge` vendors a catalogue package into `catalog/` and adds its import.

## Common errors

- "mesh is not a closed, manifold solid": a hand-built `polyhedron` or a sweep whose bend is tighter than the profile. Increase the bend radius or the segment length.
- "X is empty (no volume) and was skipped": a subtraction removed everything, or a sketch was extruded with height 0.
- An imported file is "not a script, font, mesh or image file": only `.js`, `.mjs`, `.json`, `.ttf`, `.otf`, `.stl`, `.png`, `.jpg` can be imported.
