/**
 * Model-building worker. Starts the TemenCAD core (lamassu + Manifold, one wasm module), then builds
 * projects sent as { type: 'run', id, files } and posts back mesh buffers (transferred, not copied).
 * Renders ({ type: 'render' }) draw the labelled view sheet from meshes the main thread already has.
 */
import coreWasmUrl from '../core/wasm/dist/temencore.wasm?url';
import { initCore, runScriptCore, coreRuntime } from './core-runner.js';
import { renderViews, sectionMeshes } from './render.js';

const queue = [];
let ready = false;

self.onmessage = (e) => { if (ready) handle(e.data); else queue.push(e.data); };

initCore({ locateFile: () => coreWasmUrl })
  .then(() => {
    ready = true;
    self.postMessage({ type: 'ready' });
    for (const msg of queue.splice(0)) handle(msg);
  })
  .catch((err) => {
    for (const msg of queue.splice(0)) self.postMessage({ type: 'error', id: msg.id, message: `The TemenCAD core failed to load: ${err?.message ?? err}` });
    self.onmessage = (e) => self.postMessage({ type: 'error', id: e.data.id, message: `The TemenCAD core failed to load: ${err?.message ?? err}` });
  });

async function handle({ type, id, files, meshes, options, json, blobs, entries }) {
  // the conversation in a .temen (core/CONVERSATION.md), packed and read by the core
  if (type === 'conversation-pack' || type === 'conversation-unpack') {
    try {
      const rt = coreRuntime();
      const result = type === 'conversation-pack' ? rt.packConversation(json, blobs) : rt.unpackConversation(entries);
      self.postMessage({ type: 'conversation', id, result });
    } catch (err) {
      self.postMessage({ type: 'conversation-error', id, message: err.message ?? String(err) });
    }
    return;
  }
  if (type === 'render') {
    try {
      const list = options.section ? sectionMeshes(meshes, options.section) : meshes;
      const png = renderViews(list, { views: options.views, width: options.width, height: options.height, labels: options.labels !== false, section: options.section ?? null, annotations: options.annotations ?? [] });
      self.postMessage({ type: 'rendered', id, png }, [png.buffer]);
    } catch (err) {
      self.postMessage({ type: 'render-error', id, message: err.message ?? String(err) });
    }
    return;
  }
  if (type !== 'run') return;
  try {
    const { meshes, tris, ms, annotations, profile } = await runScriptCore(files, (m) => self.postMessage({ ...m, id }));
    const transfer = meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer]);
    self.postMessage({ type: 'result', id, meshes, tris, ms, annotations, profile }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message ?? String(err), file: err.file ?? null, line: err.line ?? null, trace: err.trace ?? [] });
  }
}
