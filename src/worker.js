/**
 * Model-building worker. Loads the Manifold wasm, then executes scripts sent as
 * { type: 'run', id, code } and posts back mesh buffers (transferred, not copied).
 */
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import fontUrl from './assets/Inter-Regular-subset.ttf?url';
import { init } from './engine.js';
import { registerFont, DEFAULT_FONT } from './fonts.js';
import { runScript } from './runner.js';

const loadFont = fetch(fontUrl).then((r) => { if (!r.ok) throw new Error(`font ${r.status}`); return r.arrayBuffer(); })
  .then((buf) => registerFont(DEFAULT_FONT, buf))
  .catch((err) => console.warn(`Default font failed to load; text() will be unavailable: ${err.message}`));

const queue = [];
let ready = false;

self.onmessage = (e) => { if (ready) handle(e.data); else queue.push(e.data); };

Promise.all([init({ locateFile: () => wasmUrl }), loadFont])
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
