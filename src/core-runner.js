/**
 * The lamassu core as a drop-in for runner.js: the same runScript(files, post, env) contract, the same
 * result ({ meshes, tris, ms, annotations, profile }), the same messages ({ type: 'log' | 'warn', text,
 * file, line, trace }) and the same ScriptError on failure, produced by core/wasm instead of the
 * JavaScript modelling layer that preceded it. Pure module: the browser worker and the Node command line both use it.
 */
import { createRuntime } from '../core/wasm/index.js';

/** A script failure with the user-script location(s) it came from: trace = [{ file, line }], innermost first. */
export class ScriptError extends Error {
  constructor(message, trace) { super(message); this.name = 'ScriptError'; this.trace = trace; this.file = trace[0]?.file ?? null; this.line = trace[0]?.line ?? null; }
}

let runtime = null;
/* initCore (below): start the core once; `moduleOptions` reach the Emscripten factory (e.g. locateFile for a bundler). */

/** Build a project on the core. `files` is { name: string | ArrayBuffer }; `post` receives log and warn messages during the run. */
export async function runScriptCore(files, post) {
  const rt = await initCore();
  const r = rt.run(files);
  for (const m of r.messages) {
    if (m.kind === 'warn') post({ type: 'warn', text: m.text, file: m.file, line: m.line, trace: m.file ? [{ file: m.file, line: m.line }] : [] });
    else post({ type: 'log', text: m.text });
  }
  if (!r.ok) throw new ScriptError(r.error.message, r.error.file ? [{ file: r.error.file, line: r.error.line }] : []);
  const meshes = r.parts.map((p) => ({ positions: p.positions, indices: p.indices, color: p.color, name: p.name, named: p.named, ghost: p.ghost, hidden: p.hidden, volume: p.volume }));
  const tris = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  return { meshes, tris, ms: r.ms, annotations: r.annotations, profile: r.profile };
}

let started = null;
/** The started runtime, for synchronous callers (the renderer); throws when initCore() has not resolved yet. */
export function coreRuntime() {
  if (!started) throw new Error('the TemenCAD core has not started');
  return started;
}
const remember = (p) => p.then((rt) => { started = rt; return rt; });
export function initCore(moduleOptions) {
  if (!runtime) runtime = remember(createRuntime(moduleOptions)).catch((err) => { runtime = null; throw err; });
  return runtime;
}
