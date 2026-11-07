/**
 * Model-building worker. Loads the Manifold wasm and the bundled fonts, then builds projects sent as
 * { type: 'run', id, files } and posts back mesh buffers (transferred, not copied).
 */
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { init } from './engine.js';
import { registerFont, FONTS } from './fonts.js';
import { runScript } from './runner.js';
import { renderViews, sectionMeshes } from './render.js';

// Vite resolves every bundled font to a hashed URL at build time.
const fontUrls = import.meta.glob('./assets/*-subset.ttf', { query: '?url', import: 'default', eager: true });
const loadFonts = Promise.all(FONTS.map(({ name, file }) =>
  fetch(fontUrls[`./assets/${file}`]).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
    .then((buf) => registerFont(name, buf))
    .catch((err) => console.warn(`Font "${name}" failed to load: ${err.message}`))));

// Project scripts become blob: module URLs, importable from a module worker.
const env = {
  makeUrl: (source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
  async decodeImage(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: bmp.width, height: bmp.height, rgba: data };
  },
  revokeUrl: (url) => URL.revokeObjectURL(url),
};

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

async function handle({ type, id, files, meshes, options }) {
  if (type === 'render') {
    try {
      const list = options.section ? sectionMeshes(meshes, options.section) : meshes;
      const png = renderViews(list, { views: options.views, width: options.width, height: options.height, labels: options.labels !== false, section: options.section ?? null });
      self.postMessage({ type: 'rendered', id, png }, [png.buffer]);
    } catch (err) {
      self.postMessage({ type: 'render-error', id, message: err.message ?? String(err) });
    }
    return;
  }
  if (type !== 'run') return;
  try {
    const { meshes, tris, ms } = await runScript(files, (m) => self.postMessage({ ...m, id }), env);
    const transfer = meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer]);
    self.postMessage({ type: 'result', id, meshes, tris, ms }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message ?? String(err), file: err.file ?? null, line: err.line ?? null, trace: err.trace ?? [] });
  }
}
