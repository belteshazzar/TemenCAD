const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
// The radius of a section, and the direction of the crest nearest +X, at height y.
const radii = (s, y) => { let lo = Infinity, hi = 0; for (const ring of projection(s, { cut: y }).toPolygons()) for (const p of ring) { const r = Math.hypot(p[0], p[1]); lo = Math.min(lo, r); hi = Math.max(hi, r); } return [lo, hi]; };
const crestAngle = (s, y, rMaj, fold = 360) => {
  // the middle of the crest: a section has one crest per start, so with the starts folded together (fold =
  // 360 / starts) every crest point (within the chord sag of a cut between twist slices) is one cluster
  let sx = 0, sy = 0;
  for (const ring of projection(s, { cut: y }).toPolygons()) for (const p of ring) {
    if (Math.hypot(p[0], p[1]) < rMaj - 0.05) continue;
    const a = rad(deg(Math.atan2(p[1], p[0])) * (360 / fold));
    sx += Math.cos(a); sy += Math.sin(a);
  }
  return (((deg(Math.atan2(sy, sx)) * fold) / 360 % fold) + fold) % fold;
};
const turned = (a, b, fold = 360) => ((((b - a) % fold) + fold * 1.5) % fold) - fold / 2; // b - a, folded into ±fold/2
// 1. an M8 coarse rod: major diameter 8, ISO depth 17H/24 at pitch 1.25, 20 long
const rod = thread({ size: 'M8', length: 20 });
close(rod.bounds().size[0], 8, 0.002, 'major diameter'); close(rod.bounds().size[1], 20, 1e-9, 'length');
const [rMin, rMaj] = radii(rod, 10);
// a cut between twist slices lies on chords, up to r (1 - cos(π / segments)) inside the true surface
close(rMaj, 4, 0.006, 'crest radius'); close(rMin, 4 - (17 / 24) * 0.8660254 * 1.25, 0.006, 'root radius');
// 2. right-hand: a quarter of a pitch up, the crest has turned +90° (anticlockwise seen from above); a pitch up, all the way
const a0 = crestAngle(rod, 10, 4), aQ = crestAngle(rod, 10 + 1.25 / 4, 4), aP = crestAngle(rod, 10 + 1.25, 4);
close(turned(a0, aQ), 90, 0.05, 'right-hand quarter turn'); close(turned(a0, aP), 0, 2, 'one pitch, one turn (within the 11.25° slice step)');
const lh = thread({ size: 'M8', length: 20, left: true });
close(turned(crestAngle(lh, 10, 4), crestAngle(lh, 10 + 1.25 / 4, 4)), -90, 0.05, 'left-hand quarter turn');
// 3. sizes: fine pitch, trapezoidal lead screw (4 starts: a 2 mm rise turns it 90°), a bare diameter
const fine = thread({ size: 'M8x1', length: 10 });
close(turned(crestAngle(fine, 5, 4), crestAngle(fine, 5.25, 4)), 90, 0.05, 'fine pitch 1');
const tr = thread({ size: 'Tr8x8(P2)', length: 20 });
const [trMin] = radii(tr, 10); close(trMin, 3, 0.006, 'trapezoid depth half the pitch');
close(turned(crestAngle(tr, 10, 4, 90), crestAngle(tr, 10.5, 4, 90), 90), 22.5, 0.05, 'lead 8: half a millimetre turns it 22.5°');
const sq = thread({ size: 10, pitch: 2, profile: 'square', length: 10 });
const [sqMin, sqMax] = radii(sq, 5); close(sqMax - sqMin, 1, 0.03, 'square depth');
// 4. fits: a rod in a hole cut with the internal thread, both from y = 0; tolerance opens a gap
const block = (cut) => box(16, 12, 16).onPlate().subtract(cut);
const bolt = thread({ size: 'M8', length: 12 });
const nut = block(thread({ size: 'M8', length: 12, internal: true, tolerance: 0.4 }));
assert(!intersects(nut, bolt), 'M8 bolt in an M8 hole with 0.4 tolerance');
const shortGap = clearance(box(16, 3, 16).onPlate().translate(0, 4, 0).subtract(thread({ size: 'M8', length: 12, internal: true, tolerance: 0.4 })), bolt);
assert(shortGap > 0.05 && shortGap < 0.2, `clearance about tolerance × sin 30° / ... : ${shortGap}`);
assert(!intersects(block(thread({ size: 'Tr8x8(P2)', length: 12, internal: true, tolerance: 0.3 })), thread({ size: 'Tr8x8(P2)', length: 12 })), 'lead screw nut');
// 5. a declared printer compensates holes, as hole() does
printer({ holeCompensation: 0.3 });
close(thread({ size: 'M8', length: 6, internal: true, chamfer: false }).bounds().size[0], 8.3, 0.002, 'hole grows by holeCompensation');
close(thread({ size: 'M8', length: 6, chamfer: false }).bounds().size[0], 8, 0.002, 'rods stay nominal');
// 6. bad input explains itself
for (const [f, re] of [[() => thread({ size: 'M7' }), /no coarse pitch for M7/], [() => thread({ size: 'M8', pitch: 5 }), /too coarse/], [() => thread({ profile: 'acme' }), /profile must be/], [() => thread({ size: 'Tr8x7(P2)' }), /whole number of pitches/]]) {
  let msg = ''; try { f(); } catch (e) { msg = e.message; } assert(re.test(msg), `error: ${msg}`);
}
echo('M8 rod', rod.numTriangles(), 'triangles; clearance in the nut', shortGap);
return { rod, nut: nut.translate(25, 0, 0), bolt: bolt.translate(25, 0, 0), leadScrew: tr.translate(-25, 0, 0), square: sq.translate(0, 0, 25), leftHand: lh.translate(25, 0, 25) };
