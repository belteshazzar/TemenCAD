/**
 * Runs a user script against the CAD API and turns the result into mesh buffers.
 * Pure module (no bundler-specific imports) so it can be tested in Node.
 */
import { api, Shape } from './cad.js';
import { hooks } from './shape.js';
import { releaseAll } from './engine.js';

const PRELUDE = '"use strict";\n';

/** A script failure with the user-script line(s) it came from. */
export class ScriptError extends Error {
  constructor(message, trace) { super(message); this.name = 'ScriptError'; this.trace = trace; this.line = trace[0] ?? null; }
}

export function fmt(v) {
  if (v instanceof Shape) { const b = v.bounds(); return `Shape(${v.meta.name ? `"${v.meta.name}", ` : ''}size ${b.size.map((n) => +n.toFixed(3)).join('×')})`; }
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

/**
 * Find user-script lines in a stack trace. Engines report code inside
 * `new Function` differently (V8: "<anonymous>:L:C", Firefox: "Function:L:C",
 * Safari: "anonymous@...:L:C") and add a different number of header lines,
 * so we probe once and subtract that offset.
 */
function rawLines(stack = '') {
  const out = [];
  for (const frame of stack.split('\n')) {
    const m = frame.match(/(?:<anonymous>|\bFunction|\banonymous@?)[^\n]*?:(\d+):(\d+)\)?\s*$/) || frame.match(/(?:<anonymous>|\bFunction):(\d+)/);
    if (m) out.push(+m[1]);
  }
  return out; // innermost first
}
const LINE_OFFSET = (() => {
  try { new Function(PRELUDE + '\nthrow new Error("probe")')(); } // user line 2
  catch (e) { const l = rawLines(e.stack)[0] ?? (e.line ? e.line : null); if (l != null) return l - 2; }
  return null;
})();
/** All user-script lines on the stack, innermost first, deduplicated. */
export function userTrace(err) {
  if (LINE_OFFSET == null) return [];
  let lines = rawLines(err?.stack);
  if (!lines.length) {
    const l = typeof err?.line === 'number' ? err.line : typeof err?.lineNumber === 'number' ? err.lineNumber : null;
    if (l != null) lines = [l];
  }
  return [...new Set(lines.map((l) => Math.max(1, l - LINE_OFFSET)))];
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

/**
 * Execute `code`. `post(msg)` receives { type: 'log' | 'warn', ... } during the run.
 * Returns { meshes: [{ positions, indices, color }], tris, ms }.
 * Throws a ScriptError (message, line, trace) on failure. Always frees wasm objects afterwards.
 */
export function runScript(code, post) {
  const log = (...args) => post({ type: 'log', text: args.map(fmt).join(' ') });
  const warn = (text, trace = userTrace(new Error())) => post({ type: 'warn', text, line: trace[0] ?? null, trace });
  const origWarnHook = hooks.warn;
  hooks.warn = (msg) => warn(msg);
  const origWarn = console.warn, origError = console.error;
  console.warn = (...a) => { warn(a.map(fmt).join(' ')); origWarn(...a); };
  console.error = (...a) => { warn(a.map(fmt).join(' ')); origError(...a); };

  /** variable(label, value, min?, max?, step?) — declares a slider; at runtime it just returns the value. */
  const variable = (label, value, min, max, step) => {
    if (typeof label !== 'string') throw new TypeError(`variable: first argument must be a label string, got ${fmt(label)}`);
    if (typeof value !== 'number' && typeof value !== 'boolean') throw new TypeError(`variable "${label}": value must be a number or boolean, got ${fmt(value)}`);
    for (const [n, x] of [['min', min], ['max', max], ['step', step]]) if (x !== undefined && (typeof x !== 'number' || !Number.isFinite(x))) throw new TypeError(`variable "${label}": ${n} must be a number`);
    if (typeof value === 'number') {
      if (min !== undefined && value < min) warn(`variable "${label}": value ${value} is below its minimum ${min}.`);
      if (max !== undefined && value > max) warn(`variable "${label}": value ${value} is above its maximum ${max}.`);
    }
    return value;
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
  const sandbox = { ...api, show, log, print: log, variable };
  const names = Object.keys(sandbox);
  const t0 = performance.now();
  try {
    const fn = new Function(...names, PRELUDE + code);
    const result = fn(...names.map((n) => sandbox[n]));
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
      meshes.push({ positions, indices, color: s.colorValue, name, ghost: !!s.meta.ghost, hidden: !!s.meta.hidden, volume: s.volume() });
    });
    return { meshes, tris, ms: performance.now() - t0 };
  } catch (err) {
    throw new ScriptError(String(err), userTrace(err));
  } finally {
    console.warn = origWarn; console.error = origError;
    hooks.warn = origWarnHook;
    releaseAll();
  }
}
