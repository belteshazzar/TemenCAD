const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const part = roundedBox(120, 30, 40, 4, { edges: 'vertical' }).onPlate().anchor('tip', [60, 15, 0], [1, 0, 0]).name('beam');
const V = part.volume();
// 1. one cut on each axis: the pieces add back up exactly, in order along the axis, named after the shape
for (const [axis, at] of [['x', 10], ['y', 12], ['z', -5]]) {
  const pieces = split(part, { [axis]: at });
  const k = 'xyz'.indexOf(axis);
  assert(pieces.length === 2 && pieces[0].bounds().max[k] <= at + 1e-9 && pieces[1].bounds().min[k] >= at - 1e-9, `${axis}: two pieces either side of the cut`);
  close(pieces[0].volume() + pieces[1].volume(), V, 1e-9, `${axis}: volumes add up`);
  assert(pieces[0].meta.name === 'beam 1' && pieces[1].meta.name === 'beam 2', `${axis}: named after the shape`);
}
// 2. several cuts, anchors kept, method form
const thirds = part.split({ x: [-20, 20] });
assert(thirds.length === 3, 'three pieces');
close(thirds[1].bounds().size[0], 40, 1e-9, 'middle piece 40 long');
close(thirds[2].anchor('tip').point[0], 60, 1e-9, 'anchors travel with the pieces');
// 3. dowels: holes in both faces, the dowels after the pieces, the material removed is two holes per dowel
const withPins = split(part, { x: 0 }, { dowels: 2, dowelDiameter: 4, dowelLength: 10, tolerance: 0.2 });
assert(withPins.length === 4 && withPins[2].meta.name === 'dowel 1' && withPins[3].meta.name === 'dowel 2', 'two pieces then two dowels');
const holes = V - withPins[0].volume() - withPins[1].volume();
const holeArea = (32 / 2) * Math.sin((2 * Math.PI) / 32) * 2.1 ** 2; // 32-gon of radius 2.1
close(holes, 2 * holeArea * (10 + 0.5), 1e-6, 'two holes, each 10.5 deep across the cut');
for (const d of withPins.slice(2)) assert(!intersects(d, withPins[0]) && !intersects(d, withPins[1]), 'dowels sit in their holes');
const pinGap = Math.hypot(withPins[2].bounds().center[1] - withPins[3].bounds().center[1], withPins[2].bounds().center[2] - withPins[3].bounds().center[2]);
assert(pinGap > 20, `dowels spread across the 30 x 40 face: ${pinGap}`);
// 4. layout: on the plate, cut faces down, side by side
const laid = split(part, { x: 0 }, { dowels: 2, layout: true });
for (const p of laid) close(p.bounds().min[1], 0, 1e-9, `${p.meta.name} on the plate`);
for (let i = 1; i < laid.length; i++) assert(laid[i].bounds().min[0] >= laid[i - 1].bounds().max[0] + 4.99, 'side by side');
for (const p of laid.slice(0, 2)) close(projection(p, { cut: 0.01 }).area(), 30 * 40 - 2 * holeArea, 1e-6, `${p.meta.name} stands on its cut face, dowel holes and all`);
close(laid[0].bounds().size[1], 60, 1e-9, 'first piece stands on its cut face (60 tall)');
// 5. dowels land in the material of a hollow cut face, spread round it
const tube = cylinder(30, 40, { segments: 96 }).subtract(cylinder(20, 50, { segments: 96 })).onPlate();
const tubeParts = split(tube, { y: 20 }, { dowels: 3 });
assert(tubeParts.length === 5, 'two halves and three dowels');
for (const d of tubeParts.slice(2)) close(interference(d, tube), d.volume(), 1e-6, `${d.meta.name} is inside the wall`);
// 6. what cannot be done is explained
for (const [f, re] of [[() => split(part, { x: 200 }), /does not cut/], [() => split(part, { x: 0, y: 1 }), /exactly one axis/], [() => split(part, 5), /expected a plane/]]) {
  let msg = ''; try { f(); } catch (e) { msg = e.message; } assert(re.test(msg), `error: ${msg}`);
}
const thin = split(box(40, 4, 40).onPlate(), { y: 2 }, { dowels: 2 }); // 2 mm either side: no room for a 10 mm dowel
assert(thin.length === 2, 'no dowels where they do not fit');
return laid.concat(tubeParts.map((p) => p.translate(0, 0, 80)));
