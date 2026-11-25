// Regression test: every script under test/ and the demo built by the core, compared with
// core/test/golden.json — the parts (names, volumes, bounds, colours, flags), annotations and printer
// profile. The reference was first recorded from the JavaScript modelling layer, with the two runtimes
// building every script identically, just before that layer was retired; scripts and demo parts added
// since are recorded from the core with --record once they are checked. A DIFF means the core moved.
//
//   node core/test/diff.mjs                  all scripts
//   node core/test/diff.mjs fillet           scripts whose path contains "fillet"
//   node core/test/diff.mjs --record gear    store what the core builds now as the reference for the
//                                            matching scripts (a filter is required; check them first)
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../wasm/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { projectFromDisk } = await import(join(ROOT, 'src/headless.js'));
const golden = JSON.parse(readFileSync(join(ROOT, 'core/test/golden.json'), 'utf8'));
const { Project } = await import(join(ROOT, 'src/project.js'));
const { DEFAULT_SCRIPT } = await import(join(ROOT, 'src/default-script.js'));

const args = process.argv.slice(2);
const record = args.includes('--record');
const filter = args.find((a) => !a.startsWith('--')) ?? '';
if (record && !filter) { console.error('--record needs a filter naming the scripts to record (e.g. --record gear)'); process.exit(2); }
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

let diffs = 0, unsupported = 0, ok = 0, recorded = 0;
const cases = scripts.map((p) => ({ label: p.slice(ROOT.length + 1), project: () => projectFromDisk(p) }));
cases.push({ label: 'src/default-script.js (demo)', project: () => { const pr = new Project(); pr.set('main.js', DEFAULT_SCRIPT); return pr; } });

for (const c of cases) {
  if (filter && !c.label.includes(filter)) continue;
  let project;
  try { project = c.project(); } catch (e) { console.log(`OLD-FAIL    ${c.label}: ${e.message}`); continue; }
  const old = golden[c.label];
  if (!old && !record) { diffs++; console.log(`NO-GOLDEN   ${c.label}: not in core/test/golden.json (check it, then --record it)`); continue; }
  const files = project.toFiles();
  const res = rt.run(files);
  if (record) {
    if (!res.ok) { console.log(`NOT RECORDED ${c.label}: ${res.error.message}`); diffs++; continue; }
    golden[c.label] = { parts: res.parts.map((p) => ({ name: p.name, volume: p.volume, bounds: boundsOf(p.positions), color: p.color, ghost: p.ghost, hidden: p.hidden })), annotations: res.annotations, profile: res.profile };
    recorded++;
    console.log(`recorded    ${c.label}  (${res.parts.length} parts)`);
    continue;
  }
  if (!res.ok) {
    unsupported++;
    console.log(`UNSUPPORTED ${c.label}: ${res.error.message}${res.error.file ? ` (${res.error.file}:${res.error.line})` : ''}`);
    continue;
  }
  const problems = [];
  if (old.parts.length !== res.parts.length) problems.push(`part count ${old.parts.length} vs ${res.parts.length}`);
  const n = Math.min(old.parts.length, res.parts.length);
  for (let i = 0; i < n; i++) {
    const a = old.parts[i], b = res.parts[i];
    if (a.name !== b.name) problems.push(`part ${i} name "${a.name}" vs "${b.name}"`);
    if (!near(a.volume, b.volume, VOL_TOL)) problems.push(`"${a.name}" volume ${a.volume.toFixed(6)} vs ${b.volume.toFixed(6)}`);
    const ba = a.bounds, bb = boundsOf(b.positions);
    for (let k = 0; k < 3; k++) {
      if (!near(ba.min[k], bb.min[k], BOUNDS_TOL) || !near(ba.max[k], bb.max[k], BOUNDS_TOL)) { problems.push(`"${a.name}" bounds ${ba.min.map((v) => v.toFixed(4))}..${ba.max.map((v) => v.toFixed(4))} vs ${bb.min.map((v) => v.toFixed(4))}..${bb.max.map((v) => v.toFixed(4))}`); break; }
    }
    if (a.color !== b.color) problems.push(`"${a.name}" color ${a.color} vs ${b.color}`);
    if (a.ghost !== b.ghost || a.hidden !== b.hidden) problems.push(`"${a.name}" ghost/hidden flags differ`);
  }
  const oa = old.annotations ?? [], na = res.annotations ?? [];
  const r4 = (v) => (typeof v === 'number' ? +v.toFixed(4) : Array.isArray(v) ? v.map(r4) : v);
  if (JSON.stringify(oa.map(r4)) !== JSON.stringify(na.map(r4))) problems.push(`annotations ${JSON.stringify(oa.map(r4)).slice(0, 120)} vs ${JSON.stringify(na.map(r4)).slice(0, 120)}`);
  const op = old.profile ?? null, np = res.profile;
  if (!!op !== !!np || (op && (op.nozzle !== np.nozzle || op.layer !== np.layer || op.holeCompensation !== np.holeCompensation || (op.material ?? null) !== np.material))) problems.push(`profile ${JSON.stringify(op)} vs ${JSON.stringify(np)}`);
  if (problems.length) { diffs++; console.log(`DIFF        ${c.label}\n    ${problems.slice(0, 8).join('\n    ')}${problems.length > 8 ? `\n    … ${problems.length - 8} more` : ''}`); }
  else { ok++; console.log(`ok          ${c.label}  (${res.parts.length} parts, ${res.ms.toFixed(0)} ms)`); }
}
if (record) {
  writeFileSync(join(ROOT, 'core/test/golden.json'), JSON.stringify(golden, null, 1));
  console.log(`\nrecorded ${recorded} script(s) in core/test/golden.json`);
  process.exit(diffs ? 1 : 0);
}
console.log(`\n${ok} ok, ${diffs} differ, ${unsupported} unsupported`);
process.exit(diffs ? 1 : 0);
