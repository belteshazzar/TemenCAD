// Smoke test for the WebAssembly build: node core/test/smoke.mjs [path/to/build/wasm]
// Exact volumes where a closed form exists; exits 1 on any mismatch.
import zlib from 'node:zlib';
import { createRuntime } from '../wasm/index.js';

const rt = await createRuntime();
console.log(rt.version);
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`); if (!cond) failed++; };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// 1. a cube: exact volume, 12 triangles, bottom on the plate
let r = rt.run({ 'main.js': 'return box(10).onPlate().name("block")' });
check('cube runs', r.ok, r.error?.message);
check('cube volume 1000', r.ok && near(r.parts[0].volume, 1000), r.ok ? String(r.parts[0].volume) : '');
check('cube has 12 triangles', r.ok && r.parts[0].indices.length === 36);
check('cube named', r.ok && r.parts[0].name === 'block' && r.parts[0].named);
if (r.ok) {
  let minY = Infinity;
  for (let i = 1; i < r.parts[0].positions.length; i += 3) minY = Math.min(minY, r.parts[0].positions[i]);
  check('onPlate puts the bottom at y=0', near(minY, 0, 1e-9), String(minY));
}

// 2. booleans: box minus a box through it; union of two disjoint boxes; intersection
r = rt.run({ 'main.js': `
  const a = box(10), b = box(2, 20, 2);
  echo('diff', difference(a, b).volume());
  return { diff: difference(a, b), both: union(box(2), box(2).translate(10, 0, 0)), inter: intersect(box(10), box(10).translate(5, 0, 0)) };
` });
check('booleans run', r.ok, r.error?.message);
check('difference volume 960', r.ok && near(r.parts[0].volume, 960));
check('union volume 16', r.ok && near(r.parts[1].volume, 16));
check('intersection volume 500', r.ok && near(r.parts[2].volume, 500));
check('echo message with its line', r.messages.some((m) => m.text === 'ECHO (line 3): "diff", 960' && m.line === 3), JSON.stringify(r.messages));

// 3. a module import, a cylinder along Y, a sphere
r = rt.run({
  'main.js': `import { peg } from './parts/peg.js'; const s = sphere(1, { segments: 64 }); return [peg(), s];`,
  'parts/peg.js': `export function peg() { return cylinder(1, 10, { segments: 64 }).name('peg'); }`,
});
check('imports run', r.ok, r.error?.message);
if (r.ok) {
  const b = r.parts[0];
  let minY = Infinity, maxY = -Infinity, maxX = -Infinity;
  for (let i = 0; i < b.positions.length; i += 3) { minY = Math.min(minY, b.positions[i + 1]); maxY = Math.max(maxY, b.positions[i + 1]); maxX = Math.max(maxX, b.positions[i]); }
  check('cylinder stands along Y, height 10, centred', near(maxY - minY, 10) && near(minY, -5) && near(maxX, 1, 1e-3), `${minY}..${maxY} x ${maxX}`);
  check('sphere volume ~ 4/3 pi (segments 64)', near(r.parts[1].volume, (4 / 3) * Math.PI, 0.01), String(r.parts[1].volume));
}

// 4. errors: an assert, a thrown TypeError from the api, a syntax error
r = rt.run({ 'main.js': 'const w = 5;\nassert(w > 10, "too narrow");\nreturn box(w)' });
check('assert fails the build', !r.ok && r.error.message === 'Assertion failed: too narrow', r.error?.message);
check('assert reports the script line, not the prelude', r.error?.file === 'main.js' && r.error?.line === 2, `${r.error?.file}:${r.error?.line}`);
r = rt.run({ 'main.js': 'import { f } from "./parts/bad.js";\nreturn f()', 'parts/bad.js': 'export function f() {\n\n  return box("x");\n}' });
check('error inside an imported module names that file and line', r.error?.file === 'parts/bad.js' && r.error?.line === 3, `${r.error?.file}:${r.error?.line} ${r.error?.message}`);
r = rt.run({ 'main.js': 'import { f } from "./parts/bad.js";\nreturn f()', 'parts/bad.js': 'export function f() {\n  return (1 +;\n}' });
check('syntax error in an imported module names that file and line', r.error?.file === 'parts/bad.js' && r.error?.line === 2, `${r.error?.file}:${r.error?.line} ${r.error?.message}`);
r = rt.run({ 'main.js': 'const a = box(1);\n\necho("here", a.volume());\nreturn a' });
check('echo names its line', r.messages.some((m) => m.text.startsWith('ECHO (line 3): "here", 1') && m.file === 'main.js' && m.line === 3), JSON.stringify(r.messages));
r = rt.run({ 'main.js': 'return box(-1)' });
check('range error from the api', !r.ok && /box: width must be greater than 0/.test(r.error?.message ?? ''), r.error?.message);
check('range error points at the script line', r.error?.file === 'main.js' && r.error?.line === 1, `${r.error?.file}:${r.error?.line}`);
r = rt.run({ 'main.js': 'return box(1' });
check('syntax error reported', !r.ok && /SyntaxError|expected/i.test(r.error?.message ?? ''), r.error?.message);
check('syntax error on line 1 of main.js', r.error?.file === 'main.js' && r.error?.line === 1, `${r.error?.file}:${r.error?.line}`);
r = rt.run({ 'main.js': 'class A {}' });
check('class is rejected', !r.ok, r.error?.message);

// 4b. the 2D layer: areas and volumes with closed forms
r = rt.run({ 'main.js': `
  const c = circle(5, { segments: 360 });
  echo('area', c.area());
  const sq = rect(4, 6);
  const ring = difference(circle(5, { segments: 360 }), circle(3, { segments: 360 }));
  const tube = extrude(ring, 10);
  const tor = torus(10, 2, { segments: 180, tubeSegments: 90 });
  const hex = prism(6, 2, 5);
  const rr = roundedRect(10, 6, 1, { segments: 32 });
  const pen = sketch().moveTo(0, 0).lineTo(10, 0).lineTo(10, 4).lineTo(0, 4).close();
  const cut = projection(box(4, 2, 6), { cut: true });
  const sl = slot(10, 2, { segments: 360 });
  echo('sq', sq.area(), 'rr', rr.area(), 'pen', pen.area(), 'cut', cut.area(), 'slot', sl.area());
  return { tube, tor, hex, block: extrude(sq, 3), rev: revolve(rect(2, 4, { center: false }).translate(3, 0), { segments: 360 }) };
` });
check('2D scripts run', r.ok, r.error?.message);
if (r.ok) {
  const msgs = r.messages.map((m) => m.text).join('\n');
  const area = +msgs.match(/"area", ([\d.]+)/)[1];
  check('circle area ~ 25 pi', near(area, 25 * Math.PI, 1e-4), String(area));
  const m = msgs.match(/"sq", ([\d.]+), "rr", ([\d.]+), "pen", ([\d.]+), "cut", ([\d.]+), "slot", ([\d.]+)/);
  check('rect area 24', near(+m[1], 24));
  check('roundedRect area 60 - (4 - pi)', near(+m[2], 60 - (4 - Math.PI), 1e-3), m[2]);
  check('pen outline area 40', near(+m[3], 40));
  check('projection cut area 24 (4 x 6 footprint)', near(+m[4], 24), m[4]);
  check('slot area 2*2*10 + pi*4', near(+m[5], 40 + 4 * Math.PI, 1e-4), m[5]);
  const byName = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  check('tube volume pi*(25-9)*10', near(byName.tube.volume, Math.PI * 16 * 10, 1e-4), String(byName.tube.volume));
  check('torus volume 2 pi^2 R r^2', near(byName.tor.volume, 2 * Math.PI * Math.PI * 10 * 4, 2e-3), String(byName.tor.volume));
  check('hex prism volume', near(byName.hex.volume, (3 * Math.sqrt(3) / 2) * 4 * 5, 1e-9), String(byName.hex.volume));
  check('extruded rect volume 72, base on y=0', near(byName.block.volume, 72) && near(Math.min(...byName.block.positions.filter((_, i) => i % 3 === 1)), 0, 1e-9));
  check('revolved rect: annulus 3..5 x height 4', near(byName.rev.volume, Math.PI * (25 - 9) * 4, 1e-4), String(byName.rev.volume));
}

// 4c. screws, holes and the printer profile
r = rt.run({ 'main.js': `
  echo('fit', fit(5), 'wall', wall(1), 'layers', layers(3.1), 'hole0', hole(2, 10).bounds().size[0]);
  printer({ nozzle: 0.6, layer: 0.3, holeCompensation: 0.3, material: 'PETG' });
  echo('fit', fit(5, 'slide'), 'wall', wall(1.3), 'peg', peg(6, 'slide'), 'hole1', hole(2, 10).bounds().size[0]);
  const blk = box(20, 10, 20).onPlate();
  const plain = blk.subtract(screwHole('M4', 10, { type: 'counterbore' }).translate(0, 10, 0));
  const bridged = blk.subtract(screwHole('M4', 10, { type: 'counterbore', bridge: 0.2 }).translate(0, 10, 0));
  echo('membrane', bridged.volume() - plain.volume());
  return { pocket: blk.subtract(nutPocket('M3').translate(0, 10, 0)), insert: blk.subtract(heatInsert('M3').translate(0, 10, 0)), tapped: blk.subtract(screwHole('M3', 8, { type: 'tap' }).translate(0, 10, 0)) };
` });
check('screw scripts run', r.ok, r.error?.message);
if (r.ok) {
  const t = r.messages.map((m) => m.text).join('\n');
  check('profile defaults: fit 5.5, wall 1.2, layers 3.2, hole 4', /"fit", 5.5, "wall", 1.2, "layers", 3.2, "hole0", 4\b/.test(t), t.split('\n')[0]);
  check('declared profile: fit 5.45, wall 1.8, peg 5.7, hole 4.3', /"fit", 5.45, "wall", 1.8, "peg", 5.7, "hole1", 4.3\b/.test(t), t.split('\n')[1]);
  const membrane = +t.match(/"membrane", ([\d.]+)/)[1];
  check('counterbore bridge leaves a 0.2 mm disc', near(membrane, Math.PI * ((4.5 + 0.2) / 2) ** 2 * 0.2, 0.03), String(membrane));
  check('profile reported to the host', r.profile && r.profile.nozzle === 0.6 && r.profile.material === 'PETG' && r.profile.declared, JSON.stringify(r.profile));
  const byName = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  check('nut pocket removes a hexagon x depth', near(4000 - byName.pocket.volume, (3 * Math.sqrt(3) / 2) * ((5.5 + 0.2) / Math.sqrt(3)) ** 2 * 2.4, 1e-6), String(4000 - byName.pocket.volume));
  const poly = (n, r) => (n / 2) * Math.sin((2 * Math.PI) / n) * r * r; // area of the n-gon the cutter really is
  check('heat insert removes a 32-gon x depth', near(4000 - byName.insert.volume, poly(32, 2) * 6, 1e-6), String(4000 - byName.insert.volume));
  check('tap hole removes a 32-gon x length', near(4000 - byName.tapped.volume, poly(32, (2.5 + 0.2) / 2) * 8, 1e-6), String(4000 - byName.tapped.volume));
}
r = rt.run({ 'main.js': 'return box(2).subtract(hole(1, 4))' });
check('profile is null when none declared', r.ok && r.profile === null, JSON.stringify(r.profile));

// 4d. placement, anchors, measurement, annotations
r = rt.run({ 'main.js': `
  const base = box(40, 6, 30).onPlate().translate(5, 0, -2);
  const t = base.face('top');
  echo('top', t.center, t.normal, t.point([3, -4]));
  const boss = cylinder(4, 10).placeOn(base, 'top');
  echo('boss', boss.bounds().min, boss.bounds().max);
  const cut = screwHole('M3', 5).at(base.face('front'), [0, 1]);
  echo('cut', cut.bounds().max[2], cut.bounds().min[2]);
  const pin = cylinder(1, 10, { center: false }).anchor('tip', [0, 10, 0], [0, 1, 0]);
  echo('tip', pin.rotate(90, 0, 0).anchor('tip').point, pin.rotate(90, 0, 0).anchor('tip').normal, Object.keys(pin.translate(1, 0, 0).anchors));
  echo('clear', clearance(box(10), box(10).translate(15, 0, 0)), interference(box(10), box(10).translate(5, 0, 0)));
  dimension(base.face('top'), base.face('bottom'));
  mark(pin.anchor('tip'), 'tip');
  return base.add(pin.translate(0, 6, 0));
` });
check('placement script runs', r.ok, r.error?.message);
if (r.ok) {
  const t = r.messages.map((m) => m.text).join('\n');
  check('face centre, normal and uv point', t.includes('"top", [5, 6, -2], [0, 1, 0], [8, 6, -6]'), t.split('\n')[0]);
  check('placeOn centres the boss on the face', t.includes('"boss", [1, 6, -6], [9, 16, 2]'), t.split('\n')[1]);
  check('at() turns +Y along the front normal', t.includes('"cut", 14, 8'), t.split('\n')[2]);
  check('anchors rotate with the shape', t.includes('"tip", [0, 0, 10], [0, 0, 1], ["tip"]'), t.split('\n')[3]);
  check('clearance 5 and interference 500', t.includes('"clear", 5, 500'), t.split('\n')[4]);
  check('annotations reach the host', r.annotations.length === 2 && r.annotations[0].type === 'dimension' && r.annotations[0].label === '6 mm' && r.annotations[1].type === 'mark' && r.annotations[1].text === 'tip', JSON.stringify(r.annotations));
}

// 4e. paths, sweep, polyhedron, loft
r = rt.run({ 'main.js': `
  const sq = rect(6, 4);
  const v1 = sweep(sq, line([0, 0, 0], [0, 20, 0]));
  const v2 = sweep(rect(4, 4), path([[0, 0, 0], [30, 0, 0], [30, 0, 30]]));
  const ring = sweep(circle(3, { segments: 64 }), arc(20, 360, { segments: 128 }));
  const tet = polyhedron([[0, 0, 0], [6, 0, 0], [0, 6, 0], [0, 0, 6]], [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
  const lf = loft([rect(10, 10), rect(10, 10)], 7, { segments: 4 });
  const p7 = line([0, 0, 0], [20, 0, 0]).append(arc(10, 90));
  echo('len', p7.length(), helix(10, 40, 5).points.length, p7.pointAt(0.25));
  return { v1, v2, ring, tet, lf };
` });
check('sweep scripts run', r.ok, r.error?.message);
if (r.ok) {
  const byName = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  check('vertical sweep equals extrude: 6*4*20', near(byName.v1.volume, 480, 1e-6), String(byName.v1.volume));
  check('mitred square tube: 16 * 60', near(byName.v2.volume, 960, 1e-6), String(byName.v2.volume));
  check('swept ring ~ torus volume', near(byName.ring.volume, 2 * Math.PI * Math.PI * 20 * 9, 0.01), String(byName.ring.volume));
  check('polyhedron tetrahedron volume 36', near(byName.tet.volume, 36, 1e-9), String(byName.tet.volume));
  check('loft of equal squares is a prism: 700', near(byName.lf.volume, 700, 1e-6), String(byName.lf.volume));
  const t = r.messages.map((m) => m.text).join('\n');
  check('path length 20 + quarter arc chord sum', /"len", 3[0-9.]+, 241, \[8\.\d+, 0, 0\]/.test(t), t);
}
r = rt.run({ 'main.js': 'sweep(circle(5), path([[0, 0, 0], [3, 0, 0], [3, 0, 3]])); return box(1)' });
check('tight bend warns with a line', r.ok && r.messages.some((m) => m.kind === 'warn' && /too tight/.test(m.text) && m.line === 1), JSON.stringify(r.messages));

// 4f. edge fillets and chamfers
r = rt.run({ 'main.js': `
  const W = 40, H = 20, D = 30;
  const c1 = box(W, H, D).chamfer(3, { edges: 'top' });
  const c2 = box(W, H, D).fillet(4, { edges: 'top', segments: 64 });
  const plate = box(50, 4, 50).onPlate(), boss = box(16, 14, 16).onPlate();
  const base = plate.add(boss);
  const c5 = base.fillet(2, { edges: 'concave', segments: 64 });
  echo('concave', c5.volume() - base.volume(), 'edges', sharpEdges(box(10)).length, sharpEdges(cylinder(5, 10, { segments: 8 }), 30).length);
  return { c1, c2, c7: prism(6, 10, 10).chamfer(1.5, { edges: (e) => e.nA[1] > 0.9 || e.nB[1] > 0.9 }) };
` });
check('fillet scripts run', r.ok, r.error?.message);
if (r.ok) {
  const W = 40, H = 20, D = 30, f = 1 - Math.PI / 4, rr = 4;
  const byName = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  check('top chamfer exact volume', near(byName.c1.volume, W * H * D - (9 / 2) * (2 * W + 2 * D) + (4 * 27) / 3, 1e-6), String(byName.c1.volume));
  check('top fillet volume (64 segments)', near(byName.c2.volume, W * H * D - (f * rr * rr * (2 * W + 2 * D) - 4 * (2 * rr ** 3 * f - rr ** 3 / 3)), 0.002), String(byName.c2.volume));
  check('chamfered prism is smaller', byName.c7.volume < (3 * Math.sqrt(3) / 2) * 100 * 10);
  const t = r.messages.map((m) => m.text).join('\n');
  const m = t.match(/"concave", ([\d.]+), "edges", (\d+), (\d+)/);
  check('concave fillet adds the boss base ring', m && near(+m[1], f * 4 * 64 + 4 * 8 * (5 / 3 - Math.PI / 2), 0.002), t);
  check('a box has 12 sharp edges, an 8-gon cylinder 24 (two rings and eight 45-degree facets)', m && +m[2] === 12 && +m[3] === 24, t);
}

// 4g. text and lettering
r = rt.run({ 'main.js': `
  const t = text('TemenCAD', { size: 10 });
  const b = t.bounds();
  echo('text', b.size[0] > 30 && b.size[0] < 60, b.min[1] < 0.5 && b.min[1] > -3, b.max[1] > 6 && b.max[1] < 8.5, t.area() > 50);
  const c = text('ii', { size: 10, align: 'center' }).bounds();
  echo('centered', Math.abs(c.center[0]) < 0.6);
  const blk = box(40, 20, 30).onPlate();
  const L = polygon2d([[0, 0], [6, 0], [6, 2], [2, 2], [2, 8], [0, 8]]);
  echo('emboss', blk.emboss(L, blk.face('top'), { depth: 1.5 }).volume() - blk.volume(), blk.volume() - blk.engrave(L, blk.face('top'), { depth: 1.5 }).volume());
  let threw = ''; try { text('x', { font: 'Comic' }); } catch (e) { threw = e.message; }
  echo('unknown', threw);
  return { t3: text3d('3D', { size: 12, height: 3, align: 'center', font: 'Nunito Bold' }), mono: text3d('ab', { font: 'jetbrains-mono', height: 1 }) };
` });
check('text scripts run', r.ok, r.error?.message);
if (r.ok) {
  const t = r.messages.map((m) => m.text).join('\n');
  check('text has plausible bounds and area', t.includes('"text", true, true, true, true'), t.split('\n')[0]);
  check('centred text is centred', t.includes('"centered", true'), t.split('\n')[1]);
  check('emboss and engrave move exactly area x depth', /"emboss", 36(\.0*)?, 36(\.0*)?/.test(t.replace(/35\.99+\d*/g, '36')), t.split('\n')[2]);
  check('unknown font lists the available ones', /Unknown font \\"Comic\\". Available: Inter, Inter Bold, Nunito Bold, Source Serif 4, JetBrains Mono/.test(t), t.split('\n')[3]);
  const byName = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  check('text3d in a bold rounded font has volume and height 3', byName.t3.volume > 50 && near(Math.max(...byName.t3.positions.filter((_, i) => i % 3 === 1)), 3, 1e-6), String(byName.t3.volume));
  check('font names match loosely (jetbrains-mono)', byName.mono.volume > 1);
}

// 4h. images and mesh imports
// a 2x2 RGBA PNG: white, black / red, transparent
const png = (() => { // written here with zlib, so the decoder is tested against a known-good file
  const { deflateSync } = zlib;
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable.push(c >>> 0); }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6; // 2x2, 8-bit RGBA
  const raw = Buffer.from([0, 255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 0, 0]); // row filter 0: white, black / red, transparent
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();
const stl = 'solid t\n' + [[0,0,0, 6,0,0, 0,0,6], [0,0,0, 0,6,0, 6,0,0], [0,0,0, 0,0,6, 0,6,0], [6,0,0, 0,6,0, 0,0,6]].map((f) => `facet normal 0 0 0\n outer loop\n vertex ${f.slice(0,3).join(' ')}\n vertex ${f.slice(3,6).join(' ')}\n vertex ${f.slice(6,9).join(' ')}\n endloop\nendfacet\n`).join('') + 'endsolid t\n';
r = rt.run({
  'main.js': `import img from './pix.png'; import tet from './tet.stl';
    echo('px', [img.width, img.height], img.at(0, 0), img.at(1, 0), img.at(0, 1).toFixed(4), img.at(1, 1));
    const fn = heightmap((x, z) => 0.5, { width: 10, height: 2, base: 1, resolution: 4 });
    const flat = heightmap(img.resize(4, 4).invert().invert(), { width: 8, height: 0, base: 1, resolution: 4 });
    echo('ops', img.blur(1).gamma(0.5).normalize().crop(0, 0, 2, 1).resize(4).flip('y').width);
    return { fn, flat, tet, litho: lithophane(img, { width: 10, border: 1, resolution: 4 }) };`,
  'pix.png': png, 'tet.stl': stl,
});
check('image and mesh imports run', r.ok, r.error?.message);
if (r.ok) {
  const t = r.messages.map((m) => m.text).join('\n');
  check('PNG decodes: white 1, black 0, red 0.2126, transparent 1', t.includes('"px", [2, 2], 1, 0, "0.2126", 1'), t.split('\n')[0]);
  check('image ops chain', t.includes('"ops", 4'), t.split('\n')[1]);
  const byName = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  check('function heightmap at 0.5: 10x10x(1+1)', near(byName.fn.volume, 200, 1e-6), String(byName.fn.volume));
  check('zero-height relief is a plate', near(byName.flat.volume, 64, 1e-6), String(byName.flat.volume));
  check('STL tetrahedron imported, volume 36, Z-up to Y-up', near(byName.tet.volume, 36, 1e-6) && near(Math.max(...byName.tet.positions.filter((_, i) => i % 3 === 1)), 6, 1e-6), String(byName.tet.volume));
  check('lithophane with a border has a frame', byName.litho.volume > 0);
}

// 4i. printability
r = rt.run({ 'main.js': `
  const b = box(20, 10, 20).onPlate();
  const f = box(20, 10, 20).translate(0, 15, 0);
  const table = box(40, 3, 40).translate(0, 21.5, 0).add(cylinder(5, 20).translate(0, 10, 0));
  const thin = box(20, 10, 0.4).onPlate();
  const tube = difference(box(20, 10, 20), box(17.6, 12, 17.6)).onPlate();
  echo('r', overhangs(b).area, unsupported(f).area, overhangs(table).area, b.printability().ok, thin.printability().ok, minWallThickness(tube).thickness, minWallThickness(b).thickness);
  echo(thin.printability().problems[0]);
  return b;
` });
check('printability runs', r.ok, r.error?.message);
if (r.ok) {
  const t = r.messages.map((m) => m.text).join('\n');
  const m = t.match(/"r", ([\d.]+), ([\d.]+), ([\d.]+), (true|false), (true|false), ([\d.]+), (Infinity|[\d.]+)/);
  check('box has no overhangs, floating box 400 unsupported, table 1600 - pi*25', m && +m[1] === 0 && +m[2] === 400 && near(+m[3], 1600 - Math.PI * 25, 0.01), t.split('\n')[0]);
  check('verdicts: box ok, thin wall flagged', m && m[4] === 'true' && m[5] === 'false', t.split('\n')[0]);
  check('tube wall 1.2, solid box measures its far face at 10', m && near(+m[6], 1.2, 1e-6) && +m[7] === 10, t.split('\n')[0]);
  check('problem text names the wall', /thinnest wall 0\.40 mm at \[.*\], under 0\.8 mm/.test(t), t.split('\n')[1]);
}

// 4j. shell, erode, minkowski, roof
r = rt.run({ 'main.js': `
  const cup = cylinder(10, 20, { segments: 64 }).onPlate().shell(1.2, { open: 'top' });
  const shellBox = box(20, 10, 20).shell(2);
  const eroded = box(20, 10, 20).erode(2);
  const rounded = box(10).round(2, { segments: 16 });
  const pyramid = roof(rect(10, 10), { angle: 45 });
  const hip = roof(rect(20, 10), { angle: 45 });
  echo('mink', minkowski(box(2), box(2)).volume(), eroded.volume());
  return { cup, shellBox, rounded, pyramid, hip };
` });
check('shell/roof scripts run', r.ok, r.error?.message);
if (r.ok) {
  const byName = Object.fromEntries(r.parts.map((p) => [p.name, p]));
  const poly = (n, rr) => (n / 2) * Math.sin((2 * Math.PI) / n) * rr * rr;
  const apo = 10 * Math.cos(Math.PI / 64), inner = 64 * Math.tan(Math.PI / 64) * (apo - 1.2) ** 2; // erode trims each face plane by 1.2
  check('shelled cup: outer 64-gon x 20 minus the open cavity', near(byName.cup.volume, poly(64, 10) * 20 - inner * (20 - 1.2), 1e-6), String(byName.cup.volume));
  check('shelled box volume = outer - inner', near(byName.shellBox.volume, 20 * 10 * 20 - 16 * 6 * 16, 1e-6), String(byName.shellBox.volume));
  check('rounded box grows by r', near(Math.max(...byName.rounded.positions.filter((_, i) => i % 3 === 0)), 7, 1e-6), String(byName.rounded.volume));
  check('roof of a square is a pyramid: a^2 h / 3', near(byName.pyramid.volume, (100 * 5) / 3, 1e-3), String(byName.pyramid.volume));
  check('hip roof volume', near(byName.hip.volume, (20 * 10 * 5) / 3 + (10 * 5 * 5) / 3 * 0 + ((20 - 10) * 10 * 5) / 6, 1e-3), String(byName.hip.volume));
  const t = r.messages.map((m) => m.text).join('\n');
  check('minkowski of two unit-ish boxes is a 4-box; erode 2 of 20x10x20 is 16x6x16', t.includes('"mink", 64, 1536'), t);
}

// 4k. gears
r = rt.run({ 'main.js': `
  const [a, b] = gearPair({ module: 2, teeth: [20, 12], thickness: 6, backlash: 0.2 });
  const [e1, e2] = gearPair({ module: 2, teeth: [20, 12], thickness: 6 });
  echo('gear', a.bounds().size[0], gearDistance(2, 20, 12), intersects(a, b), interference(e1, e2) < 1e-6, clearance(a, b) > 0.02);
  return { a, b, rack: rack({ module: 2, teeth: 10, thickness: 6 }) };
` });
check('gear scripts run', r.ok, r.error?.message);
if (r.ok) {
  const m = r.messages.map((x) => x.text).join('\n').match(/"gear", ([\d.]+), ([\d.]+), (true|false), (true|false), (true|false)/);
  check('gear tips on the addendum circle: module x (teeth + 2)', m && near(+m[1], 44, 0.01), m && m[1]);
  check('gearDistance 32; the pair meshes: no overlap at zero backlash, clearance with backlash', m && +m[2] === 32 && m[3] === 'false' && m[4] === 'true' && m[5] === 'true', m && m[0]);
  const byName = Object.fromEntries(r.parts.map((x) => [x.name, x]));
  check('rack length teeth x pi x module', near(Math.max(...byName.rack.positions.filter((_, i) => i % 3 === 0)) - Math.min(...byName.rack.positions.filter((_, i) => i % 3 === 0)), 10 * Math.PI * 2, 0.05));
}

// 4l. ring gears and planetary sets
r = rt.run({ 'main.js': `
  const s = planetary({ module: 2, sun: 12, planet: 12, planets: 3, thickness: 6, backlash: 0.2 });
  echo('planetary', s.planets.length, s.planets.every((p) => !intersects(s.ring, p) && !intersects(s.sun, p)),
    Math.min(...s.planets.map((p) => clearance(s.ring, p))) > 0.05, ringAddendum(36, 12) < 1);
  return s;
` });
check('planetary scripts run', r.ok, r.error?.message);
if (r.ok) {
  const t = r.messages.map((x) => x.text).join('\n');
  check('three planets mesh with sun and ring, ring tips trimmed for 12-tooth planets', t.includes('"planetary", 3, true, true, true'), t);
  check('parts named sun, planet 1..3, ring', r.parts.map((x) => x.name).join() === 'sun,planet 1,planet 2,planet 3,ring', r.parts.map((x) => x.name).join());
}

// 4m. threads
r = rt.run({ 'main.js': `
  const bolt = thread({ size: 'M8', length: 12 });
  const nut = box(16, 12, 16).onPlate().subtract(thread({ size: 'M8', length: 12, internal: true, tolerance: 0.4 }));
  echo('thread', bolt.bounds().size[0], intersects(nut, bolt), thread({ size: 'Tr8x8(P2)', length: 4 }).bounds().size[1]);
  return { bolt, nut };
` });
check('thread scripts run', r.ok, r.error?.message);
if (r.ok) {
  const m = r.messages.map((x) => x.text).join('\n').match(/"thread", ([\d.]+), (true|false), ([\d.]+)/);
  check('M8 rod 8 across, fits its 0.4-tolerance hole, Tr8x8(P2) builds', m && near(+m[1], 8, 0.002) && m[2] === 'false' && +m[3] === 4, m && m[0]);
}

// 4n. split
r = rt.run({ 'main.js': `
  const beam = box(100, 20, 30).onPlate();
  const [a, b] = split(beam, { x: 10 });
  const laid = split(beam, { x: 0 }, { dowels: 2, layout: true });
  echo('split', a.volume() + b.volume(), a.bounds().max[0], laid.length, laid.every((p) => Math.abs(p.bounds().min[1]) < 1e-9));
  return laid;
` });
check('split scripts run', r.ok, r.error?.message);
if (r.ok) {
  const m = r.messages.map((x) => x.text).join('\n').match(/"split", ([\d.]+), ([\d.-]+), (\d+), (true|false)/);
  check('pieces add up to 60000, cut at x = 10, two pieces and two dowels laid on the plate', m && near(+m[1], 60000, 1e-9) && near(+m[2], 10, 1e-9) && +m[3] === 4 && m[4] === 'true', m && m[0]);
}

// 4m. SVG drawings: an imported file becomes a Sketch in mm, its markup a named export
r = rt.run({
  'main.js': `import logo, { markup } from './art/logo.svg';
    echo('svg', logo.bounds().size[0], logo.bounds().size[1], Math.abs(logo.area() - (200 - 25)) < 1e-9, markup.length > 0);
    return extrude(logo, 2);`,
  'art/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 40 20"><path fill-rule="evenodd" d="M0 0H40V20H0Z M10 5h10v10h-10z"/><text>hi</text></svg>',
});
check('svg import runs', r.ok, r.error?.message);
if (r.ok) {
  const t = r.messages.map((x) => x.text).join('\n');
  check('svg scaled to its mm size with an evenodd hole', t.includes('"svg", 20, 10, true, true'), t);
  check('svg warns about <text> and names the file', t.includes('art/logo.svg: svg: <text> elements are not imported'), t);
}

// 4n. shapes are freed by the collector when unreachable: a kept shape (and a sketch) survives
// collections triggered by hundreds of large throwaway meshes, and the run after still works
r = rt.run({ 'main.js': `
  const keep = cube(5), outline = circle(3);
  let total = 0;
  for (let i = 0; i < 150; i++) total += sphere(10, { segments: 96 }).volume();
  echo('kept', keep.volume(), outline.area() === circle(3).area(), total > 0);
  return keep.add(extrude(outline, 8));
` });
check('collected shapes run', r.ok, r.error?.message);
if (r.ok) {
  const t = r.messages.map((x) => x.text).join('\n');
  check('kept shape and sketch intact after collections', t.includes('"kept", 125, true, true'), t);
}

// 4o. a misspelt method names itself and its line
r = rt.run({ 'main.js': 'const s = box(10, 10, 10);\nreturn s.filet(2);' });
check('typo fails', !r.ok);
check('error names the method and line', r.error?.message === 'TypeError: s.filet is not a function' && r.error?.line === 2, JSON.stringify(r.error));

// 4p. parts come out in the order the object lists them (index names first, as in JavaScript)
r = rt.run({ 'main.js': 'const lid = box(1), body = box(2), base = box(3);\nreturn { lid, body, 2: base, base, 1: box(4) };' });
check('part order follows the object', r.ok && r.parts.map((p) => p.name).join() === '1,2,lid,body,base', r.error?.message ?? r.parts?.map((p) => p.name).join());

// 4q. main.js runs as written (no wrapper): return anywhere at top level, imports where they stand, exact lines
r = rt.run({ 'main.js': '// a part\nconst big = true;\nif (big) {\n  return box(4);\n}\nreturn box(1);' });
check('return inside a block', r.ok && near(r.parts[0].volume, 64), r.error?.message);
r = rt.run({ 'main.js': '// header\n\nimport { size } from "./dims.js";\nconst s = box(size);\nreturn s.nope();', 'dims.js': 'export const size = 2;' });
check('error line with an import below the top', !r.ok && r.error?.line === 5 && r.error?.file === 'main.js', JSON.stringify(r.error));
r = rt.run({ 'main.js': 'export const size = 3;\nreturn box(size);' });
check('main.js may export', r.ok && near(r.parts[0].volume, 27), r.error?.message);
r = rt.run({ 'main.js': 'const s = box(2);\nreturn s.translate([1, 0, 0]' });
check('an unfinished last line is reported on it', !r.ok && r.error?.line === 2, JSON.stringify(r.error));
r = rt.run({ 'main.js': 'box(2);' });
check('no return: nothing but what is shown', r.ok && r.parts.length === 0, r.error?.message);

// 4r. box takes its size as three numbers, an array or { x, y, z }; anything else is an error, not a 1 mm cube
r = rt.run({ 'main.js': 'return { a: box(2, 3, 4), b: box([2, 3, 4]), c: box({ x: 2, y: 3, z: 4, center: false }), d: box({ size: [2, 3, 4] }), e: roundedBox([20, 10, 4], 1), f: roundedBox(20, 10, 4, 1) };' });
check('box size forms', r.ok && r.parts.slice(0, 4).every((p) => near(p.volume, 24)), r.error?.message ?? r.parts?.map((p) => p.volume).join());
const minOf = (pos) => [0, 1, 2].map((k) => Math.min(...pos.filter((_, i) => i % 3 === k)));
check('box { center: false } has its corner on the origin', r.ok && minOf(r.parts[2].positions).every((v) => near(v, 0)), r.ok ? minOf(r.parts[2].positions).join() : '');
check('roundedBox size array', r.ok && near(r.parts[4].volume, r.parts[5].volume) && r.parts[4].volume < 800, r.ok ? `${r.parts[4].volume} vs ${r.parts[5].volume}` : '');
for (const [src, re] of [['box([1, 2])', /box: size must be \[x, y, z\]/], ['box({ w: 1, h: 2, d: 3 })', /box: unknown option 'w'/], ['box({ x: 1, y: 2 })', /needs x, y and z/], ['roundedBox({ x: 1, y: 1, z: 1, edge: "all" })', /unknown option 'edge'/]]) {
  r = rt.run({ 'main.js': `return ${src};` });
  check(`${src} is an error`, !r.ok && re.test(r.error?.message ?? ''), r.error?.message);
}

// 4s. the same script gives the same mesh whatever ran before it. Manifold collapses a lazy boolean
// chain only where no other shape holds its nodes, and shapes the collector has not freed yet used to
// count, so the triangulation followed the collector's timing (here: how many boxes came first).
{
  const holes = "const bar = box(30, 12, 10).onPlate();\nreturn bar.subtract(hole(3, 12, { axis: 'z' }).translate(-9, 6, 0)).subtract(hole(3, 12, { axis: 'z', shape: 'bridge' }).translate(0, 6, 0)).subtract(hole(3, 12, { axis: 'z', shape: 'round' }).translate(9, 6, 0));";
  const meshes = [0, 60, 64, 80, 92, 100, 112].map((n) => {
    const x = rt.run({ 'main.js': `printer({ nozzle: 0.4, layer: 0.2, holeCompensation: 0.2 });\nfor (let i = 0; i < ${n}; i++) box(1 + i * 0.01);\n${holes}` });
    return x.ok ? Array.from(x.parts[0].positions).join() + '|' + Array.from(x.parts[0].indices).join() : x.error?.message;
  });
  check('a boolean chain meshes the same whatever was made before it', meshes.every((m) => m === meshes[0]), `${new Set(meshes).size} different meshes`);
}

// 5. the runtime survives errors and runs again
r = rt.run({ 'main.js': 'return box(3)' });
check('runs again after errors', r.ok && near(r.parts[0].volume, 27), r.error?.message);
check('empty part warning', (() => { const x = rt.run({ 'main.js': 'return difference(box(1), box(2))' }); return x.ok && x.parts.length === 0 && x.messages.some((m) => m.kind === 'warn' && /empty/.test(m.text)); })());

// 6. the conversation format (core/CONVERSATION.md): inline base64 and references round-trip, blobs by SHA-256
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64');
  const conv = {
    format: 2, app: 'smoke', notes: [],
    entries: [{ kind: 'user', text: 'é ✓ "quoted"' }, { kind: 'reply', message: 'x', changed: true, before: 0, after: 1 }],
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }, { type: 'text', text: 'hi' }] }],
    checkpoints: [{ 'main.js': { $blob: 'a' } }, { 'main.js': { $blob: 'b' }, 'gear.stl': { $blob: 'big' } }],
    attachments: [],
  };
  const big = new Uint8Array(200000).map((_, i) => i * 7);
  const blobs = new Map([['a', new TextEncoder().encode('return 1;')], ['b', new TextEncoder().encode('return 2;')], ['big', big]]);
  const entries = rt.packConversation(conv, blobs);
  const names = Object.keys(entries);
  check('conversation packs to json + 4 blobs', names.length === 5 && names.includes('.assistant/conversation.json') && names.filter((n) => /^\.assistant\/blobs\/[0-9a-f]{64}$/.test(n)).length === 4, names.join());
  const back = rt.unpackConversation({ ...entries, 'main.js': new Uint8Array(1) });
  const j = back && JSON.parse(back.json);
  check('conversation unpacks: base64 inline, text intact', j?.messages[0].content[0].source.data === conv.messages[0].content[0].source.data && j.entries[0].text === conv.entries[0].text);
  const key = j?.checkpoints[1]['gear.stl'].$blob;
  check('conversation references come back by SHA-256 with their bytes', /^[0-9a-f]{64}$/.test(key ?? '') && back.blobs.get(key)?.length === big.length && back.blobs.get(key).every((v, i) => v === big[i]));
  check('no conversation is null', rt.unpackConversation({ 'main.js': new Uint8Array(1) }) === null);
  let msg = '';
  try { rt.packConversation({ v: 1, entries: [] }); } catch (e) { msg = e.message; }
  check('format 1 is refused', /format/.test(msg), msg);
  try { rt.unpackConversation({ ...entries, [names.find((n) => n.includes('blobs'))]: new Uint8Array([1, 2]) }); msg = ''; } catch (e) { msg = e.message; }
  check('a damaged blob is refused', /damaged/.test(msg), msg);
}

// 7. the syntax check: as a run compiles each script, without running it or loading its imports
{
  check('a good main.js checks clean, with its top-level return', rt.checkScript('main.js', 'const a = cube(10);\nreturn a;\n') === null);
  check('a module with imports and exports checks clean', rt.checkScript('parts/a.js', "import { x } from './nowhere.js';\nexport const y = x;\n") === null);
  const e = rt.checkScript('main.js', 'const a = cube(10);\nconst b = (a + ;\nreturn a;\n');
  check('a syntax error has its line and column', e?.line === 2 && e.column >= 15 && e.column <= 16 && /expected/.test(e.message), JSON.stringify(e));
  check('top-level return is an error outside main.js', /return/.test(rt.checkScript('parts/a.js', 'return 1;')?.message ?? ''));
  check('an unterminated block is reported on the last line', rt.checkScript('main.js', 'if (true) {\n  cube(1);\n')?.line === 2);
  check('subset words are errors', rt.checkScript('main.js', 'var a = 1;') !== null);
  check('a check runs nothing', rt.checkScript('main.js', "throw new Error('no');") === null);
  check('the run still works after checks', rt.run({ 'main.js': 'return cube(10);' }).ok);
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
