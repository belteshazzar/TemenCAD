/**
 * A project: a set of named files (scripts, fonts, meshes, images) saved as a .temen zip.
 * Text files are kept as strings, binary files as ArrayBuffers. `main.js` is the entry script.
 * Pure module: used by the app, the worker and the command-line tool.
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

export const ENTRY = 'main.js';
export const PROJECT_EXT = '.temen';
const TEXT_EXT = ['.js', '.mjs', '.json', '.txt', '.md'];
export const FONT_EXT = ['.ttf', '.otf'];
export const MESH_EXT = ['.stl'];
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg'];
export const ACCEPTED_EXT = [...TEXT_EXT, ...FONT_EXT, ...MESH_EXT, ...IMAGE_EXT];

export const extOf = (name) => (name.match(/\.[^./]*$/)?.[0] ?? '').toLowerCase();
export const isTextFile = (name) => TEXT_EXT.includes(extOf(name));
export const isScript = (name) => ['.js', '.mjs'].includes(extOf(name));
export const isFontFile = (name) => FONT_EXT.includes(extOf(name));
export const isMeshFile = (name) => MESH_EXT.includes(extOf(name));
export const isImageFile = (name) => IMAGE_EXT.includes(extOf(name));

/** Normalise a project-relative path: forward slashes, no leading './' or '/', no '..' escaping the root. */
export function normalizePath(path) {
  const out = [];
  for (const seg of String(path).replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** Resolve an import specifier against the importing file's path. Bare names resolve from the project root. */
export function resolveImport(spec, fromFile) {
  if (/^(https?:|data:|blob:)/.test(spec)) return null;
  const base = spec.startsWith('.') ? fromFile.split('/').slice(0, -1).join('/') : '';
  return normalizePath(base ? `${base}/${spec}` : spec);
}

/**
 * Static import statements in a script: [{ spec, line, start, end }] where start/end delimit the
 * quoted specifier (quotes included) so it can be rewritten in place. Dynamic import() is not scanned.
 */
export function findImports(code) {
  const out = [];
  const re = /(^|[\s;{}])import\s*(?:(?:[\w$*{}\s,]+?)\s*from\s*)?(['"])([^'"\n]+)\2/g;
  let m;
  while ((m = re.exec(code))) {
    const start = m.index + m[0].lastIndexOf(m[2] + m[3] + m[2]);
    const line = code.slice(0, start).split('\n').length;
    out.push({ spec: m[3], line, start, end: start + m[3].length + 2 });
  }
  return out;
}

export class Project {
  constructor() {
    this.files = new Map(); // name -> string | ArrayBuffer
  }

  static fromScript(code) { const p = new Project(); p.set(ENTRY, code); return p; }

  names() { return [...this.files.keys()].sort((a, b) => (a === ENTRY ? -1 : b === ENTRY ? 1 : a.localeCompare(b))); }
  has(name) { return this.files.has(name); }
  get(name) { return this.files.get(name); }
  set(name, content) {
    const n = normalizePath(name);
    if (!n) throw new Error(`Invalid file name "${name}"`);
    if (isTextFile(n) && typeof content !== 'string') content = strFromU8(new Uint8Array(content));
    if (!isTextFile(n) && typeof content === 'string') content = strToU8(content).buffer;
    this.files.set(n, content);
    return n;
  }
  remove(name) { if (name === ENTRY) throw new Error(`${ENTRY} is the entry point and cannot be removed`); return this.files.delete(name); }
  rename(from, to) {
    if (from === ENTRY) throw new Error(`${ENTRY} is the entry point and cannot be renamed`);
    const n = normalizePath(to);
    if (!n) throw new Error(`Invalid file name "${to}"`);
    if (n !== from && this.files.has(n)) throw new Error(`A file named "${n}" already exists`);
    if (isTextFile(from) !== isTextFile(n)) throw new Error('Cannot change a file between text and binary by renaming');
    const content = this.files.get(from);
    this.files.delete(from);
    this.files.set(n, content);
    return n;
  }

  /** A unique name like "part.js", "part-2.js" for a new file. */
  uniqueName(name) {
    if (!this.files.has(name)) return name;
    const ext = extOf(name), stem = name.slice(0, name.length - ext.length);
    for (let i = 2; ; i++) if (!this.files.has(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
  }

  /** Plain object for postMessage / structured clone: { name: string | ArrayBuffer }. */
  toFiles() { return Object.fromEntries(this.files); }
  static fromFiles(files) { const p = new Project(); for (const [k, v] of Object.entries(files)) p.set(k, v); return p; }

  /** .temen archive bytes (a plain zip). */
  toZip() {
    const entries = {};
    for (const [name, content] of this.files) entries[name] = typeof content === 'string' ? strToU8(content) : new Uint8Array(content);
    return zipSync(entries, { level: 6 });
  }
  static fromZip(bytes) {
    const p = new Project();
    const entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.[^/]*$/.test(name)) continue; // folders, Finder junk, dotfiles
      const n = normalizePath(name);
      if (!n) continue;
      p.set(n, isTextFile(n) ? strFromU8(data) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (!p.has(ENTRY)) {
      const scripts = p.names().filter(isScript);
      if (scripts.length === 1) p.rename(scripts[0], ENTRY); // a single script is the entry whatever it is called
      else throw new Error(`The project has no ${ENTRY}`);
    }
    return p;
  }

  /** JSON-safe form for localStorage (binaries as base64). */
  toJSON() {
    const files = {};
    for (const [name, content] of this.files) files[name] = typeof content === 'string' ? { text: content } : { base64: toBase64(new Uint8Array(content)) };
    return { files };
  }
  static fromJSON(obj) {
    const p = new Project();
    for (const [name, v] of Object.entries(obj?.files ?? {})) p.set(name, v.text !== undefined ? v.text : fromBase64(v.base64));
    return p;
  }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
