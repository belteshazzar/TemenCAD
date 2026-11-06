/**
 * Geometry engine: Manifold (C++ CSG kernel compiled to WebAssembly).
 * Every Manifold / CrossSection object lives in wasm memory and must be freed,
 * so creations are tracked and released in bulk after each script run.
 */
import Module from 'manifold-3d';

let wasm = null;
let initPromise = null;
const live = new Set();

/** Load the wasm once. `opts.locateFile` lets a bundler supply the .wasm URL. */
export function init(opts = {}) {
  if (!initPromise) {
    initPromise = Module(opts).then((m) => { m.setup(); wasm = m; return m; });
  }
  return initPromise;
}

/** The loaded module (throws if init() has not completed). */
export function M() {
  if (!wasm) throw new Error('Geometry engine not initialised yet');
  return wasm;
}

export function track(obj) { live.add(obj); return obj; }

/** Free every tracked wasm object. Call after a run's meshes have been extracted. */
export function releaseAll() {
  for (const o of live) { try { o.delete(); } catch { /* already freed */ } }
  live.clear();
}

export const liveCount = () => live.size;
