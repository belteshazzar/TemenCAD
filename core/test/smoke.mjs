// Smoke test for the WebAssembly build: node core/test/smoke.mjs [path/to/build/wasm]
// Exact volumes where a closed form exists; exits 1 on any mismatch.
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

// 5. the runtime survives errors and runs again
r = rt.run({ 'main.js': 'return box(3)' });
check('runs again after errors', r.ok && near(r.parts[0].volume, 27), r.error?.message);
check('empty part warning', (() => { const x = rt.run({ 'main.js': 'return difference(box(1), box(2))' }); return x.ok && x.parts.length === 0 && x.messages.some((m) => m.kind === 'warn' && /empty/.test(m.text)); })());

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
