const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const blk = box(40, 20, 30).onPlate();
const V = blk.volume();
// an asymmetric mark: an L whose foot points along +x and whose stem goes up +y in the sketch
const L = polygon2d([[0, 0], [6, 0], [6, 2], [2, 2], [2, 8], [0, 8]]);
const area = L.area();
// emboss and engrave on the top: volume changes by area × depth, bounds grow only along the normal
const up = blk.emboss(L, blk.face('top'), { depth: 1.5 });
close(up.volume() - V, area * 1.5, 1e-6, 'emboss volume'); close(up.bounds().max[1], 21.5, 1e-9, 'emboss height'); close(up.bounds().size[0], 40, 1e-9, 'no sideways growth');
const down = blk.engrave(L, blk.face('top'), { depth: 1.5 });
close(V - down.volume(), area * 1.5, 1e-6, 'engrave volume'); close(down.bounds().max[1], 20, 1e-9, 'engrave keeps the top');
// orientation: the foot of the L (its +x) must point to the viewer's right on every side face, the stem up
const foot = (s, face) => { const extra = s.subtract(blk); return extra.bounds(); };
const onTop = foot(blk.emboss(L, blk.face('top'), { depth: 1 })); close(onTop.size[0], 6, 1e-6, 'top: x along X'); close(onTop.size[2], 8, 1e-6, 'top: y along Z');
const front = blk.emboss(L, blk.face('front'), { depth: 1 }).subtract(blk).bounds();
close(front.size[0], 6, 1e-6, 'front: x along X'); close(front.size[1], 8, 1e-6, 'front: y up'); close(front.max[2], 16, 1e-9, 'front: out of the front face');
// the stem of the L is at its low-x end: on each side face it must sit on the viewer's LEFT. The L is centred, so its
// stem (sketch x 0..2 of 0..6, y 2..8 of 0..8) lands at u = -3..-1; slab the upper part of the stem to find it.
const stem = (s) => s.subtract(blk).intersect(box(100, 4, 100).translate(0, 11, 0)).bounds(); // world y 9..13 is stem only
const fs = stem(blk.emboss(L, blk.face('front'), { depth: 1 })); close(fs.center[0], -2, 1e-6, 'front: stem on the viewer\'s left is -X');
const bs = stem(blk.emboss(L, blk.face('back'), { depth: 1 })); close(bs.center[0], 2, 1e-6, 'back: stem on the viewer\'s left is +X');
const rs = stem(blk.emboss(L, blk.face('right'), { depth: 1 })); close(rs.center[2], 2, 1e-6, 'right: viewer\'s left is +Z');
const ls = stem(blk.emboss(L, blk.face('left'), { depth: 1 })); close(ls.center[2], -2, 1e-6, 'left: viewer\'s left is -Z');
const bot = blk.emboss(L, blk.face('bottom'), { depth: 1 }).subtract(blk).bounds(); close(bot.min[1], -1, 1e-9, 'bottom: out of the bottom face');
// text from a string, offset and rotated, engraved
const tagged = blk.engrave('v2', blk.face('top'), { depth: 0.6, size: 8, at: [10, -5], angle: 90 });
assert(tagged.volume() < V && tagged.bounds().max[1] === 20, 'engraved text');
const t = blk.subtract(tagged).bounds(); close(t.center[0], 10, 0.2, 'text at u'); close(t.center[2], -5, 0.2, 'text at v'); assert(t.size[2] > t.size[0], 'rotated 90°');
// on an anchor with a direction
const a = blk.anchor('spot', [20, 10, 0], [1, 0, 0]);
const onAnchor = a.emboss(L, a.anchor('spot'), { depth: 1 }).subtract(blk).bounds();
close(onAnchor.max[0], 21, 1e-9, 'emboss along the anchor direction');
return [up.translate(-50, 0, 0), tagged, blk.emboss('TEMEN', blk.face('front'), { depth: 1, size: 7 }).translate(50, 0, 0)];
