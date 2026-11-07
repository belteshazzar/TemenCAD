/**
 * Model-building worker. Loads the Manifold wasm, then executes scripts sent as
 * { type: 'run', id, code } and posts back mesh buffers (transferred, not copied).
 */
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { init } from './engine.js';
import { registerFont, FONTS } from './fonts.js';
import { runScript } from './runner.js';

// Vite resolves every bundled font to a hashed URL at build time.
const fontUrls = import.meta.glob('./assets/*-subset.ttf', { query: '?url', import: 'default', eager: true });
const loadFonts = Promise.all(FONTS.map(({ name, file }) =>
  fetch(fontUrls[`./assets/${file}`]).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
    .then((buf) => registerFont(name, buf))
    .catch((err) => console.warn(`Font "${name}" failed to load: ${err.message}`))));

const queue = [];
let ready = false;

self.onmessage = (e) => { if (ready) handle(e.data); else queue.push(e.data); };

Promise.all([init({ locateFile: () => wasmUrl }), loadFonts])
  .then(() => {
    ready = true;
    self.postMessage({ type: 'ready' });
    for (const msg of queue.splice(0)) handle(msg);
  })
  .catch((err) => {
    for (const msg of queue.splice(0)) self.postMessage({ type: 'error', id: msg.id, message: `Geometry engine failed to load: ${err?.message ?? err}` });
    self.onmessage = (e) => self.postMessage({ type: 'error', id: e.data.id, message: `Geometry engine failed to load: ${err?.message ?? err}` });
  });

function handle({ type, id, code }) {
  if (type !== 'run') return;
  try {
    const { meshes, tris, ms } = runScript(code, (m) => self.postMessage({ ...m, id }));
    const transfer = meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer]);
    self.postMessage({ type: 'result', id, meshes, tris, ms }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message ?? String(err), line: err.line ?? null, trace: err.trace ?? [] });
  }
}
