/**
 * Keeping the conversation: across page reloads (IndexedDB) and inside saved .temen files
 * (under .assistant/). Everything heavy (images, PDFs, attachments, checkpoint file contents)
 * goes into a content-addressed blob store, so a checkpoint per reply costs only the files
 * that changed, and the JSON stays small.
 *
 * Archive layout:  .assistant/chat.json      the conversation (format below, v: 1)
 *                  .assistant/blobs/<key>    raw bytes, key = content hash
 */
import { strToU8, strFromU8 } from 'fflate';
import { APP_DATA_DIR } from './project.js';

export const ARCHIVE_DIR = APP_DATA_DIR;
const CHAT_JSON = `${ARCHIVE_DIR}chat.json`;
const BLOB_DIR = `${ARCHIVE_DIR}blobs/`;
const FORMAT = 1;

/** 64-bit FNV-1a over the bytes (two 32-bit halves), plus the length: a dedupe key, not a security hash. */
function hashBytes(bytes) {
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[i], 0x01000193) ^ (h1 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + '-' + bytes.length.toString(36);
}

export function base64ToBytes(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class BlobStore {
  constructor() {
    this.blobs = new Map();      // key -> Uint8Array
    this.textKeys = new Map();   // string -> key (checkpoint texts repeat across replies)
    this.objKeys = new WeakMap(); // ArrayBuffer / base64 source object -> key
    this.urls = new Map();       // key -> object URL
  }
  put(bytes) {
    const key = hashBytes(bytes);
    if (!this.blobs.has(key)) this.blobs.set(key, bytes);
    return key;
  }
  putText(s) {
    let key = this.textKeys.get(s);
    if (!key) { key = this.put(strToU8(s)); this.textKeys.set(s, key); }
    return key;
  }
  putBuffer(buf) {
    let key = this.objKeys.get(buf);
    if (!key) { key = this.put(new Uint8Array(buf)); this.objKeys.set(buf, key); }
    return key;
  }
  get(key) { return this.blobs.get(key); }
  text(key) { return strFromU8(this.blobs.get(key)); }
  buffer(key) { const b = this.blobs.get(key); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  url(key, type) {
    let u = this.urls.get(key);
    if (!u) { u = URL.createObjectURL(new Blob([this.blobs.get(key)], { type })); this.urls.set(key, u); }
    return u;
  }
  clear() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.blobs.clear(); this.textKeys.clear(); this.urls.clear(); this.objKeys = new WeakMap();
  }

  /** A project snapshot ({ generation, files: { name: string | ArrayBuffer } }) as keys. */
  packSnapshot(snap, currentGeneration) {
    const files = {};
    for (const [name, c] of Object.entries(snap.files)) files[name] = typeof c === 'string' ? { t: this.putText(c) } : { b: this.putBuffer(c) };
    return { current: snap.generation === currentGeneration, files };
  }
  unpackSnapshot(p, currentGeneration) {
    const files = {};
    for (const [name, r] of Object.entries(p.files)) {
      if (r.t) { const s = this.text(r.t); this.textKeys.set(s, r.t); files[name] = s; }
      else { const b = this.buffer(r.b); this.objKeys.set(b, r.b); files[name] = b; }
    }
    // checkpoints from before the assistant opened another project can't be restored into this one
    return { generation: p.current ? currentGeneration : -1, files };
  }

  /** API messages with every base64 image / document swapped for a blob key (and back). */
  packMessages(value) {
    if (Array.isArray(value)) return value.map((v) => this.packMessages(v));
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'base64' && typeof value.data === 'string') {
      let key = this.objKeys.get(value);
      if (!key) { key = this.put(base64ToBytes(value.data)); this.objKeys.set(value, key); }
      const { data, ...rest } = value;
      return { ...rest, $blob: key };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = this.packMessages(v);
    return out;
  }
  unpackMessages(value) {
    if (Array.isArray(value)) return value.map((v) => this.unpackMessages(v));
    if (!value || typeof value !== 'object') return value;
    if (value.$blob) {
      const { $blob, ...rest } = value;
      const src = { ...rest, data: bytesToBase64(this.get($blob)) };
      this.objKeys.set(src, $blob);
      return src;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = this.unpackMessages(v);
    return out;
  }
}

/** Keys referenced anywhere in a packed state (so only live blobs are written). */
function referencedKeys(json) {
  const keys = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === '$blob' || k === 'key' || k === 't' || k === 'b') && typeof x === 'string' && /^[0-9a-f]{16}-/.test(x)) keys.add(x);
      else walk(x);
    }
  };
  walk(json);
  return keys;
}

/** { json, blobs: Map } -> archive entries { path: Uint8Array } */
export function toArchive(state) {
  const out = { [CHAT_JSON]: strToU8(JSON.stringify({ v: FORMAT, ...state.json })) };
  for (const [k, b] of state.blobs) out[BLOB_DIR + k] = b;
  return out;
}
/** archive entries -> { json, blobs } or null when there is no conversation in the file */
export function fromArchive(extras) {
  const raw = extras?.[CHAT_JSON];
  if (!raw) return null;
  const json = JSON.parse(strFromU8(raw));
  if (json.v !== FORMAT) throw new Error(`The conversation in this file is format ${json.v}; this version of TemenCAD reads format ${FORMAT}`);
  const blobs = new Map();
  for (const [path, b] of Object.entries(extras)) if (path.startsWith(BLOB_DIR)) blobs.set(path.slice(BLOB_DIR.length), b);
  return { json, blobs };
}

/** Restrict a state's blobs to those its JSON references. */
export function pruneBlobs(json, store) {
  const blobs = new Map();
  for (const k of referencedKeys(json)) { const b = store.get(k); if (b) blobs.set(k, b); }
  return { json, blobs };
}

// ---- IndexedDB: the conversation survives a reload ----
const DB = 'temencad', OBJ = 'kv', KEY = 'chat';
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OBJ);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(OBJ, mode);
      const req = fn(t.objectStore(OBJ));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}
export const saveLocal = (state) => tx('readwrite', (s) => s.put({ json: state.json, blobs: [...state.blobs] }, KEY));
export const clearLocal = () => tx('readwrite', (s) => s.delete(KEY));
export async function loadLocal() {
  const v = await tx('readonly', (s) => s.get(KEY));
  return v ? { json: v.json, blobs: new Map(v.blobs) } : null;
}
