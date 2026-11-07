const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a.toFixed(3)} vs ${b.toFixed(3)}`);
// 1. vertical sweep == extrude
const sq = rect(6, 4);
const v1 = sweep(sq, line([0, 0, 0], [0, 20, 0]));
close(v1.volume(), extrude(sq, 20).volume(), 1e-6, 'vertical');
const b1 = v1.bounds(); echo('vertical bounds', b1.min, b1.max);
assert(Math.abs(b1.size[0] - 6) < 1e-6 && Math.abs(b1.size[2] - 4) < 1e-6, 'orientation x->X, y->-Z');
// 2. right-angle square tube, mitred: volume = w^2 (L1+L2)
const v2 = sweep(rect(4, 4), path([[0, 0, 0], [30, 0, 0], [30, 0, 30]]));
close(v2.volume(), 16 * 60, 1e-6, 'mitre');
echo('mitre bounds', v2.bounds().min, v2.bounds().max);
// 3. torus from closed arc
const v3 = sweep(circle(3, { segments: 64 }), arc(20, 360, { segments: 128 }));
close(v3.volume(), 2 * Math.PI * Math.PI * 20 * 9, 0.01, 'torus');
close(v3.volume(), torus(20, 3, { segments: 128, tubeSegments: 64 }).volume(), 0.01, 'torus vs torus()');
// 4. helix spring
const spring = sweep(circle(1.5), helix(10, 40, 5));
echo('spring', spring.bounds().size, spring.volume());
close(spring.volume(), Math.PI * 1.5 * 1.5 * helix(10, 40, 5).length(), 0.02, 'spring volume');
// 5. varying profile + hole + twist + scale
const v5 = sweep((t) => circle(5 - 3 * t).subtract(circle(2 - 1.2 * t)), bezier([0, 0, 0], [0, 30, 0], [30, 30, 0], [30, 60, 0]), { twist: 90, scale: 1 });
echo('varying', v5.bounds().size, v5.volume());
assert(v5.volume() > 0, 'varying volume');
// 6. upright frame, smooth path, append, hollow via boolean
const rail = path([[0, 0, 0], [40, 0, 0], [40, 0, 40], [80, 20, 40]]).smooth({ segments: 12 });
const v6 = sweep(roundedRect(8, 4, 1), rail, { frame: 'upright' });
const v6b = v6.subtract(sweep(rect(6, 2), rail, { frame: 'upright' }));
assert(v6b.volume() < v6.volume() && v6b.volume() > 0, 'hollow rail');
const p7 = line([0, 0, 0], [20, 0, 0]).append(arc(10, 90)).append(line([0, 0, 0], [0, 15, 0]));
echo('appended', p7.points.length, p7.length().toFixed(2), p7.pointAt(0.5), p7.tangentAt(1));
const v7 = sweep(circle(2), p7);
assert(v7.volume() > 0, 'appended');
// 7. method form, 2D points, closed smooth loop
const loop = path([[0, 0], [40, 0], [40, 30], [0, 30]], { closed: true }).smooth();
const v8 = circle(2.5).sweep(loop);
assert(v8.volume() > 0 && v8.bounds().size[1] < 5.01, 'closed loop ring');
// 8. tight corner warning
sweep(circle(5), path([[0, 0, 0], [3, 0, 0], [3, 0, 3]]));
return { v1: v1.translate(-40, 0, 0), v2, v3: v3.translate(0, 0, -60), spring: spring.translate(60, 0, 0), v5: v5.translate(-90, 0, 0), v6: v6b.translate(0, 0, 60), v7: v7.translate(0, 0, 120), v8: v8.translate(100, 0, 60) };
