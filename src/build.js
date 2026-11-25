/**
 * Client side of the model-building worker. One build runs at a time; a run
 * requested mid-build is queued and starts when the current one finishes.
 * Cancel terminates the worker and spawns a fresh one.
 */
export class Builder {
  /**
   * @param {object} h  callbacks:
   *   getFiles() -> { name: string | ArrayBuffer }, onStart(), onLog(text), onWarn(msg), onCancel(),
   *   onFinish(msg) -> report   (msg is the worker's 'result' or 'error' message)
   */
  constructor(h) {
    this.h = h;
    this.worker = null;
    this.runId = 0;
    this.current = null;
    this.pending = false;
    this.waiters = [];
    this.renders = new Map();
    this.renderId = 0;
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => { if (this.current) this.finish({ type: 'error', message: `Worker error: ${e.message}` }); };
  }

  get busy() { return !!this.current; }

  run() {
    if (this.current) { this.pending = true; return; }
    this.current = { id: ++this.runId };
    this.h.onStart?.();
    this.worker.postMessage({ type: 'run', id: this.current.id, files: this.h.getFiles() });
  }

  /** Trigger a build and resolve with its report when it finishes. */
  runAndWait() {
    return new Promise((resolve) => { this.waiters.push(resolve); this.run(); });
  }

  cancel() {
    if (!this.current) return;
    this.worker.terminate();
    for (const r of this.renders.values()) r.reject(new Error('Build cancelled'));
    this.renders.clear();
    this.current = null;
    this.pending = false;
    this.spawn();
    this.h.onCancel?.();
  }

  /** Render the given meshes to a PNG (Uint8Array) in the worker: { views, width, height, labels, section }. */
  render(meshes, options) {
    return new Promise((resolve, reject) => {
      const id = `r${++this.renderId}`;
      this.renders.set(id, { resolve, reject });
      // Copies, not transfers: the viewer keeps using these buffers.
      this.worker.postMessage({ type: 'render', id, meshes: meshes.map((m) => ({ ...m, positions: m.positions.slice(), indices: m.indices.slice() })), options });
    });
  }

  /**
   * The conversation format in the worker's core (core/CONVERSATION.md): op 'pack' with { json, blobs }
   * gives archive entries; 'unpack' with { entries } gives { json, blobs } or null.
   */
  conversation(op, payload) {
    return new Promise((resolve, reject) => {
      const id = `c${++this.renderId}`;
      this.renders.set(id, { resolve, reject });
      this.worker.postMessage({ type: `conversation-${op}`, id, ...payload });
    });
  }

  onMessage(msg) {
    if (msg.type === 'ready') return;
    if (msg.type === 'error' && this.renders.has(msg.id)) { // the core failed to load
      const r = this.renders.get(msg.id); this.renders.delete(msg.id);
      r.reject(new Error(msg.message));
      return;
    }
    if (msg.type === 'rendered' || msg.type === 'render-error' || msg.type === 'conversation' || msg.type === 'conversation-error') {
      const r = this.renders.get(msg.id); this.renders.delete(msg.id);
      if (!r) return;
      if (msg.type === 'rendered') r.resolve(msg.png);
      else if (msg.type === 'conversation') r.resolve(msg.result);
      else r.reject(new Error(msg.message));
      return;
    }
    if (msg.id !== this.current?.id) return; // stale message from a superseded run
    if (msg.type === 'log') { this.h.onLog?.(msg.text); return; }
    if (msg.type === 'warn') { this.h.onWarn?.(msg); return; }
    this.finish(msg);
  }

  finish(msg) {
    const report = this.h.onFinish(msg);
    this.current = null;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(report);
    if (this.pending) { this.pending = false; this.run(); }
  }
}
