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

// 5. the runtime survives errors and runs again
r = rt.run({ 'main.js': 'return box(3)' });
check('runs again after errors', r.ok && near(r.parts[0].volume, 27), r.error?.message);
check('empty part warning', (() => { const x = rt.run({ 'main.js': 'return difference(box(1), box(2))' }); return x.ok && x.parts.length === 0 && x.messages.some((m) => m.kind === 'warn' && /empty/.test(m.text)); })());

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
