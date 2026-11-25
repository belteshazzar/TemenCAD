const close = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const M = 2;
// 1. ring gear: tips on pitch - module, roots past pitch + 1.25 module, rim outside
const r = ringGear({ module: M, teeth: 36, thickness: 6, rim: 4 });
close(r.bounds().size[0], 2 * (36 + 2.5 + 4), 0.01, 'outer diameter: (pitch + 1.25 m + rim) x 2');
const inner = projection(r, { cut: 3 }).toPolygons();
let tipR = Infinity;
for (const ring of inner) for (const p of ring) tipR = Math.min(tipR, Math.hypot(p[0], p[1]));
close(tipR, 36 - M, 0.01, 'internal tips at pitch - module');
// 2. an external gear meshes inside it at module x (ring - gear) / 2, tooth 0 into the space at +X
const inside = gear({ module: M, teeth: 12, thickness: 6, backlash: 0.1 }).translate((M * (36 - 12)) / 2, 0, 0);
assert(!intersects(ringGear({ module: M, teeth: 36, thickness: 6, backlash: 0.1 }), inside), 'external gear meshes inside the ring');
// 3. planetary sets of several shapes: every mesh clear, planets clear of each other
const check = (opts, what) => {
  const s = planetary(Object.assign({ module: M, thickness: 6, backlash: 0.2 }, opts));
  for (const p of s.planets) { assert(!intersects(s.sun, p), `${what}: sun vs ${p.meta.name}`); assert(!intersects(s.ring, p), `${what}: ring vs ${p.meta.name}`); }
  for (let i = 0; i < s.planets.length; i++) for (let j = i + 1; j < s.planets.length; j++) assert(!intersects(s.planets[i], s.planets[j]), `${what}: planets ${i + 1} and ${j + 1}`);
  const ringGap = Math.min(...s.planets.map((p) => clearance(s.ring, p))), sunGap = Math.min(...s.planets.map((p) => clearance(s.sun, p)));
  echo(what, 'ring teeth', opts.sun + 2 * opts.planet, 'clearance at the ring', ringGap, 'at the sun', sunGap);
  assert(ringGap > 0.04 && sunGap > 0.04, `${what}: 0.2 mm of backlash leaves real clearance at both meshes`);
  return s;
};
const a = check({ sun: 12, planet: 12, planets: 3 }, 'even planets');
check({ sun: 15, planet: 15, planets: 3 }, 'odd planets');
check({ sun: 9, planet: 12, planets: 3 }, 'odd sun');
check({ sun: 12, planet: 18, planets: 4 }, 'four planets');
const h = check({ sun: 12, planet: 12, planets: 3, helix: 15, thickness: 8 }, 'helical');
// 4. ring tips: shortened for small pinions, full height for large ones
close(ringAddendum(36, 12), 0.595, 0.01, 'ring addendum for a 12-tooth pinion');
assert(ringAddendum(80, 20) === 1, 'no trim for a large pinion in a large ring');
// 5. names and the even-spacing rule
assert(a.sun.meta.name === 'sun' && a.ring.meta.name === 'ring' && a.planets[2].meta.name === 'planet 3', 'parts are named');
let msg = '';
try { planetary({ sun: 10, planet: 13, planets: 3 }); } catch (e) { msg = e.message; }
assert(/cannot be spaced evenly.*try sun teeth/.test(msg), `uneven spacing explained: ${msg}`);
msg = '';
try { planetary({ sun: 6, planet: 20, planets: 4 }); } catch (e) { msg = e.message; }
assert(/would touch each other/.test(msg), `crowded planets explained: ${msg}`);
return [union(a.sun, a.planets, a.ring).name('spur set'), union(h.sun, h.planets, h.ring).translate(110, 0, 0).name('helical set')];
