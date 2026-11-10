/**
 * The core's pointing and measuring (core/src/pick.c) against the web app's (src/pick-geometry.js),
 * word for word: every test script, the image and SVG projects and the demo are built once (the
 * WebAssembly core gives the same meshes as the native one, see core:export); about N triangles of
 * every part are picked by the native tool (temencore --pick N) and by the JavaScript module, and the
 * surface's triangles, label and description must match, as must the measurement from each sampled
 * triangle to the next (points: triangle centroids).
 *
 *   node core/test/pick-parity.mjs [path/to/temencore] [N]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { buildProject, loadProject } from '../../src/headless.js';
import { topology, surfaceAt, shortLabel, describeSurface, measureBetween } from '../../src/pick-geometry.js';
import { DEFAULT_SCRIPT } from '../../src/default-script.js';

const root = resolve(import.meta.dirname, '../..');
const bin = resolve(process.argv[2] ?? join(root, 'build/native/temencore'));
const samples = Number(process.argv[3] ?? 60);
const dir = mkdtempSync(join(tmpdir(), 'temen-pick-'));
const demo = join(dir, 'demo.js');
writeFileSync(demo, DEFAULT_SCRIPT);
const inputs = [
  ...readdirSync(join(root, 'test')).filter((f) => f.endsWith('.js')).map((f) => join(root, 'test', f)),
  join(root, 'test/images'), join(root, 'test/svg'), demo,
];

let failed = 0, checked = 0;
for (const input of inputs) {
  const jsInput = input.endsWith('images') || input.endsWith('svg') ? join(input, 'main.js') : input;
  const native = execFileSync(bin, [input, '--pick', String(samples)], { maxBuffer: 1 << 30 }).toString().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const { meshes } = await buildProject(loadProject(jsInput));
  const topos = meshes.map((m) => topology(m.positions, m.indices));
  const centroid = (m, t) => [0, 1, 2].map((j) => (m.positions[m.indices[3 * t] * 3 + j] + m.positions[m.indices[3 * t + 1] * 3 + j] + m.positions[m.indices[3 * t + 2] * 3 + j]) / 3);
  let bad = 0;
  for (const n of native) {
    const m = meshes[n.part], topo = topos[n.part];
    if (n.surface) {
      const s = surfaceAt(topo, n.tri), pt = centroid(m, n.tri);
      const js = { tris: s.tris.join(), label: shortLabel(m.name, s), description: describeSurface(m.name, s, pt) };
      const c = { tris: n.surface.tris.join(), label: n.surface.label, description: n.surface.description };
      for (const k of ['label', 'description', 'tris']) if (js[k] !== c[k]) { if (bad < 3) console.log(`FAIL ${basename(input)} part ${n.part} tri ${n.tri} ${k}:\n  js   ${js[k].slice(0, 300)}\n  core ${c[k].slice(0, 300)}`); bad++; break; }
    } else {
      const end = (t, snapped) => ({ point: centroid(m, t), snapped, part: m.name, surface: surfaceAt(topo, t) });
      const js = measureBetween(end(n.from, n.snapped === 1), end(n.tri, false));
      if (js.text !== n.measure.text || js.label !== n.measure.label) { if (bad < 3) console.log(`FAIL ${basename(input)} measure ${n.from} -> ${n.tri}:\n  js   ${js.text}\n  core ${n.measure.text}`); bad++; }
    }
    checked++;
  }
  console.log(`${bad ? 'FAIL' : 'ok  '} ${basename(input)}  ${native.length} picks and measurements${bad ? `, ${bad} differ` : ''}`);
  failed += bad;
}
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} of ${checked} differ` : `all ${checked} identical`);
process.exit(failed ? 1 : 0);
