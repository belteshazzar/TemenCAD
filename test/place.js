const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const eq = (a, b, what) => a.forEach((v, i) => close(v, b[i], 1e-9, `${what}[${i}]`));
const base = box(40, 6, 30).onPlate().translate(5, 0, -2);
// faces
const t = base.face('top'); eq(t.center, [5, 6, -2], 'top centre'); eq(t.normal, [0, 1, 0], 'top normal');
eq(base.face('front').center, [5, 3, 13], 'front centre'); eq(base.face('left').center, [-15, 3, -2], 'left centre');
assert(t.u === 'x' && t.v === 'z' && base.face('front').u === 'x' && base.face('front').v === 'y' && base.face('right').u === 'z', 'in-plane axes');
eq(t.point([3, -4]), [8, 6, -6], 'point uv'); eq(t.point({ x: 1, z: 2 }), [6, 6, 0], 'point xyz');
// placeOn: centred on the face, touching
const boss = cylinder(4, 10).placeOn(base, 'top');
eq(boss.bounds().min, [1, 6, -6], 'boss min'); eq(boss.bounds().max, [9, 16, 2], 'boss max');
const bossAt = cylinder(4, 10).placeOn(base, 'top', { at: [10, 5], gap: 0.5 });
eq(bossAt.bounds().center, [15, 11.5, 3], 'boss at+gap');
const under = box(4).placeOn(base, 'bottom'); close(under.bounds().max[1], 0, 1e-9, 'under the bottom');
const side = box(4).placeOn(base, 'right', { align: 'keep' }); close(side.bounds().min[0], 25, 1e-9, 'right, keep'); close(side.bounds().center[2], 0, 1e-9, 'kept z');
const front = box(4).placeOn(base, 'front'); eq(front.bounds().center, [5, 3, 15], 'front');
// at: origin on the face, +Y along the normal; a screw cutter lands correctly on every face
const cut = screwHole('M3', 5);
const onTop = cut.at(t, [2, 3]); close(onTop.bounds().max[1], 7, 1e-9, 'cutter top overshoot'); close(onTop.bounds().min[1], 1, 1e-9, 'cutter depth'); close(onTop.bounds().center[0], 7, 1e-9, 'cutter x');
const onFront = cut.at(base.face('front'), [0, 1]); close(onFront.bounds().max[2], 14, 1e-9, 'front overshoot'); close(onFront.bounds().min[2], 8, 1e-9, 'front depth'); close(onFront.bounds().center[1], 4, 1e-9, 'front v -> y');
const onRight = cut.at(base.face('right')); close(onRight.bounds().max[0], 26, 1e-9, 'right overshoot'); close(onRight.bounds().min[0], 20, 1e-9, 'right depth');
const onBottom = cut.at(base.face('bottom')); close(onBottom.bounds().min[1], -1, 1e-9, 'bottom overshoot'); close(onBottom.bounds().max[1], 5, 1e-9, 'bottom depth');
const onLeft = cut.at(base.face('left')); close(onLeft.bounds().min[0], -16, 1e-9, 'left overshoot'); close(onLeft.bounds().max[0], -10, 1e-9, 'left depth');
const onBack = cut.at(base.face('back')); close(onBack.bounds().min[2], -18, 1e-9, 'back overshoot'); close(onBack.bounds().max[2], -12, 1e-9, 'back depth');
// alignTo
const lid = box(40, 2, 30);
eq(lid.alignTo(base, { x: 'center', y: 'above', z: 'center' }).bounds().min, [-15, 6, -17], 'above');
close(lid.alignTo(base, { y: 'above' }, { gap: 0.3 }).bounds().min[1], 6.3, 1e-9, 'above gap');
close(lid.alignTo(base, { y: 'below' }).bounds().max[1], 0, 1e-9, 'below');
close(lid.alignTo(base, { x: 'right' }).bounds().min[0], 25, 1e-9, 'right of');
close(lid.alignTo(base, { x: 'left' }, { gap: 1 }).bounds().max[0], -16, 1e-9, 'left of');
close(lid.alignTo(base, { z: 'front' }).bounds().min[2], 13, 1e-9, 'in front');
close(lid.alignTo(base, { z: 'back' }).bounds().max[2], -17, 1e-9, 'behind');
close(lid.alignTo(base, { x: 'max' }).bounds().max[0], 25, 1e-9, 'max');
// distance
close(distance(base.face('top'), base.face('bottom')), 6, 1e-9, 'face to face');
close(distance(base.face('top'), [0, 20, 0]), 14, 1e-9, 'face to point');
close(distance([0, 0, 0], [3, 4, 0]), 5, 1e-9, 'points');
close(distance(boss.face('bottom'), base.face('top')), 0, 1e-9, 'touching');
// patterns
assert(rectPattern(21, 12.5).length === 4 && gridPattern(2, 3, 10).length === 6, 'patterns');
eq(rectPattern(21, 12.5)[3], [10.5, 6.25], 'rect corner'); eq(gridPattern(3, 1, 10)[0], [-10, 0], 'grid first');
// a complete use: four bosses on the plate, cutters on their tops, nothing drifts
const bosses = union(rectPattern(30, 20).map((p) => cylinder(3, 8, { center: false }).at(t, p)));
const part = base.add(bosses).subtract(rectPattern(30, 20).map((p) => screwHole('M3', 6, { type: 'tap' }).at(bosses.face('top'), p)));
close(bosses.face('top').center[1], 14, 1e-9, 'boss tops'); assert(part.volume() < base.volume() + bosses.volume(), 'holes cut');
return [part, lid.alignTo(base, { x: 'center', y: 'above', z: 'center' }, { gap: 4 }).ghost()];
