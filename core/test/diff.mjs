// Differential test: every script under test/ (and the demo script) built by the browser-era
// JavaScript runner and by the lamassu core, parts compared by name, volume and bounds.
//
//   node core/test/diff.mjs            all scripts
//   node core/test/diff.mjs fillet     scripts whose path contains "fillet"
//
// Lines: `ok` parity, `DIFF` both built but disagree (exit 1), `UNSUPPORTED` the core rejected
// the script (reported, not failed: the port is incomplete), `OLD-FAIL` the reference failed.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../wasm/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { buildProject, projectFromDisk } = await import(join(ROOT, 'src/headless.js'));
const { Project } = await import(join(ROOT, 'src/project.js'));
const { DEFAULT_SCRIPT } = await import(join(ROOT, 'src/default-script.js'));

const filter = process.argv[2] ?? '';
const scripts = [];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.js')) scripts.push(p);
  }
};
walk(join(ROOT, 'test'));
scripts.sort();

const rt = await createRuntime();
const VOL_TOL = 1e-6, BOUNDS_TOL = 1e-5;
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const boundsOf = (positions) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
  return { min, max };
};

let diffs = 0, unsupported = 0, ok = 0;
const cases = scripts.map((p) => ({ label: p.slice(ROOT.length + 1), project: () => projectFromDisk(p) }));
cases.push({ label: 'src/default-script.js (demo)', project: () => { const pr = new Project(); pr.set('main.js', DEFAULT_SCRIPT); return pr; } });

for (const c of cases) {
  if (filter && !c.label.includes(filter)) continue;
  let project;
  try { project = c.project(); } catch (e) { console.log(`OLD-FAIL    ${c.label}: ${e.message}`); continue; }
  let old;
  try { old = await buildProject(project, {}); } catch (e) { console.log(`OLD-FAIL    ${c.label}: ${e.message}`); continue; }
  const files = project.toFiles();
  const res = rt.run(files);
  if (!res.ok) {
    unsupported++;
    console.log(`UNSUPPORTED ${c.label}: ${res.error.message}${res.error.file ? ` (${res.error.file}:${res.error.line})` : ''}`);
    continue;
  }
  const problems = [];
  if (old.meshes.length !== res.parts.length) problems.push(`part count ${old.meshes.length} vs ${res.parts.length}`);
  const n = Math.min(old.meshes.length, res.parts.length);
  for (let i = 0; i < n; i++) {
    const a = old.meshes[i], b = res.parts[i];
    if (a.name !== b.name) problems.push(`part ${i} name "${a.name}" vs "${b.name}"`);
    if (!near(a.volume, b.volume, VOL_TOL)) problems.push(`"${a.name}" volume ${a.volume.toFixed(6)} vs ${b.volume.toFixed(6)}`);
    const ba = boundsOf(a.positions), bb = boundsOf(b.positions);
    for (let k = 0; k < 3; k++) {
      if (!near(ba.min[k], bb.min[k], BOUNDS_TOL) || !near(ba.max[k], bb.max[k], BOUNDS_TOL)) { problems.push(`"${a.name}" bounds ${ba.min.map((v) => v.toFixed(4))}..${ba.max.map((v) => v.toFixed(4))} vs ${bb.min.map((v) => v.toFixed(4))}..${bb.max.map((v) => v.toFixed(4))}`); break; }
    }
    if (a.color !== b.color) problems.push(`"${a.name}" color ${a.color} vs ${b.color}`);
    if (!!a.ghost !== b.ghost || !!a.hidden !== b.hidden) problems.push(`"${a.name}" ghost/hidden flags differ`);
  }
  const op = old.profile ?? null, np = res.profile;
  if (!!op !== !!np || (op && (op.nozzle !== np.nozzle || op.layer !== np.layer || op.holeCompensation !== np.holeCompensation || (op.material ?? null) !== np.material))) problems.push(`profile ${JSON.stringify(op)} vs ${JSON.stringify(np)}`);
  if (problems.length) { diffs++; console.log(`DIFF        ${c.label}\n    ${problems.slice(0, 8).join('\n    ')}${problems.length > 8 ? `\n    … ${problems.length - 8} more` : ''}`); }
  else { ok++; console.log(`ok          ${c.label}  (${res.parts.length} parts, ${res.ms.toFixed(0)} ms core vs ${old.ms.toFixed(0)} ms js)`); }
}
console.log(`\n${ok} ok, ${diffs} differ, ${unsupported} unsupported`);
process.exit(diffs ? 1 : 0);
