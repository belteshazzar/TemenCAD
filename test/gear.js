const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const M = 2;
// 1. size: the tips reach the addendum circle, module × (teeth + 2)
const g = gear({ module: M, teeth: 20, thickness: 6 });
close(g.bounds().size[0], M * 22, 0.01, 'outer diameter');
close(g.bounds().size[1], 6, 1e-9, 'thickness'); close(g.bounds().min[1], 0, 1e-9, 'on the plate');
const area = gear2d({ module: M, teeth: 20 }).area(), rp = M * 10;
assert(area > Math.PI * (rp - 1.25 * M) ** 2 && area < Math.PI * (rp + M) ** 2, 'area between root and tip circles');
close(gear2d({ module: M, teeth: 20, bore: 6 }).area(), area - Math.PI * 9, 0.01, 'bore');
close(gearDistance(M, 20, 12), 32, 1e-12, 'centre distance');
// 2. a pair at the exact centre distance touches without overlapping; backlash opens a gap
const [a0, b0] = gearPair({ module: M, teeth: [20, 12], thickness: 6 });
assert(interference(a0, b0) < 1e-6, 'exact pair does not overlap');
const [a, b] = gearPair({ module: M, teeth: [20, 12], thickness: 6, backlash: 0.2 });
assert(!intersects(a, b) && clearance(a, b) > 0.02, 'backlash opens clearance');
const [c, d] = gearPair({ module: M, teeth: [17, 9], thickness: 6, backlash: 0.2 });
assert(!intersects(c, d), 'odd tooth counts mesh too');
echo('pair clearance', clearance(a, b), 'odd pair', clearance(c, d));
// 3. helical: opposite hands keep the pair meshed through the thickness
const [h1, h2] = gearPair({ module: M, teeth: [20, 12], thickness: 10, helix: 15, backlash: 0.2 });
assert(!intersects(h1, h2), 'helical pair meshes');
close(h1.volume(), gear({ module: M, teeth: 20, thickness: 10, backlash: 0.1 }).volume(), 0.01, 'twisting keeps the volume');
// 4. a rack meshes with a gear whose tooth faces it (20 teeth: a tooth points at -90° in the sketch)
const r = rack({ module: M, teeth: 10, thickness: 6, backlash: 0.1 });
close(r.bounds().size[0], 10 * Math.PI * M, 0.05, 'rack length');
const onRack = gear({ module: M, teeth: 20, thickness: 6, backlash: 0.1 }).translate(0, 0, -rp);
assert(!intersects(r, onRack), 'rack and gear mesh');
// 5. bad input
for (const f of [() => gear({ teeth: 4 }), () => gear2d({ module: 1, teeth: 10, bore: 20 }), () => gear({ helix: 70 }), () => gearPair({ teeth: 12 })]) {
  let threw = false; try { f(); } catch (e) { threw = true; } assert(threw, 'bad input throws');
}
return { gear: a, pinion: b, helical: h1.translate(0, 0, 60), helicalPinion: h2.translate(0, 0, 60), rack: r.translate(0, 0, -50), onRack: onRack.translate(0, 0, -50) };
