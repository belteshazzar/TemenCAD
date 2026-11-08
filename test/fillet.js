const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a.toFixed(3)} vs ${b.toFixed(3)}`);
const W = 40, H = 20, D = 30;
// 1. chamfer the top edges of a box: exact volume
const c1 = box(W, H, D).chamfer(3, { edges: 'top' });
close(c1.volume(), W * H * D - (9 / 2) * (2 * W + 2 * D) + 4 * 27 / 3, 1e-6, 'top chamfer');
// 2. fillet the top edges: union of full-length grooves with inscribed arcs
const r = 4, f = 1 - Math.PI / 4;
const c2 = box(W, H, D).fillet(r, { edges: 'top', segments: 64 });
close(c2.volume(), W * H * D - (f * r * r * (2 * W + 2 * D) - 4 * (2 * r ** 3 * f - r ** 3 / 3)), 0.002, 'top fillet');
assert(c2.bounds().size.every((v, i) => Math.abs(v - [W, H, D][i]) < 1e-6), 'bounds unchanged');
// 3. all edges of a box, and chamfer all
const c3 = box(W, H, D).fillet(3);
assert(c3.volume() < c1.volume() && c3.volume() > W * H * D - 4 * f * 9 * (W + H + D), 'all fillet');
const c4 = box(W, H, D).chamfer(2);
echo('all chamfer', c4.volume(), W * H * D);
// 4. concave: a square boss on a plate, fillet at the base adds material
const plate = box(50, 4, 50).onPlate(), boss = box(16, 14, 16).onPlate();
const base = plate.add(boss);
const c5 = base.fillet(2, { edges: 'concave', segments: 64 });
close(c5.volume() - base.volume(), f * 4 * 64 + 4 * 8 * (5 / 3 - Math.PI / 2), 0.002, 'concave boss');
// 5. L-shaped extrusion, everything rounded, blends at the inner corner
const L = extrude(polygon2d([[0, 0], [30, 0], [30, 12], [12, 12], [12, 30], [0, 30]]), 10).fillet(2.5);
assert(L.volume() > 0 && L.volume() < extrude(polygon2d([[0, 0], [30, 0], [30, 12], [12, 12], [12, 30], [0, 30]]), 10).volume(), 'L');
// 6. cylinder top edge (polygonal loop), and the vertical facets are not touched
const cyl = cylinder(10, 20, { segments: 48 }).fillet(3, { edges: 'top' });
const cv = cylinder(10, 20, { segments: 48 }).volume(); echo('cylinder removed', cv - cyl.volume(), 'approx', f * 9 * 2 * Math.PI * 9.3); assert(cv - cyl.volume() > 100 && cv - cyl.volume() < 130, 'cylinder');
// 7. function filter, chamfer method on a prism, global forms, sketch pass-through
const c7 = prism(6, 10, 10).chamfer(1.5, { edges: (e) => e.nA[1] > 0.9 || e.nB[1] > 0.9 });
assert(c7.volume() < prism(6, 10, 10).volume(), 'fn filter');
assert(typeof fillet(rect(10, 10), 2) === 'object', 'sketch fillet via global');
echo('edges on box', sharpEdges(box(10)).length);
return { c1: c1.translate(-60, 0, -40), c2: c2.translate(0, 0, -40), c3: c3.translate(60, 0, -40), c4: c4.translate(-60, 0, 10), c5: c5.translate(0, 0, 10), L: L.translate(45, 0, 0), cyl: cyl.translate(-60, 0, 60), c7: c7.translate(0, 0, 60) };
