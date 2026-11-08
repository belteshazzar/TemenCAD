// TemenCAD modelling API for the lamassu runtime.
//
// Runs inside the engine before the user's script, in the same JavaScript subset
// scripts are held to: no classes (Shape is a constructor function), no getters,
// no instanceof. Geometry goes through the __cad natives (natives.c) as numeric
// handles; everything else — argument checking, defaults, naming, echo formatting —
// is here, where it is cheap to write and shared by every host.
//
// Exports: `api` (every function a script may call; the host copies it onto the
// globals) and `run(main)` (calls the entry, collects the parts).

const cad = __cad;
const DEFAULT_COLOR = '#8fb3ff';

// ---- argument checks (shape.js) ----------------------------------------

function describe(v) {
  if (isShape(v)) return 'a Shape';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array [${v.slice(0, 4).map(describe).join(', ')}${v.length > 4 ? ', …' : ''}]`;
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'string') return `"${v}"`;
  return String(v);
}
function checkNumber(fn, name, v) {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new TypeError(`${fn}: ${name} must be a number, got ${describe(v)}`);
  return v;
}
function checkPositive(fn, name, v) {
  checkNumber(fn, name, v);
  if (v <= 0) throw new RangeError(`${fn}: ${name} must be greater than 0, got ${v}`);
  return v;
}
function checkNonNegative(fn, name, v) {
  checkNumber(fn, name, v);
  if (v < 0) throw new RangeError(`${fn}: ${name} must not be negative, got ${v}`);
  return v;
}
function checkInt(fn, name, v, min = 1) {
  checkNumber(fn, name, v);
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${fn}: ${name} must be an integer ≥ ${min}, got ${v}`);
  return v;
}
function checkVec(fn, name, v, n = 3) {
  if (!Array.isArray(v) || v.length !== n) throw new TypeError(`${fn}: ${name} must be an array of ${n} numbers, got ${describe(v)}`);
  for (let i = 0; i < v.length; i++) checkNumber(fn, `${name}[${i}]`, v[i]);
  return v;
}

// ---- Shape ----------------------------------------------------------------

function Shape(h, color, meta) {
  this.h = h;
  this.colorValue = color === undefined ? DEFAULT_COLOR : color;
  this.meta = meta === undefined ? {} : meta;
}
function isShape(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Shape.prototype; }
function wrap(s, h) { return new Shape(h, s.colorValue, s.meta); }
function withMeta(s, patch) { return new Shape(s.h, s.colorValue, Object.assign({}, s.meta, patch)); }

const P = Shape.prototype;
P.translate = function (x = 0, y = 0, z = 0) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; z = v[2] === undefined ? 0 : v[2]; }
  checkNumber('translate', 'x', x); checkNumber('translate', 'y', y); checkNumber('translate', 'z', z);
  return wrap(this, cad.translate(this.h, x, y, z));
};
P.rotate = function (x = 0, y = 0, z = 0) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; z = v[2] === undefined ? 0 : v[2]; }
  checkNumber('rotate', 'x', x); checkNumber('rotate', 'y', y); checkNumber('rotate', 'z', z);
  return wrap(this, cad.rotate(this.h, x, y, z));
};
P.scale = function (x = 1, y, z) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1]; z = v[2]; }
  if (y === undefined) { y = x; z = x; }
  checkNumber('scale', 'x', x); checkNumber('scale', 'y', y); checkNumber('scale', 'z', z);
  if (x === 0 || y === 0 || z === 0) throw new RangeError('scale: factors must not be 0');
  return wrap(this, cad.scale(this.h, x, y, z));
};
P.mirror = function (axis = 'x') {
  const n = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : axis === 'z' ? [0, 0, 1] : null;
  if (!n) throw new Error("mirror: axis must be 'x', 'y' or 'z'");
  return wrap(this, cad.mirror(this.h, n[0], n[1], n[2]));
};
P.add = function (...others) { return union(this, ...others); };
P.union = P.add;
P.subtract = function (...others) { return difference(this, ...others); };
P.intersect = function (...others) { return intersect(this, ...others); };
P.hull = function (...others) { return hull(this, ...others); };
P.volume = function () { return cad.volume(this.h); };
P.surfaceArea = function () { return cad.area(this.h); };
P.isEmpty = function () { return cad.isEmpty(this.h); };
P.numTriangles = function () { return cad.numTri(this.h); };
P.bounds = function () {
  const b = cad.bounds(this.h);
  const min = [b[0], b[1], b[2]], max = [b[3], b[4], b[5]];
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2];
  return { min, max, size, center };
};
P.align = function (spec = {}, to = [0, 0, 0]) {
  if (typeof spec !== 'object' || spec === null) throw new TypeError(`align: first argument must be like { x: 'min' | 'center' | 'max', y, z }, got ${describe(spec)}`);
  for (const k of Object.keys(spec)) {
    if (k !== 'x' && k !== 'y' && k !== 'z') throw new TypeError(`align: unknown axis "${k}" (use x, y, z)`);
    const v = spec[k];
    if (v !== 'min' && v !== 'center' && v !== 'max') throw new TypeError(`align: ${k} must be 'min', 'center' or 'max', got ${describe(v)}`);
  }
  checkVec('align', 'to', to);
  const b = this.bounds();
  const d = [0, 0, 0];
  const axes = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const mode = spec[axes[i]];
    if (!mode) continue;
    const from = mode === 'min' ? b.min[i] : mode === 'max' ? b.max[i] : b.center[i];
    d[i] = to[i] - from;
  }
  return this.translate(d[0], d[1], d[2]);
};
P.center = function () { return this.align({ x: 'center', y: 'center', z: 'center' }); };
P.centerXZ = function () { return this.align({ x: 'center', z: 'center' }); };
P.onPlate = function (y = 0) { return this.align({ y: 'min' }, [0, y, 0]); };
P.name = function (n) {
  if (typeof n !== 'string' || !n) throw new TypeError(`name: expected a non-empty string, got ${describe(n)}`);
  return withMeta(this, { name: n });
};
P.color = function (c) {
  if (typeof c !== 'string') throw new TypeError(`color: expected a '#rrggbb' string, got ${describe(c)}`);
  return new Shape(this.h, c, this.meta);
};
P.ghost = function (on = true) { return withMeta(this, { ghost: !!on }); };
P.hide = function (on = true) { return withMeta(this, { hidden: !!on }); };
P.toString = function () { return fmt(this); };

// ---- primitives (cad.js) ---------------------------------------------------

function box(w = 1, h, d) {
  let center = true;
  if (typeof w === 'object' && w !== null) {
    const o = w;
    center = o.center === undefined ? true : o.center;
    const size = o.size === undefined ? [1, 1, 1] : o.size;
    w = size[0]; h = size[1]; d = size[2];
  }
  if (h === undefined) h = w;
  if (d === undefined) d = w;
  checkPositive('box', 'width', w); checkPositive('box', 'height', h); checkPositive('box', 'depth', d);
  return new Shape(cad.cube(w, h, d, center ? 1 : 0));
}
const cube = box;

function sphere(r = 1, opts = {}) {
  let segments = opts.segments === undefined ? 32 : opts.segments;
  if (typeof r === 'object' && r !== null) { const o = r; r = o.r === undefined ? 1 : o.r; segments = o.segments === undefined ? 32 : o.segments; }
  checkPositive('sphere', 'radius', r); checkInt('sphere', 'segments', segments, 3);
  return new Shape(cad.sphere(r, segments));
}

function cylinder(r = 1, h = 1, opts = {}) {
  let r1 = r, r2 = r, segments = 32, center = true;
  if (typeof r === 'object' && r !== null) {
    const o = r;
    r = o.r === undefined ? 1 : o.r;
    r1 = o.r1 === undefined ? r : o.r1;
    r2 = o.r2 === undefined ? r : o.r2;
    h = o.h === undefined ? 1 : o.h;
    segments = o.segments === undefined ? 32 : o.segments;
    center = o.center === undefined ? true : o.center;
  } else {
    segments = opts.segments === undefined ? 32 : opts.segments;
    center = opts.center === undefined ? true : opts.center;
  }
  checkNonNegative('cylinder', 'r1', r1); checkNonNegative('cylinder', 'r2', r2); checkPositive('cylinder', 'height', h); checkInt('cylinder', 'segments', segments, 3);
  if (r1 === 0 && r2 === 0) throw new RangeError('cylinder: at least one radius must be greater than 0');
  const s = new Shape(cad.cylinder(h, r1, r2, segments, 1));
  return center ? s : s.translate(0, h / 2, 0);
}

function cone(r = 1, h = 1, opts = {}) {
  return cylinder(Object.assign({ r1: r, r2: 0, h }, opts));
}

// ---- booleans ------------------------------------------------------------------

function flattenShapes(fn, items) {
  const out = [];
  const visit = (it) => {
    if (isShape(it)) out.push(it);
    else if (Array.isArray(it)) { for (const x of it) visit(x); }
    else if (it !== undefined && it !== null) throw new TypeError(`${fn}: arguments must be Shapes, got ${describe(it)}`);
  };
  for (const it of items) visit(it);
  return out;
}

function union(...items) {
  const shapes = flattenShapes('union', items);
  if (!shapes.length) throw new TypeError('union: needs at least one Shape');
  if (shapes.length === 1) return shapes[0];
  const h = cad.batch(shapes.map((s) => s.h), 0);
  return new Shape(h, shapes[0].colorValue, shapes[0].meta);
}
function difference(first, ...rest) {
  if (Array.isArray(first)) { const all = flattenShapes('difference', [first]); first = all[0]; rest = all.slice(1).concat(rest); }
  if (!isShape(first)) throw new TypeError(`difference: first argument must be a Shape, got ${describe(first)}`);
  const cutters = flattenShapes('difference', rest);
  if (!cutters.length) return first;
  const cutter = cutters.length === 1 ? cutters[0].h : cad.batch(cutters.map((s) => s.h), 0);
  return wrap(first, cad.boolean(first.h, cutter, 1));
}
function intersect(...items) {
  const shapes = flattenShapes('intersect', items);
  if (!shapes.length) throw new TypeError('intersect: needs at least one Shape');
  let h = shapes[0].h;
  for (let i = 1; i < shapes.length; i++) h = cad.boolean(h, shapes[i].h, 2);
  return wrap(shapes[0], h);
}
function hull(...items) {
  const shapes = flattenShapes('hull', items);
  if (!shapes.length) throw new TypeError('hull: needs at least one Shape');
  return wrap(shapes[0], cad.hull(shapes.map((s) => s.h)));
}

// ---- helpers --------------------------------------------------------------------

const deg = (radians) => (radians * 180) / Math.PI;
const rad = (degrees) => (degrees * Math.PI) / 180;

function fmt(v) {
  if (isShape(v)) {
    const b = v.bounds();
    return `Shape(${v.meta.name ? `"${v.meta.name}", ` : ''}size ${b.size.map((n) => +n.toFixed(3)).join('×')})`;
  }
  if (typeof v === 'object' && v !== null) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  return String(v);
}
function fmtEcho(v, depth = 0) {
  if (v === null || v === undefined || typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'function') return `function ${v.name || '(anonymous)'}`;
  if (isShape(v)) return fmt(v);
  if (Array.isArray(v)) return `[${v.map((x) => fmtEcho(x, depth + 1)).join(', ')}]`;
  if (typeof v === 'object') {
    const entries = Object.keys(v).map((k) => `${k} = ${fmtEcho(v[k], depth + 1)}`);
    return depth === 0 ? entries.join(', ') : `{ ${entries.join(', ')} }`;
  }
  return String(v);
}

const log = (...args) => { cad.log(args.map(fmt).join(' ')); };
/** echo(...values): OpenSCAD-style output; returns the first value so it works inline. */
const echo = (...args) => { cad.log(`ECHO: ${args.map((a) => fmtEcho(a)).join(', ')}`); return args[0]; };
/** assert(condition, message?): stops the build when the condition is falsy. */
const assert = (condition, message) => {
  if (!condition) {
    const e = new Error(message === undefined ? 'Assertion failed' : `Assertion failed: ${typeof message === 'string' ? message : fmtEcho(message)}`);
    e.name = 'AssertionError';
    throw e;
  }
  return condition;
};

// ---- collecting parts -------------------------------------------------------------

const shown = [];
function collect(items, nameHint) {
  const out = [];
  for (const it of items) {
    if (it === undefined || it === null) continue;
    if (isShape(it)) out.push(nameHint && !it.meta.name ? it.name(nameHint) : it);
    else if (Array.isArray(it)) { for (const x of collect(it, nameHint)) out.push(x); }
    else if (typeof it === 'object' && Object.getPrototypeOf(it) === Object.prototype) {
      for (const k of Object.keys(it)) for (const x of collect([it[k]], k)) out.push(x);
    } else throw new TypeError(`Returned value is not a Shape: ${fmt(it)}`);
  }
  return out;
}
/** show(shape | [shapes], { name, color, ghost, hidden }) */
const show = (...args) => {
  const last = args[args.length - 1];
  const opts = args.length > 1 && last && typeof last === 'object' && !isShape(last) && !Array.isArray(last) ? args.pop() : null;
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

export async function run(main) {
  shown.length = 0;
  const result = await main();
  const shapes = collect(shown).concat(collect(result === undefined ? [] : [result]));
  const used = new Map();
  const parts = [];
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    let name = s.meta.name === undefined ? `Part ${i + 1}` : s.meta.name;
    const n = used.has(name) ? used.get(name) : 0;
    used.set(name, n + 1);
    if (n) name = `${name} (${n + 1})`;
    if (s.isEmpty()) { cad.warn(`"${name}" is empty (no volume) and was skipped.`); continue; }
    parts.push({ h: s.h, name, named: s.meta.name !== undefined, color: s.colorValue, ghost: !!s.meta.ghost, hidden: !!s.meta.hidden });
  }
  return parts;
}

export const api = {
  Shape, box, cube, sphere, cylinder, cone,
  union, difference, intersect, hull,
  deg, rad, log, print: log, echo, assert, show,
};
