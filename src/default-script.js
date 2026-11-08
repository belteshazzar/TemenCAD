/** The demo script shown on first launch and restored by File → New. */
export const DEFAULT_SCRIPT = `// TemenCAD kitchen-sink demo — write JavaScript, see the model.
// Units are mm, Y is up, the build plate is y = 0. Click "API" for the full list.
// Each block below shows one capability; they are spread out on the plate.
// Dimensions declared up top keep the model parametric: change a number, the model rebuilds.
const T = 10;          // mounting block thickness
const CUP_WALL = 1.6;  // cup wall thickness
const TEXT_SIZE = 7;   // tag text size
const SHOW_TEXT = true;

const parts = [];
// place(shape, x, z, color, name?) — names show up in the Parts panel (top right of the viewport)
const place = (shape, x, z, color, name) => {
  let s = shape.onPlate().translate(x, 0, z).color(color);
  if (name) s = s.name(name);
  parts.push(s);
};

// 1. Primitives: box, sphere, cylinder, cone, torus, prism
place(box(12, 8, 10), -60, -60, '#8fb3ff');
place(sphere(6), -40, -60, '#ff8f8f');
place(cylinder(5, 10), -20, -60, '#8fe3a8');
place(cone(6, 10), 0, -60, '#ffd27f');
place(torus(6, 2), 20, -60, '#d3a6ff');
place(prism(6, 6, 8), 40, -60, '#7fe0e0');

// 2. Rounded boxes: all edges vs. vertical edges only (prints flat)
place(roundedBox(14, 10, 14, 3), -60, -35, '#8fb3ff');
place(roundedBox(14, 10, 14, 4, { edges: 'vertical' }), -40, -35, '#8fb3ff');

// 3. Booleans: union, difference, intersect, plus the method forms
const u = union(box(10), sphere(6.5));
const d = box(10).subtract(sphere(6.5));
const i = intersect(box(10), sphere(6.5));
place(u, -15, -35, '#ffb366');
place(d, 5, -35, '#ffb366');
place(i, 25, -35, '#ffb366');

// 4. Hull: a rounded "pill" bracket from two cylinders, and a hull of raw points
place(hull(cylinder(4, 6), cylinder(4, 6).translate(14, 0, 0)), 45, -35, '#c2e86b');
place(hull([0, 0, 0], [12, 0, 0], [6, 0, 10], [6, 12, 4]), 65, -35, '#c2e86b');

// 5. 2D sketches -> extrude. Sketch x = world X, sketch y = world -Z, extrude goes up Y.
const plate2d = roundedRect(20, 14, 3)
  .subtract(circle(3))
  .subtract(slot(8, 1.2).translate(0, 4))
  .subtract(regularPolygon(6, 2).translate(-6, -3));
place(extrude(plate2d, 3), -60, -5, '#8fe3a8');

// twist + scale extrusion
place(extrude(rect(10, 10), 18, { twist: 90, scale: 0.4 }), -35, -5, '#8fe3a8');

// star outline from polygon2d, extruded
const starPoints = [];
for (let k = 0; k < 10; k++) {
  const a = (k / 10) * Math.PI * 2, r = k % 2 ? 4 : 9;
  starPoints.push([Math.cos(a) * r, Math.sin(a) * r]);
}
const star = polygon2d(starPoints);
place(extrude(star, 4), -10, -5, '#8fe3a8');

// 5b. Draw a profile like a pen: lines, a tangent arc, a per-corner fillet; close() gives a sketch
const bracketProfile = sketch().moveTo(0, 0).lineTo(16, 0).lineTo(16, 4).fillet(1.5).lineTo(4, 4).tangentArcTo(0, 8).lineTo(0, 14).lineTo(-3, 14).lineTo(-3, 0).close();
place(extrude(bracketProfile, 10).rotate(90, 0, 0).onPlate(), -60, 10, '#8fe3a8', 'drawn profile');

// 6. Revolve: a vase profile (sketch x = radius, sketch y = height), and a partial revolve
const vase = polygon2d([[0, 0], [7, 0], [8, 2], [5, 9], [6, 16], [4.6, 16], [3.8, 9], [6.8, 2], [6.2, 1.2], [0, 1.2]]);
place(revolve(vase, { segments: 72 }), 15, -5, '#d3a6ff');
place(revolve(rect(4, 10, { center: false }).translate(4, 0), { angle: 270 }), 40, -5, '#d3a6ff');

// 7. Arrays: linear, polar (bolt circle) and grid, merged with union()
place(union(linearArray(box(3, 6, 3), 5, [5, 0, 0])), -60, 25, '#ffd27f');
const ring = cylinder(10, 2).subtract(polarArray(cylinder(1.5, 4), 8, { radius: 7 }));
place(ring, -30, 25, '#ffd27f');
place(union(grid(cylinder(1.2, 5), [4, 3], [4, 4])), 0, 25, '#ffd27f');

// 8. Alignment helpers: stack parts with align()
const base = box(16, 3, 16);
const post = cylinder(2, 10).align({ y: 'min' }, [0, base.bounds().max[1], 0]);
const cap = sphere(4).align({ y: 'min' }, [0, post.bounds().max[1], 0]);
place(union(base, post, cap), 30, 25, '#7fe0e0');

// 9. Screw helpers (cutters, axis Y, top at y = 0): clearance, countersunk, counterbore,
//    nut pocket and heat-set insert, all in one mounting block
const block = roundedBox(44, T, 16, 3, { edges: 'vertical' }).onPlate();
const top = (s) => s.translate(0, T, 0);
const cutters = [
  top(screwHole('M3', T)).translate(-16, 0, 0),
  top(screwHole('M3', T, { type: 'countersunk' })).translate(-8, 0, 0),
  top(screwHole('M4', T, { type: 'counterbore' })).translate(0, 0, 0),
  top(screwHole('M3', T)).translate(8, 0, 0),
  nutPocket('M3').rotate(180, 0, 0).translate(8, 0, 0),              // nut trap underneath
  top(heatInsert('M3', { depth: 6 })).translate(16, 0, 0),
];
place(block.subtract(cutters), 55, 25, '#ff8f8f', 'mounting block');

// 8b. Placement by named features: bosses on a face at a hole pattern, cutters on the boss tops, a lid above.
//     Anchors are named points that travel with a shape: the pin keeps its 'tip' through the rotation and the union.
const tray = box(30, 4, 22).onPlate();
const bosses = union(rectPattern(22, 14).map((p) => cylinder(2.5, 6, { center: false }).at(tray.face('top'), p)));
const trayWithBosses = tray.add(bosses).subtract(rectPattern(22, 14).map((p) => screwHole('M2', 5, { type: 'tap' }).at(bosses.face('top'), p)));
const trayLid = box(30, 2, 22).alignTo(trayWithBosses, { x: 'center', z: 'center', y: 'above' }, { gap: 1.5 });
const pin = cylinder(1.2, 8, { center: false }).anchor('tip', [0, 8, 0], [0, 1, 0]).rotate(0, 0, -90).placeOn(trayWithBosses, 'right', { align: 'keep' });
const trayAssembly = trayWithBosses.add(trayLid.name('lid')).add(pin);
mark(trayAssembly.anchor('tip'), 'pin tip');
place(trayAssembly, 115, 25, '#7fe0e0', 'tray');
// Annotations appear on rendered views (Menu → Render views…), never in the geometry
dimension([100, 12, 36], [130, 12, 36], { label: 'tray 30 mm' });
mark([115, 13, 25], 'lid');

// 9a. A printer profile: walls and heights in whole lines and layers, holes compensated, fits by name
printer({ nozzle: 0.4, layer: 0.2, holeCompensation: 0.2 });
const socket = box(16, layers(8), 16).onPlate().subtract(cylinder(fit(6, 'slide') / 2, 20).translate(0, 8, 0)); // a 6 mm peg slides in
const pegPart = cylinder(peg(6, 'slide') / 2, 8, { center: false });
place(socket.add(pegPart.translate(0, 8, 0).alignTo(socket, { x: 'right' }, { gap: 2 })), 135, 25, '#ff8f8f', 'socket + peg');

// 9b. Printable horizontal holes: hole() gives a teardrop (or a bridged flat top) so nothing sags
const bar = box(30, 12, 10).onPlate();
place(bar.subtract(hole(3, 12, { axis: 'z' }).translate(-9, 6, 0))
  .subtract(hole(3, 12, { axis: 'z', shape: 'bridge' }).translate(0, 6, 0))
  .subtract(hole(3, 12, { axis: 'z', shape: 'round' }).translate(9, 6, 0)), 95, 25, '#ff8f8f', 'holes');

// 15. Named parts, ghosts and hidden parts. Ghosts render transparent and are never exported.
show(box(180, 30, 180).onPlate().translate(0, 0, 5), { name: 'print envelope', ghost: true });
show(sphere(4).translate(0, 4, 75), { name: 'hidden marble', hidden: true, color: '#ff4d4d' });

// 10. Colors, mirror, and log() to the console
const wing = polygon([[0, 0], [12, 0], [0, 8]], 3).translate(2, 0, 0);
place(union(wing, wing.mirror('x')), -70, 50, '#c2e86b');

// 11. 2D corner treatments: fillet and chamfer a sketch before extruding
place(extrude(rect(14, 10).fillet(3), 4), -45, 50, '#8fe3a8');
place(extrude(rect(14, 10).chamfer(3).subtract(circle(2)), 4), -25, 50, '#8fe3a8');

// 12. Text: 2D text() for engraving, text3d() for raised letters
if (SHOW_TEXT) {
  const tag = roundedBox(34, 3, 12, 2, { edges: 'vertical' })
    .subtract(text3d('TemenCAD', { size: TEXT_SIZE, height: 1.2, align: 'center' }).translate(0, 1.5 - 0.6, -2.5));
  place(tag, 5, 50, '#ffd27f', 'name tag');
  place(text3d('3D', { size: 12, height: 3, align: 'center', font: 'Nunito Bold' }), 35, 50, '#ff8f8f');
}

// 12b. Lettering on any face: emboss raises, engrave cuts; text reads correctly from outside
const tagBlock = box(18, 8, 12).onPlate();
place(tagBlock.emboss('TEMEN', tagBlock.face('front'), { depth: 0.8, size: 4 }).engrave('v2', tagBlock.face('top'), { depth: 0.5, size: 5 }), 65, 50, '#ffd27f', 'lettered');

// 13. Loft between profiles, and a shelled cup (hollow with an open top)
place(loft([circle(6), rect(8, 8).fillet(2), regularPolygon(6, 4)], [0, 8, 16]), 60, 50, '#d3a6ff');
place(cylinder(7, 14).shell(CUP_WALL, { open: 'top' }), -70, 75, '#7fe0e0', 'cup');

// 13b. Sweep a profile along a path: a hook from a smoothed polyline, and a spring from a helix
const hookPath = path([[0, 0, 0], [0, 14, 0], [6, 18, 0], [12, 14, 0], [12, 8, 0]]).smooth();
place(sweep(circle(1.5), hookPath), 5, 75, '#c2e86b', 'hook');
place(sweep(circle(1.2), helix(5, 16, 4)), 30, 75, '#c2e86b', 'spring');

// 13c. Heightmap from a function (import a .png or .jpg into the project to use a picture; see lithophane())
place(heightmap((x, z) => 0.5 + 0.5 * Math.sin(x / 2) * Math.cos(z / 2), { width: 24, height: 3, base: 1, resolution: 48 }), 125, 50, '#ffd27f', 'relief');

// 14. Edge fillets and chamfers (pick edges: 'all', 'top', 'bottom', 'vertical', 'concave', ...),
//     Minkowski rounding, and a hand-built polyhedron (a wedge)
place(box(10, 6, 8).fillet(1.5, { edges: 'top' }), -60, 75, '#8fb3ff');
place(box(10, 6, 8).chamfer(1.2), -45, 75, '#8fb3ff');
place(box(14, 2, 14).add(cylinder(3, 6).translate(0, 4, 0)).fillet(1.5, { edges: 'concave' }), -30, 75, '#8fb3ff', 'boss');
place(box(10, 6, 8).round(1.5), -45, 90, '#8fb3ff');
const wedge = polyhedron(
  [[0, 0, 0], [12, 0, 0], [12, 0, 8], [0, 0, 8], [0, 6, 0], [0, 6, 8]],
  [[0, 1, 2, 3], [4, 5, 2, 1], [0, 4, 1], [3, 2, 5], [0, 3, 5, 4]],
);
place(wedge, -22, 75, '#ffb366', 'wedge');
log('parts:', parts.length, '· block volume:', Math.round(parts[parts.length - 2].volume()), 'mm³');

return parts;
`;
