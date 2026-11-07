const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
// a rectangle with one rounded corner
const r1 = sketch().moveTo(0, 0).lineTo(30, 0).lineTo(30, 10).fillet(5).lineTo(0, 10).close();
close(r1.area(), 300 - 25 * (1 - Math.PI / 4), 0.01, 'one fillet');
// relative drawing, the same outline
const r2 = sketch().moveTo(0, 0).horizontal(30).vertical(10).fillet(5).horizontal(-30).close();
close(r2.area(), r1.area(), 1e-9, 'relative');
// arcTo: a semicircle bulging left (counter-clockwise) closes a slot; area = rectangle + circle
const slotLike = sketch().moveTo(0, -5).lineTo(20, -5).arcTo(20, 5, { r: 5 }).lineTo(0, 5).arcTo(0, -5, { r: 5 }).close();
close(slotLike.area(), 20 * 10 + Math.PI * 25, 0.01, 'two semicircles');
// the same with side right bulges inward
const bitten = sketch().moveTo(0, -5).lineTo(20, -5).arcTo(20, 5, { r: 5, side: 'right' }).lineTo(0, 5).close();
close(bitten.area(), 200 - Math.PI * 25 / 2, 0.01, 'inward arc');
// large arc: nearly a full circle
const big = sketch().moveTo(10, 0).arcTo(10, 2, { r: 5, large: true }).close();
assert(big.area() > Math.PI * 25 * 0.9, 'large arc');
// tangent arc: a quarter round from a horizontal segment
const tang = sketch().moveTo(0, 0).lineTo(10, 0).tangentArcTo(20, 10).lineTo(0, 10).close();
close(tang.area(), 100 + Math.PI * 100 / 4, 0.01, 'tangent quarter circle');
// mirror close: half of a vase profile, revolved
const half = sketch().moveTo(0, 0).lineTo(12, 0).lineTo(14, 20).fillet(3).lineTo(10, 40).close({ mirror: 'y' });
assert(half.bounds().size[0] > 27 && half.bounds().size[0] < 28 && Math.abs(half.bounds().center[0]) < 1e-9, 'mirrored, widest corner rounded'); assert(half.area() > 0, 'mirrored area');
const vase = revolve(sketch().moveTo(0, 0).lineTo(12, 0).lineTo(14, 20).fillet(3).lineTo(10, 40).lineTo(0, 40).close(), { segments: 64 });
assert(vase.volume() > 0 && vase.bounds().size[1] === 40, 'revolved profile');
// fillet clamps when the corner is too short
const tiny = sketch().moveTo(0, 0).lineTo(2, 0).fillet(50).lineTo(2, 2).lineTo(0, 2).close();
assert(tiny.area() > 0 && tiny.area() < 4, 'clamped fillet');
// errors
for (const f of [() => sketch().moveTo(0, 0).arcTo(10, 0, { r: 2 }), () => sketch().lineTo(1, 1).close(), () => sketch().moveTo(0, 0).tangentArcTo(1, 1)]) {
  let threw = false; try { f(); } catch { threw = true; } assert(threw, 'error cases throw');
}
return [extrude(r1, 3), extrude(slotLike, 3).translate(0, 0, 20), extrude(tang, 3).translate(0, 0, 40), vase.translate(50, 0, 0)];
