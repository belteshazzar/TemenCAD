const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const eq = (a, b, what) => a.forEach((v, i) => close(v, b[i], 1e-9, `${what}[${i}]`));
// an anchor moves with every transform
let pin = cylinder(1, 10, { center: false }).anchor('tip', [0, 10, 0], [0, 1, 0]).anchor('base', [0, 0, 0]);
eq(pin.anchor('tip').point, [0, 10, 0], 'tip'); eq(pin.anchor('tip').normal, [0, 1, 0], 'tip normal');
eq(pin.translate(5, 0, 2).anchor('tip').point, [5, 10, 2], 'translated');
eq(pin.rotate(90, 0, 0).anchor('tip').point, [0, 0, 10], 'rotated point'); eq(pin.rotate(90, 0, 0).anchor('tip').normal, [0, 0, 1], 'rotated normal');
eq(pin.rotate(0, 0, -90).anchor('tip').point, [10, 0, 0], 'rotated about z');
eq(pin.scale(2).anchor('tip').point, [0, 20, 0], 'scaled');
eq(pin.mirror('y').anchor('tip').point, [0, -10, 0], 'mirrored'); eq(pin.mirror('y').anchor('tip').normal, [0, -1, 0], 'mirrored normal');
eq(pin.onPlate().translate(1, 0, 0).anchor('base').point, [1, 0, 0], 'via helpers');
assert(Object.keys(pin.anchors).sort().join() === 'base,tip', 'anchors list');
// anchors survive booleans; the first shape wins on a clash
const base = box(20, 4, 20).onPlate().anchor('corner', [10, 4, 10]).anchor('tip', [9, 9, 9]);
const joined = base.add(pin.translate(0, 4, 0));
eq(joined.anchor('corner').point, [10, 4, 10], 'kept through union'); eq(joined.anchor('tip').point, [9, 9, 9], 'first wins');
eq(joined.subtract(box(2)).anchor('corner').point, [10, 4, 10], 'kept through difference');
eq(joined.fillet(0.5, { edges: 'top' }).anchor('corner').point, [10, 4, 10], 'kept through fillet');
// placement on an anchor: a cutter's +Y follows the anchor's direction
const tip = pin.translate(0, 4, 0).anchor('tip');
const cutter = screwHole('M3', 5).at(tip);
close(cutter.bounds().max[1], 15, 1e-9, 'cutter on the tip (overshoot)'); close(cutter.bounds().min[1], 9, 1e-9, 'cutter depth');
const sidePin = pin.rotate(0, 0, -90).anchor('tip');
const sideCut = screwHole('M3', 5).at(sidePin);
close(sideCut.bounds().max[0], 11, 1e-9, 'sideways: overshoot along +X'); close(sideCut.bounds().min[0], 5, 1e-9, 'sideways: depth along X');
const anyDir = box(2).anchor('a', [0, 0, 0], [1, 1, 0]);
const turned = cylinder(1, 10, { center: false }).at(anyDir.anchor('a'));
close(turned.bounds().max[0], 10 / Math.SQRT2 + 1 / Math.SQRT2 * 0 + 0.71, 0.05, 'turned toward a diagonal');
// distance, dimension and mark accept anchors
close(distance(tip, base.face('top')), 10, 1e-9, 'distance to a face');
close(dimension(pin.anchor('base'), pin.anchor('tip')), 10, 1e-9, 'dimension between anchors');
mark(tip, 'tip');
assert(() => { try { pin.anchor('nope'); return false; } catch { return true; } }, 'unknown anchor throws');
return joined;
