/**
 * Runs a project against the CAD API and turns the result into mesh buffers.
 * Scripts are real ES modules (see modules.js); the entry's top-level code runs as the body of
 * an async function so `return` and `await` work. Pure module (no bundler-specific imports) so
 * the command-line tool can use it in Node.
 */
import { api, Shape, Sketch, polyhedronFromMesh } from './cad.js';
import { hooks } from './shape.js';
import { releaseAll } from './engine.js';
import { registerFont } from './fonts.js';
import { buildModules, ModuleError } from './modules.js';
import { isFontFile, isMeshFile, ENTRY } from './project.js';
import { parseSTL } from './stl.js';
import { GrayImage, decodePNG } from './image.js';
import { isImageFile } from './project.js';
import { locText } from './trace.js';

/** Thrown by a script's assert(); reported without the "Error:" class prefix. */
class AssertionError extends Error { constructor(message) { super(message); this.name = 'AssertionError'; } }

/** A script failure with the user-script location(s) it came from: trace = [{ file, line }], innermost first. */
export class ScriptError extends Error {
  constructor(message, trace) { super(message); this.name = 'ScriptError'; this.trace = trace; this.file = trace[0]?.file ?? null; this.line = trace[0]?.line ?? null; }
}

export function fmt(v) {
  if (v instanceof Shape) { const b = v.bounds(); return `Shape(${v.meta.name ? `"${v.meta.name}", ` : ''}size ${b.size.map((n) => +n.toFixed(3)).join('×')})`; }
  if (v instanceof Sketch) { const b = v.bounds(); return `Sketch(size ${b.size.map((n) => +n.toFixed(3)).join('×')})`; }
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

/**
 * OpenSCAD-style value formatting for echo(): strings quoted, arrays bracketed, objects as
 * `key = value` lists, shapes and sketches by name and size, numbers rounded to 6 decimals.
 */
export function fmtEcho(v, depth = 0) {
  if (v === null || v === undefined || typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'function') return `function ${v.name || '(anonymous)'}`;
  if (v instanceof Shape || v instanceof Sketch) return fmt(v);
  if (Array.isArray(v)) return `[${v.map((x) => fmtEcho(x, depth + 1)).join(', ')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v).map(([k, x]) => `${k} = ${fmtEcho(x, depth + 1)}`);
    return depth === 0 ? entries.join(', ') : `{ ${entries.join(', ')} }`;
  }
  return String(v);
}

/**
 * Map a stack trace to project files. Every frame that mentions one of this run's module URLs
 * followed by :line:column is translated through `locate(url)` -> { file, offset }.
 */
function traceFrom(stack = '', modules) {
  const out = [];
  const seen = new Set();
  for (const frame of stack.split('\n')) {
    for (const url of modules.urls) {
      const i = frame.indexOf(url);
      if (i < 0) continue;
      const m = frame.slice(i + url.length).match(/^:(\d+)(?::(\d+))?/);
      if (!m) continue;
      const { file, offset } = modules.locate(url);
      const line = Math.max(1, +m[1] - offset);
      const key = `${file}:${line}`;
      if (!seen.has(key)) { seen.add(key); out.push({ file, line }); }
      break;
    }
  }
  return out; // innermost first
}

/**
 * Flatten shapes / arrays / plain objects (keys become names) into a list of Shapes.
 * Non-shape values are rejected with a readable error.
 */
function collect(items, nameHint) {
  const out = [];
  for (const it of items) {
    if (it === undefined || it === null) continue;
    if (it instanceof Shape) out.push(nameHint && !it.meta.name ? it.name(nameHint) : it);
    else if (Array.isArray(it)) out.push(...collect(it, nameHint));
    else if (typeof it === 'object' && Object.getPrototypeOf(it) === Object.prototype) {
      for (const [k, v] of Object.entries(it)) out.push(...collect([v], k));
    } else throw new TypeError(`Returned value is not a Shape: ${fmt(it)}`);
  }
  return out;
}

/** Decode an image file to a GrayImage: PNG here, anything else through the host (`env.decodeImage`). */
async function decodeImage(bytes, name, env) {
  try {
    if (/\.png$/i.test(name)) { const { width, height, rgba } = decodePNG(bytes); return GrayImage.fromRGBA(width, height, rgba); }
    if (!env.decodeImage) throw new Error('only PNG images can be decoded here');
    const { width, height, rgba } = await env.decodeImage(bytes, name);
    return GrayImage.fromRGBA(width, height, rgba);
  } catch (err) {
    throw new Error(`Cannot read image ${name}: ${err.message}`);
  }
}

// Parsed fonts, meshes and images are cached across runs by name, size and a sparse checksum of the bytes.
const assetCache = new Map();
function checksum(buffer) {
  const b = new Uint8Array(buffer);
  let h = b.length;
  for (let i = 0; i < b.length; i += 997) h = (h * 31 + b[i]) >>> 0;
  return h;
}
function cached(name, buffer, parse) {
  const key = `${name}:${buffer.byteLength}:${checksum(buffer)}`;
  if (!assetCache.has(key)) assetCache.set(key, parse());
  return assetCache.get(key);
}

/**
 * Execute a project. `files` is { name: string | ArrayBuffer } with a main.js entry.
 * `post(msg)` receives { type: 'log' | 'warn', ... } during the run.
 * `env.makeUrl(source)` creates an importable module URL; `env.revokeUrl(url)` frees it afterwards.
 * Resolves to { meshes: [{ positions, indices, color, name, ghost, hidden, volume }], tris, ms, annotations }.
 * Rejects with a ScriptError (message, file, line, trace). Always frees wasm objects afterwards.
 */
export async function runScript(files, post, env) {
  let modules = { urls: [], locate: () => null };
  const trace = (err) => traceFrom(err?.stack, modules);
  const log = (...args) => post({ type: 'log', text: args.map(fmt).join(' ') });
  // The host may print a posted warning with console.warn/error itself, so don't relay those again.
  let posting = false;
  const warn = (text, t = trace(new Error())) => {
    posting = true;
    try { post({ type: 'warn', text, file: t[0]?.file ?? null, line: t[0]?.line ?? null, trace: t }); } finally { posting = false; }
  };
  const origWarnHook = hooks.warn, origAnnotate = hooks.annotate;
  hooks.warn = (msg) => warn(msg);
  const annotations = [];
  hooks.annotate = (a) => { annotations.push(a); };
  const origWarn = console.warn, origError = console.error;
  const relay = (orig) => (...a) => { if (!posting) warn(a.map(fmt).join(' ')); orig(...a); };
  console.warn = relay(origWarn);
  console.error = relay(origError);

  /** echo(...values) — OpenSCAD-style console output: ECHO: 1, "a", [1, 2], w = 10. Returns the first value, so it works inline. */
  const echo = (...args) => {
    const t = trace(new Error());
    post({ type: 'log', text: `ECHO${t[0] ? ` (${locText(t[0])})` : ''}: ${args.map((a) => fmtEcho(a)).join(', ')}` });
    return args[0];
  };
  /** assert(condition, message?) — stops the build with an error at the call site when the condition is falsy. Returns the condition. */
  const assert = (condition, message) => {
    if (!condition) throw new AssertionError(message === undefined ? 'Assertion failed' : `Assertion failed: ${typeof message === 'string' ? message : fmtEcho(message)}`);
    return condition;
  };
  const shown = [];
  /** show(shape | [shapes], { name, color, ghost, hidden }) */
  const show = (...args) => {
    const opts = args.length > 1 && args[args.length - 1] && typeof args[args.length - 1] === 'object' && !(args[args.length - 1] instanceof Shape) && !Array.isArray(args[args.length - 1]) ? args.pop() : null;
    for (let s of collect(args)) {
      if (opts) {
        if (opts.name !== undefined) s = s.name(opts.name);
        if (opts.color !== undefined) s = s.color(opts.color);
        if (opts.ghost !== undefined) s = s.ghost(opts.ghost);
        if (opts.hidden !== undefined) s = s.hide(opts.hidden);
      }
      shown.push(s);
    }
  };
  /** `import part from './part.stl'` evaluates to this: the mesh as a Shape, Z-up converted to Y-up. */
  const loadMesh = (name) => {
    const { positions, tris } = cached(name, files[name], () => parseSTL(files[name]));
    return polyhedronFromMesh(name, positions, tris);
  };
  /** `import photo from './photo.png'` evaluates to this: the image decoded before the run. */
  const images = new Map();
  const loadImage = (name) => images.get(name);
  const sandbox = { ...api, show, log, print: log, echo, assert };
  const t0 = performance.now();
  const prev = globalThis.__temen;
  globalThis.__temen = { api: sandbox, loadMesh, loadImage };
  try {
    for (const [name, content] of Object.entries(files)) {
      if (isFontFile(name)) cached(name, content, () => { registerFont(name, content); return true; });
      else if (isImageFile(name)) images.set(name, await cached(name, content, () => decodeImage(content, name, env)));
    }
    modules = buildModules(files, Object.keys(sandbox), env.makeUrl);
    const mod = await import(/* @vite-ignore */ modules.entryUrl);
    const result = await mod.default();
    const shapes = [...shown, ...collect(result === undefined ? [] : [result])];

    const meshes = [];
    const used = new Map();
    let tris = 0;
    shapes.forEach((s, i) => {
      let name = s.meta.name ?? `Part ${i + 1}`;
      const n = used.get(name) ?? 0; used.set(name, n + 1);
      if (n) name = `${name} (${n + 1})`;
      if (s.isEmpty()) { warn(`"${name}" is empty (no volume) and was skipped.`, []); return; }
      const { positions, indices } = s.toMesh();
      tris += indices.length / 3;
      meshes.push({ positions, indices, color: s.colorValue, name, named: s.meta.name !== undefined, ghost: !!s.meta.ghost, hidden: !!s.meta.hidden, volume: s.volume() });
    });
    return { meshes, tris, ms: performance.now() - t0, annotations };
  } catch (err) {
    if (err instanceof ModuleError) throw new ScriptError(err.message, err.file ? [{ file: err.file, line: err.line ?? 1 }] : []);
    const t = trace(err);
    if (!t.length && err instanceof SyntaxError && modules.urls.length) t.push({ file: ENTRY, line: null });
    throw new ScriptError(err instanceof AssertionError ? err.message : String(err), t);
  } finally {
    console.warn = origWarn; console.error = origError;
    hooks.warn = origWarnHook; hooks.annotate = origAnnotate;
    globalThis.__temen = prev;
    for (const url of modules.urls) env.revokeUrl?.(url);
    releaseAll();
  }
}
