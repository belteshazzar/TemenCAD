---
name: temencad
description: Write, build and check TemenCAD models (code-driven CAD for 3D printing, JavaScript scripts built with the Manifold kernel). Use when asked to model a part, a bracket, an enclosure, a lithophane or any printable object with TemenCAD, or to edit a .js model script or a .temen project.
---

# Modelling with TemenCAD

A TemenCAD model is a JavaScript script. Units are millimetres, **Y is up**, the build plate is y = 0 and +Z is the front. Every operation returns a new shape; nothing is mutated. Return a shape, an array of shapes, or an object of named parts (`return { body, lid }`).

## Before writing a script

Run `npx temencad api` (in this repository: `node bin/temencad.mjs api`) and read the reference. Only the functions it lists exist. If you cannot run it, fetch https://belteshazzar.github.io/TemenCAD/api.txt.

## The loop

1. Write `model.js`. Declare dimensions as named constants at the top so the part stays parametric.
2. Build and look: `npx temencad model.js -o model.stl --png model.png --views iso,top,front,right`, then view the PNG: each view is labelled with the part names, its size, a scale bar and axes; ghosts (reference parts) are translucent. `--section y=5` cuts the model open to inspect holes and cavities. Read every `Warning` and `ECHO` line. Use `echo(shape.bounds())` and `assert()` liberally while developing.
   - Model the thing the part must fit as a ghost (`show(ref, { ghost: true })`) and check it in code: `assert(clearance(part, ref) >= 0.5, 'binds')`, `assert(!intersects(cutter, wall))`, `echo(interference(a, b))`. `overlap(a, b)` returns the shared volume as a shape you can show.
3. Check the plate when the printer is known: `--plate prusa-mk4` (`--list-plates` for presets, or `220x220x250`).
4. Export STL for single-material prints or `-o model.3mf` for named, coloured parts.

## Conventions that avoid most mistakes

- Put parts on the plate with `.onPlate()`. Sketches live on the ground plane: sketch x is world X, sketch y is world −Z, `extrude` goes up Y.
- Cutters for screws (`screwHole`, `nutPocket`, `heatInsert`) have their top at y = 0: translate them to the top face before subtracting.
- `union`, `difference`, `intersect` accept arrays; `grid`, `linearArray`, `polarArray` return arrays, so wrap them in `union()`.
- Name parts with `.name('lid')` or by returning an object; set colours with `.color('#hex')` for multi-material 3MF.
- Keep segment counts moderate (`segments: 48` for visible cylinders) and fillets small relative to the faces they sit on.

## Design for printing

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
