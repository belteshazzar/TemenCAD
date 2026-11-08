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
  if (isSketch(v)) return 'a 2D sketch';
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

function resizeFactors(fn, size, target, auto) {
  const n = size.length;
  if (!Array.isArray(target) || target.length !== n) throw new TypeError(`${fn}: size must be an array of ${n} numbers (0 keeps an axis unchanged), got ${describe(target)}`);
  for (let i = 0; i < target.length; i++) checkNonNegative(fn, `size[${i}]`, target[i]);
  const specified = target.map((t, i) => (t > 0 ? t / size[i] : null));
  if (specified.every((f) => f === null)) throw new RangeError(`${fn}: at least one size must be greater than 0`);
  if (specified.some((f) => f !== null && !Number.isFinite(f))) throw new RangeError(`${fn}: the shape has zero extent on an axis being resized`);
  const autoFactor = specified.find((f) => f !== null);
  return specified.map((f) => (f === null ? (auto ? autoFactor : 1) : f));
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
P.resize = function (x, y = 0, z = 0, opts = {}) {
  if (Array.isArray(x)) { opts = y && typeof y === 'object' ? y : {}; const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; z = v[2] === undefined ? 0 : v[2]; }
  const f = resizeFactors('resize', this.bounds().size, [x, y, z], !!opts.auto);
  return this.scale(f[0], f[1], f[2]);
};
P.projection = function (opts) { return projection(this, opts); };
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

function allSketches(items) {
  const flat = [];
  const visit = (it) => { if (Array.isArray(it)) { for (const x of it) visit(x); } else flat.push(it); };
  visit(items);
  return flat.length > 0 && flat.every(isSketch);
}

function union(...items) {
  if (allSketches(items)) return union2d(...items);
  const shapes = flattenShapes('union', items);
  if (!shapes.length) throw new TypeError('union: needs at least one Shape');
  if (shapes.length === 1) return shapes[0];
  const h = cad.batch(shapes.map((s) => s.h), 0);
  return new Shape(h, shapes[0].colorValue, shapes[0].meta);
}
function difference(first, ...rest) {
  if (allSketches([first, rest])) return difference2d(first, ...rest);
  if (Array.isArray(first)) { const all = flattenShapes('difference', [first]); first = all[0]; rest = all.slice(1).concat(rest); }
  if (!isShape(first)) throw new TypeError(`difference: first argument must be a Shape, got ${describe(first)}`);
  const cutters = flattenShapes('difference', rest);
  if (!cutters.length) return first;
  const cutter = cutters.length === 1 ? cutters[0].h : cad.batch(cutters.map((s) => s.h), 0);
  return wrap(first, cad.boolean(first.h, cutter, 1));
}
function intersect(...items) {
  if (allSketches(items)) return intersect2d(...items);
  const shapes = flattenShapes('intersect', items);
  if (!shapes.length) throw new TypeError('intersect: needs at least one Shape');
  let h = shapes[0].h;
  for (let i = 1; i < shapes.length; i++) h = cad.boolean(h, shapes[i].h, 2);
  return wrap(shapes[0], h);
}
/** Convex hull of any number of shapes (or raw [x, y, z] points, or arrays of either). 2D sketches hull in 2D. */
function hull(...items) {
  if (allSketches(items)) return hull2d(...items);
  const handles = [], pts = [];
  let color;
  const visit = (it) => {
    if (isShape(it)) { if (color === undefined) color = it.colorValue; handles.push(it.h); }
    else if (Array.isArray(it) && it.length === 3 && typeof it[0] === 'number') { checkVec('hull', 'point', it); pts.push(it[0], it[1], it[2]); }
    else if (Array.isArray(it)) { for (const x of it) visit(x); }
    else throw new TypeError(`hull: arguments must be Shapes or [x,y,z] points, got ${describe(it)}`);
  };
  for (const it of items) visit(it);
  if (!handles.length && !pts.length) throw new TypeError('hull: needs at least one Shape or point');
  const h = pts.length ? cad.hullPoints(handles, pts) : cad.hull(handles);
  return new Shape(h, color);
}

// ---- 2D sketches (sketch.js) --------------------------------------------------------
//
// Sketches live on the ground plane: sketch x is world X, sketch y is world -Z, so a sketch
// seen from above (+Y) reads like a drawing. Extrusions go up +Y; revolves spin around Y.

const JOIN = { square: 0, round: 1, miter: 2 };
const FILL = { evenOdd: 0, nonZero: 1, positive: 2 };

function checkPoints(points, fn) {
  if (!Array.isArray(points) || points.length < 3) throw new TypeError(`${fn}: need an array of at least 3 [x, y] points, got ${describe(points)}`);
  return points.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) throw new TypeError(`${fn}: point ${i} must be [x, y], got ${describe(p)}`);
    return [checkNumber(fn, `point ${i} x`, p[0]), checkNumber(fn, `point ${i} y`, p[1])];
  });
}

/** A 2D region (multi-polygon with holes). Immutable; every op returns a new Sketch. */
function Sketch(h) { this.h = h; }
function isSketch(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Sketch.prototype; }
function sketchFromRings(rings, fill) { return new Sketch(cad.csPolygons(rings, fill === undefined ? FILL.evenOdd : fill)); }
function sketchFromPoints(points, fn) { return sketchFromRings([checkPoints(points, fn === undefined ? 'polygon2d' : fn)], FILL.evenOdd); }

const Q = Sketch.prototype;
Q.translate = function (x = 0, y = 0) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; }
  checkNumber('translate', 'x', x); checkNumber('translate', 'y', y);
  return new Sketch(cad.csTranslate(this.h, x, y));
};
Q.rotate = function (degrees = 0) { checkNumber('rotate', 'degrees', degrees); return new Sketch(cad.csRotate(this.h, degrees)); };
Q.scale = function (x = 1, y) {
  if (y === undefined) y = x;
  checkNumber('scale', 'x', x); checkNumber('scale', 'y', y);
  if (x === 0 || y === 0) throw new RangeError('scale: factors must not be 0');
  return new Sketch(cad.csScale(this.h, x, y));
};
Q.resize = function (x, y = 0, opts = {}) {
  if (Array.isArray(x)) { opts = y && typeof y === 'object' ? y : {}; const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; }
  const f = resizeFactors('resize', this.bounds().size, [x, y], !!opts.auto);
  return this.scale(f[0], f[1]);
};
Q.mirror = function (axis = 'x') {
  const n = axis === 'x' ? [1, 0] : axis === 'y' ? [0, 1] : null;
  if (!n) throw new Error("mirror: axis must be 'x' or 'y'");
  return new Sketch(cad.csMirror(this.h, n[0], n[1]));
};
Q.add = function (...o) { return union2d(this, ...o); };
Q.union = Q.add;
Q.subtract = function (...o) { return difference2d(this, ...o); };
Q.intersect = function (...o) { return intersect2d(this, ...o); };
Q.hull = function (...o) { return hull2d(this, ...o); };
/** Grow (positive) or shrink (negative) the region by delta. opts: { join: 'round' | 'miter' | 'square', segments } */
Q.offset = function (delta = 1, opts = {}) {
  const join = opts.join === undefined ? 'round' : opts.join;
  const segments = opts.segments === undefined ? 16 : opts.segments;
  checkNumber('offset', 'delta', delta);
  const j = JOIN[join];
  if (j === undefined) throw new TypeError(`offset: join must be 'round', 'miter' or 'square', got ${describe(join)}`);
  return new Sketch(cad.csOffset(this.h, delta, j, 2, segments));
};
/** Round every corner with radius r (clamped so adjacent corners never overlap). */
Q.fillet = function (r = 1, opts = {}) {
  const segments = opts.segments === undefined ? 8 : opts.segments;
  checkPositive('fillet', 'radius', r); checkInt('fillet', 'segments', segments, 1);
  return sketchFromRings(this.toPolygons().map((ring) => processCorners(ring, r, segments)), FILL.positive);
};
/** Cut every corner back by distance d along both edges. */
Q.chamfer = function (d = 1) {
  checkPositive('chamfer', 'distance', d);
  return sketchFromRings(this.toPolygons().map((ring) => processCorners(ring, d, 0)), FILL.positive);
};
Q.bounds = function () {
  const b = cad.csBounds(this.h);
  const min = [b[0], b[1]], max = [b[2], b[3]];
  return { min, max, size: [max[0] - min[0], max[1] - min[1]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] };
};
Q.center = function () { const c = this.bounds().center; return this.translate(-c[0], -c[1]); };
Q.area = function () { return cad.csArea(this.h); };
Q.isEmpty = function () { return cad.csIsEmpty(this.h); };
/** Outline(s) as arrays of [x, y]. */
Q.toPolygons = function () { return cad.csToPolygons(this.h); };
Q.extrude = function (h, opts) { return extrude(this, h, opts); };
Q.revolve = function (opts) { return revolve(this, opts); };
Q.toString = function () { return fmt(this); };

function sketches(fn, list) {
  const out = [];
  const visit = (it) => {
    if (Array.isArray(it)) { for (const x of it) visit(x); return; }
    if (!isSketch(it)) throw new TypeError(`${fn}: arguments must be 2D sketches, got ${describe(it)}`);
    out.push(it.h);
  };
  visit(list);
  if (!out.length) throw new TypeError(`${fn}: needs at least one sketch`);
  return out;
}
function union2d(...s) { return new Sketch(cad.csBatch(sketches('union', s), 0)); }
function difference2d(...s) { return new Sketch(cad.csBatch(sketches('difference', s), 1)); }
function intersect2d(...s) { return new Sketch(cad.csBatch(sketches('intersect', s), 2)); }
function hull2d(...s) { return new Sketch(cad.csHull(sketches('hull', s))); }

/** Replace each corner of a ring with a chamfer (segments = 0) or an arc; amount is the leg length or the radius. */
function processCorners(ring, amount, segments) {
  const n = ring.length;
  if (n < 3) return ring;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i + n - 1) % n], p1 = ring[i], p2 = ring[(i + 1) % n];
    const e1 = [p0[0] - p1[0], p0[1] - p1[1]], e2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
    if (l1 < 1e-12 || l2 < 1e-12) { out.push(p1); continue; }
    const u1 = [e1[0] / l1, e1[1] / l1], u2 = [e2[0] / l2, e2[1] / l2];
    const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const theta = Math.acos(cos);
    if (theta > Math.PI - 1e-6 || theta < 1e-6) { out.push(p1); continue; }
    const tmax = Math.min(l1, l2) / 2 - 1e-9;
    if (segments === 0) {
      const t = Math.min(amount, tmax);
      out.push([p1[0] + u1[0] * t, p1[1] + u1[1] * t], [p1[0] + u2[0] * t, p1[1] + u2[1] * t]);
      continue;
    }
    let t = amount / Math.tan(theta / 2), r = amount;
    if (t > tmax) { t = tmax; r = t * Math.tan(theta / 2); }
    const A = [p1[0] + u1[0] * t, p1[1] + u1[1] * t], B = [p1[0] + u2[0] * t, p1[1] + u2[1] * t];
    const bl = Math.hypot(u1[0] + u2[0], u1[1] + u2[1]);
    const bis = [(u1[0] + u2[0]) / bl, (u1[1] + u2[1]) / bl];
    const dist = r / Math.sin(theta / 2);
    const C = [p1[0] + bis[0] * dist, p1[1] + bis[1] * dist];
    const a0 = Math.atan2(A[1] - C[1], A[0] - C[0]);
    let sweep = Math.atan2(B[1] - C[1], B[0] - C[0]) - a0;
    if (sweep > Math.PI) sweep -= 2 * Math.PI;
    if (sweep < -Math.PI) sweep += 2 * Math.PI;
    for (let k = 0; k <= segments; k++) {
      const a = a0 + (sweep * k) / segments;
      out.push([C[0] + Math.cos(a) * r, C[1] + Math.sin(a) * r]);
    }
  }
  return out;
}

// ---- 2D primitives

function circle(r = 1, opts = {}) {
  let segments = opts.segments === undefined ? 48 : opts.segments;
  if (typeof r === 'object' && r !== null) { const o = r; r = o.r === undefined ? 1 : o.r; segments = o.segments === undefined ? 48 : o.segments; }
  checkPositive('circle', 'radius', r); checkInt('circle', 'segments', segments, 3);
  return new Sketch(cad.csCircle(r, segments));
}
function ellipse(rx = 1, ry = 0.5, opts = {}) {
  const segments = opts.segments === undefined ? 48 : opts.segments;
  checkPositive('ellipse', 'rx', rx); checkPositive('ellipse', 'ry', ry);
  return circle(1, { segments }).scale(rx, ry);
}
function rect(w = 1, h, opts = {}) {
  if (h === undefined) h = w;
  const center = opts.center === undefined ? true : opts.center;
  checkPositive('rect', 'width', w); checkPositive('rect', 'height', h);
  return new Sketch(cad.csSquare(w, h, center ? 1 : 0));
}
const square = rect;
function roundedRect(w = 1, h, r = 0.1, opts = {}) {
  if (h === undefined) h = w;
  const center = opts.center === undefined ? true : opts.center;
  const segments = opts.segments === undefined ? 8 : opts.segments;
  checkPositive('roundedRect', 'width', w); checkPositive('roundedRect', 'height', h); checkNonNegative('roundedRect', 'radius', r);
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return rect(w, h, { center });
  const pts = [];
  const corners = [[w - r, h - r, 0], [r, h - r, 90], [r, r, 180], [w - r, r, 270]];
  for (const c of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = ((c[2] + (i / segments) * 90) * Math.PI) / 180;
      pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
    }
  }
  const s = sketchFromPoints(pts, 'roundedRect');
  return center ? s.translate(-w / 2, -h / 2) : s;
}
/** Regular polygon with `sides`, circumradius r (first vertex on +x). */
function regularPolygon(sides = 6, r = 1) {
  checkInt('regularPolygon', 'sides', sides, 3); checkPositive('regularPolygon', 'radius', r);
  const pts = [];
  for (let i = 0; i < sides; i++) { const a = (i / sides) * Math.PI * 2; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return sketchFromPoints(pts, 'regularPolygon');
}
/** Arbitrary polygon from [[x, y], ...]. Pass { holes: [[...], ...] } for holes. */
function polygon2d(points, opts = {}) {
  const holes = opts.holes === undefined ? [] : opts.holes;
  const rings = [checkPoints(points, 'polygon2d')].concat(holes.map((h, i) => checkPoints(h, `polygon2d hole ${i}`)));
  return sketchFromRings(rings, FILL.evenOdd);
}
/** Teardrop: a circle with a point at +y so a horizontal hole prints without sagging. */
function teardrop(r = 1, opts = {}) {
  const angle = opts.angle === undefined ? 45 : opts.angle;
  const flat = opts.flat;
  const segments = opts.segments === undefined ? 48 : opts.segments;
  checkPositive('teardrop', 'radius', r); checkNumber('teardrop', 'angle', angle); checkInt('teardrop', 'segments', segments, 8);
  if (angle <= 0 || angle >= 90) throw new RangeError('teardrop: angle must be between 0 and 90 degrees');
  const a = (angle * Math.PI) / 180, apex = r / Math.cos(a);
  const pts = [];
  const from = Math.PI / 2 + a, to = Math.PI / 2 - a + 2 * Math.PI;
  const n = Math.max(4, Math.round((segments * (to - from)) / (2 * Math.PI)));
  for (let i = 0; i <= n; i++) { const t = from + ((to - from) * i) / n; pts.push([r * Math.cos(t), r * Math.sin(t)]); }
  if (flat !== undefined && flat < apex) {
    checkPositive('teardrop', 'flat', flat);
    const h = Math.max(flat, r * Math.sin(Math.PI / 2 - a) + 1e-6), x = (apex - h) * Math.tan(a);
    pts.push([x, h], [-x, h]);
  } else pts.push([0, apex]);
  return sketchFromPoints(pts, 'teardrop');
}
/** Circle with a flat top for bridging. */
function bridgedCircle(r = 1, opts = {}) {
  const angle = opts.angle === undefined ? 45 : opts.angle;
  const segments = opts.segments === undefined ? 48 : opts.segments;
  checkPositive('bridgedCircle', 'radius', r); checkNumber('bridgedCircle', 'angle', angle); checkInt('bridgedCircle', 'segments', segments, 8);
  if (angle <= 0 || angle >= 90) throw new RangeError('bridgedCircle: angle must be between 0 and 90 degrees');
  const a = (angle * Math.PI) / 180;
  const half = r * Math.sin(a), y = r * Math.cos(a);
  return circle(r, { segments }).add(rect(2 * half, r - y + 1e-3, { center: false }).translate(-half, y));
}
/** Capsule / slot: two semicircles `length` apart (centre to centre) with radius r. */
function slot(length = 2, r = 0.5, opts = {}) {
  const segments = opts.segments === undefined ? 32 : opts.segments;
  checkNonNegative('slot', 'length', length); checkPositive('slot', 'radius', r);
  if (length === 0) return circle(r, { segments });
  return hull2d(circle(r, { segments }).translate(-length / 2, 0), circle(r, { segments }).translate(length / 2, 0));
}

// ---- 3D <-> 2D

/** Flatten a solid onto the ground plane: its footprint, or with { cut: y } the section at that height. */
function projection(shape, opts = {}) {
  const cut = opts.cut === undefined ? false : opts.cut;
  if (!isShape(shape)) throw new TypeError(`projection: first argument must be a Shape, got ${describe(shape)}`);
  if (cut === false) return new Sketch(cad.project(shape.h));
  const y = cut === true ? 0 : checkNumber('projection', 'cut', cut);
  return new Sketch(cad.slice(shape.h, y));
}
/** Extrude a sketch along +Y. opts: { center=false, twist=0, scale=1 | [sx, sy], slices } */
function extrude(sk, h = 1, opts = {}) {
  const center = opts.center === undefined ? false : opts.center;
  const twist = opts.twist === undefined ? 0 : opts.twist;
  const scale = opts.scale === undefined ? 1 : opts.scale;
  let slices = opts.slices;
  if (!isSketch(sk)) throw new TypeError(`extrude: first argument must be a 2D sketch (circle, rect, …), got ${describe(sk)}`);
  checkPositive('extrude', 'height', h); checkNumber('extrude', 'twist', twist);
  const top = Array.isArray(scale) ? scale : [scale, scale];
  if (slices === undefined) slices = twist ? Math.max(1, Math.ceil(Math.abs(twist) / 5)) : 0;
  const s = new Shape(cad.extrude(sk.h, h, slices, twist, top[0], top[1]));
  return center ? s.translate(0, -h / 2, 0) : s;
}
/** Revolve a sketch around the Y axis; sketch x is the radius (>= 0), sketch y is height. opts: { angle=360, segments=64 } */
function revolve(sk, opts = {}) {
  const angle = opts.angle === undefined ? 360 : opts.angle;
  const segments = opts.segments === undefined ? 64 : opts.segments;
  if (!isSketch(sk)) throw new TypeError(`revolve: first argument must be a 2D sketch (circle, rect, …), got ${describe(sk)}`);
  checkNumber('revolve', 'angle', angle); checkInt('revolve', 'segments', segments, 3);
  if (angle === 0) throw new RangeError('revolve: angle must not be 0');
  if (sk.bounds().min[0] < -1e-9) throw new RangeError('revolve: sketch must lie at x >= 0 (x is the radius)');
  return new Shape(cad.revolve(sk.h, segments, angle));
}

// ---- solids built from sketches (cad.js)

function torus(r = 1, tube = 0.3, opts = {}) {
  const segments = opts.segments === undefined ? 48 : opts.segments;
  const tubeSegments = opts.tubeSegments === undefined ? 24 : opts.tubeSegments;
  checkPositive('torus', 'radius', r); checkPositive('torus', 'tube', tube);
  return revolve(circle(tube, { segments: tubeSegments }).translate(r, 0), { segments });
}
/** Extrude a 2D polygon (array of [x, y]) up along Y by h. */
function polygon(points, h = 1, opts = {}) { return extrude(polygon2d(points), h, opts); }
/** Regular n-sided prism with circumradius r and height h, centred. */
function prism(sides = 6, r = 1, h = 1, opts = {}) {
  const center = opts.center === undefined ? true : opts.center;
  checkInt('prism', 'sides', sides, 3); checkPositive('prism', 'radius', r); checkPositive('prism', 'height', h);
  return extrude(regularPolygon(sides, r), h, { center });
}
/** Box with rounded edges. opts: { edges: 'all' | 'vertical', segments, center } */
function roundedBox(w = 1, h, d, r = 0.1, opts = {}) {
  let edges = opts.edges === undefined ? 'all' : opts.edges;
  let segments = opts.segments;
  let center = opts.center === undefined ? true : opts.center;
  if (typeof w === 'object' && w !== null) {
    const o = w;
    const size = o.size === undefined ? [1, 1, 1] : o.size;
    w = size[0]; h = size[1]; d = size[2];
    r = o.r !== undefined ? o.r : o.radius !== undefined ? o.radius : 0.1;
    edges = o.edges === undefined ? 'all' : o.edges;
    segments = o.segments;
    center = o.center === undefined ? true : o.center;
  }
  if (h === undefined) h = w;
  if (d === undefined) d = w;
  checkPositive('roundedBox', 'width', w); checkPositive('roundedBox', 'height', h); checkPositive('roundedBox', 'depth', d);
  checkNonNegative('roundedBox', 'radius', r);
  if (edges !== 'all' && edges !== 'vertical') throw new TypeError(`roundedBox: edges must be 'all' or 'vertical', got ${describe(edges)}`);
  r = Math.min(r, w / 2, h / 2, d / 2);
  let s;
  if (r <= 0) s = box(w, h, d);
  else if (edges === 'vertical') s = extrude(roundedRect(w, d, r, { segments: segments === undefined ? 8 : segments }), h, { center: true });
  else {
    const seg = segments === undefined ? 24 : segments;
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      corners.push(sphere(r, { segments: seg }).translate(sx * (w / 2 - r), sy * (h / 2 - r), sz * (d / 2 - r)));
    }
    s = hull(corners);
  }
  return center ? s : s.translate(w / 2, h / 2, d / 2);
}
/** resize(shape, [w, h, d], { auto }): scale a shape or sketch to a target bounding-box size. */
function resize(shape, size, opts) {
  if (!isShape(shape) && !isSketch(shape)) throw new TypeError(`resize: first argument must be a Shape or sketch, got ${describe(shape)}`);
  return shape.resize(size, opts);
}

// ---- the pen (sketch-path.js) ---------------------------------------------------------

const EPS = 1e-9;

function SketchBuilder(points) {
  this.pts = []; this.radii = []; this.lastDir = null;
  if (points) for (const p of points) this.lineTo(p[0], p[1]);
}
const B = SketchBuilder.prototype;
B.current = function () { return this.pts.length ? this.pts[this.pts.length - 1] : null; };
B._push = function (x, y) {
  const c = this.current();
  if (c && Math.hypot(x - c[0], y - c[1]) < EPS) return this;
  if (c) this.lastDir = [x - c[0], y - c[1]];
  this.pts.push([x, y]); this.radii.push(0);
  return this;
};
B.moveTo = function (x, y) {
  checkNumber('moveTo', 'x', x); checkNumber('moveTo', 'y', y);
  if (this.pts.length > 1) throw new Error('moveTo: the outline has started; a sketch is one closed outline');
  this.pts = [[x, y]]; this.radii = [0]; this.lastDir = null;
  return this;
};
B.lineTo = function (x, y) { checkNumber('lineTo', 'x', x); checkNumber('lineTo', 'y', y); return this._push(x, y); };
B.line = function (dx, dy = 0) { checkNumber('line', 'dx', dx); checkNumber('line', 'dy', dy); const c = this.current() || [0, 0]; return this._push(c[0] + dx, c[1] + dy); };
B.horizontal = function (dx) { return this.line(dx, 0); };
B.vertical = function (dy) { return this.line(0, dy); };
B.arcTo = function (x, y, opts = {}) {
  const r = opts.r, side = opts.side === undefined ? 'left' : opts.side, large = !!opts.large, segments = opts.segments === undefined ? 48 : opts.segments;
  checkNumber('arcTo', 'x', x); checkNumber('arcTo', 'y', y); checkPositive('arcTo', 'r', r); checkInt('arcTo', 'segments', segments, 8);
  const c = this.current(); if (!c) throw new Error('arcTo: moveTo first');
  const dx = x - c[0], dy = y - c[1], d = Math.hypot(dx, dy);
  if (d < EPS) return this;
  if (r < d / 2 - 1e-9) throw new RangeError(`arcTo: radius ${r} is too small for a chord of ${d.toFixed(3)} (needs at least ${(d / 2).toFixed(3)})`);
  const hh = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
  const left = [-dy / d, dx / d];
  const ccw = side === 'left';
  if (side !== 'left' && side !== 'right') throw new TypeError(`arcTo: side must be 'left' or 'right', got ${describe(side)}`);
  const sgn = (ccw ? 1 : -1) * (large ? -1 : 1);
  const cx = c[0] + dx / 2 + left[0] * hh * sgn, cy = c[1] + dy / 2 + left[1] * hh * sgn;
  return this._arc(cx, cy, r, Math.atan2(c[1] - cy, c[0] - cx), Math.atan2(y - cy, x - cx), ccw, segments);
};
B.tangentArcTo = function (x, y, opts = {}) {
  const segments = opts.segments === undefined ? 48 : opts.segments;
  checkNumber('tangentArcTo', 'x', x); checkNumber('tangentArcTo', 'y', y);
  const c = this.current(); if (!c || !this.lastDir) throw new Error('tangentArcTo: draw a segment first, so there is a direction to be tangent to');
  const tx = this.lastDir[0], ty = this.lastDir[1], tl = Math.hypot(tx, ty), n = [-ty / tl, tx / tl];
  const ex = x - c[0], ey = y - c[1];
  const dn = ex * n[0] + ey * n[1];
  if (Math.abs(dn) < 1e-9) return this._push(x, y);
  const t = (ex * ex + ey * ey) / (2 * dn);
  const cx = c[0] + n[0] * t, cy = c[1] + n[1] * t, r = Math.abs(t);
  return this._arc(cx, cy, r, Math.atan2(c[1] - cy, c[0] - cx), Math.atan2(y - cy, x - cx), t > 0, segments);
};
B._arc = function (cx, cy, r, a0, a1, ccw, segments) {
  let sweep = a1 - a0;
  if (ccw) { while (sweep <= 1e-12) sweep += 2 * Math.PI; } else { while (sweep >= -1e-12) sweep -= 2 * Math.PI; }
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * segments));
  for (let i = 1; i <= n; i++) { const a = a0 + (sweep * i) / n; this._push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  return this;
};
B.fillet = function (r) {
  checkPositive('fillet', 'r', r);
  if (!this.pts.length) throw new Error('fillet: nothing drawn yet');
  this.radii[this.pts.length - 1] = r;
  return this;
};
B.points = function () { return this.pts.map((p) => [p[0], p[1]]); };
B.close = function (opts = {}) {
  const mirror = opts.mirror, segments = opts.segments === undefined ? 8 : opts.segments;
  let pts = this.pts.map((p) => [p[0], p[1]]), radii = this.radii.slice();
  if (mirror) {
    const i = mirror === 'x' ? 1 : mirror === 'y' ? 0 : null;
    if (i === null) throw new TypeError(`close: mirror must be 'x' or 'y', got ${describe(mirror)}`);
    const back = [], backR = [];
    for (let k = pts.length - 1; k >= 0; k--) {
      const q = [pts[k][0], pts[k][1]]; q[i] = -q[i];
      if (Math.abs(pts[k][i]) < EPS) continue;
      back.push(q); backR.push(radii[k]);
    }
    pts = pts.concat(back); radii = radii.concat(backR);
  }
  if (pts.length < 3) throw new Error('close: an outline needs at least 3 points');
  return polygon2d(roundCorners(pts, radii, segments));
};

function roundCorners(pts, radii, segments) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const r = radii[i];
    const p = pts[i];
    if (!r) { out.push(p); continue; }
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const u1 = [a[0] - p[0], a[1] - p[1]], u2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(u1[0], u1[1]), l2 = Math.hypot(u2[0], u2[1]);
    if (l1 < EPS || l2 < EPS) { out.push(p); continue; }
    u1[0] /= l1; u1[1] /= l1; u2[0] /= l2; u2[1] /= l2;
    const cosA = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const half = Math.acos(cosA) / 2;
    if (half < 1e-6 || Math.abs(half - Math.PI / 2) < 1e-6) { out.push(p); continue; }
    let t = r / Math.tan(half);
    const tmax = Math.min(l1, l2) * 0.999;
    let rr = r;
    if (t > tmax) { t = tmax; rr = t * Math.tan(half); }
    const t1 = [p[0] + u1[0] * t, p[1] + u1[1] * t], t2 = [p[0] + u2[0] * t, p[1] + u2[1] * t];
    const bis = [u1[0] + u2[0], u1[1] + u2[1]], bl = Math.hypot(bis[0], bis[1]);
    const c = [p[0] + (bis[0] / bl) * (rr / Math.sin(half)), p[1] + (bis[1] / bl) * (rr / Math.sin(half))];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]), a1 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let sweep = a1 - a0; while (sweep > Math.PI) sweep -= 2 * Math.PI; while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * segments));
    for (let k = 0; k <= steps; k++) { const ang = a0 + (sweep * k) / steps; out.push([c[0] + rr * Math.cos(ang), c[1] + rr * Math.sin(ang)]); }
  }
  return out;
}
/** Start a profile: sketch() for a pen at the origin, or sketch([[x, y], ...]) with a polyline already drawn. */
function sketch(points) {
  if (points !== undefined && !Array.isArray(points)) throw new TypeError(`sketch: expected nothing or an array of [x, y] points, got ${describe(points)}`);
  return new SketchBuilder(points === undefined ? [] : points);
}

// ---- arrays (return arrays; wrap in union() to merge) ------------------------------------

function checkShape(fn, name, v) {
  if (!isShape(v)) throw new TypeError(`${fn}: ${name} must be a Shape, got ${describe(v)}`);
  return v;
}
function linearArray(shape, count = 2, step = 1) {
  checkShape('linearArray', 'shape', shape); checkInt('linearArray', 'count', count);
  const v = typeof step === 'number' ? [checkNumber('linearArray', 'step', step), 0, 0] : checkVec('linearArray', 'step', step);
  const out = [];
  for (let i = 0; i < count; i++) out.push(shape.translate(v[0] * i, v[1] * i, v[2] * i));
  return out;
}
/** count copies around an axis. opts: { radius=0, axis='y', start=0, sweep=360, rotateCopies=true } */
function polarArray(shape, count = 6, opts = {}) {
  const radius = opts.radius === undefined ? 0 : opts.radius;
  const axis = opts.axis === undefined ? 'y' : opts.axis;
  const start = opts.start === undefined ? 0 : opts.start;
  const sweep = opts.sweep === undefined ? 360 : opts.sweep;
  const rotateCopies = opts.rotateCopies === undefined ? true : opts.rotateCopies;
  checkShape('polarArray', 'shape', shape); checkInt('polarArray', 'count', count);
  checkNumber('polarArray', 'radius', radius); checkNumber('polarArray', 'start', start); checkNumber('polarArray', 'sweep', sweep);
  const full = Math.abs(sweep) >= 360 - 1e-9;
  const stepA = full ? sweep / count : sweep / Math.max(1, count - 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = start + stepA * i;
    let sh = shape;
    if (radius) sh = sh.translate(axis === 'x' ? [0, radius, 0] : [radius, 0, 0]);
    const rot = axis === 'x' ? [a, 0, 0] : axis === 'y' ? [0, a, 0] : axis === 'z' ? [0, 0, a] : null;
    if (!rot) throw new Error("polarArray: axis must be 'x', 'y' or 'z'");
    if (rotateCopies || radius) sh = sh.rotate(rot[0], rot[1], rot[2]);
    out.push(sh);
  }
  return out;
}
/** grid(shape, [nx, nz], [dx, dz], { center }) on the ground plane */
function grid(shape, counts = [], steps = [], opts = {}) {
  const nx = counts[0] === undefined ? 2 : counts[0], nz = counts[1] === undefined ? 2 : counts[1];
  const dx = steps[0] === undefined ? 1 : steps[0], dz = steps[1] === undefined ? dx : steps[1];
  const center = opts.center === undefined ? true : opts.center;
  checkShape('grid', 'shape', shape); checkInt('grid', 'nx', nx); checkInt('grid', 'nz', nz); checkNumber('grid', 'dx', dx); checkNumber('grid', 'dz', dz);
  const ox = center ? -((nx - 1) * dx) / 2 : 0, oz = center ? -((nz - 1) * dz) / 2 : 0;
  const out = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push(shape.translate(ox + i * dx, 0, oz + j * dz));
  return out;
}

// ---- printer profile (print-profile.js) ----------------------------------------------
//
// Declared once at the top of a script; helpers derive printable dimensions from it, and hole()
// oversizes by holeCompensation on its own once a profile is declared.

const FITS = { press: -0.1, snug: 0, slide: 0.15, clearance: 0.3, loose: 0.6 };
const PROFILE_DEFAULT = Object.freeze({ nozzle: 0.4, layer: 0.2, holeCompensation: 0.2, material: null, declared: false });
let declaredProfile = null;
/** The profile in force: the one the script declared, or the defaults. */
const printProfile = () => (declaredProfile === null ? PROFILE_DEFAULT : declaredProfile);

function printer(opts = {}) {
  if (!opts || typeof opts !== 'object') throw new TypeError(`printer: expected { nozzle, layer, holeCompensation, material }, got ${describe(opts)}`);
  const p = Object.assign({}, PROFILE_DEFAULT, opts, { declared: true });
  checkPositive('printer', 'nozzle', p.nozzle); checkPositive('printer', 'layer', p.layer); checkNonNegative('printer', 'holeCompensation', p.holeCompensation);
  if (p.material !== null && typeof p.material !== 'string') throw new TypeError(`printer: material must be a string, got ${describe(p.material)}`);
  for (const k of Object.keys(opts)) if (!(k in PROFILE_DEFAULT)) throw new TypeError(`printer: unknown option "${k}"; use nozzle, layer, holeCompensation, material`);
  declaredProfile = Object.freeze(p);
  return declaredProfile;
}
const roundUp = (v, step) => { const n = Math.ceil(v / step - 1e-9); return +(n * step).toFixed(6); };
/** Wall thickness rounded up to whole extrusion lines; opts: { lines } for a count instead. */
function wall(t, opts = {}) {
  const nozzle = printProfile().nozzle;
  if (opts.lines !== undefined) { checkPositive('wall', 'lines', opts.lines); return +(Math.round(opts.lines) * nozzle).toFixed(6); }
  checkPositive('wall', 't', t);
  return roundUp(t, nozzle);
}
/** A height rounded up to whole layers; opts: { count } for a layer count instead. */
function layers(h, opts = {}) {
  const layer = printProfile().layer;
  if (opts.count !== undefined) { checkPositive('layers', 'count', opts.count); return +(Math.round(opts.count) * layer).toFixed(6); }
  checkPositive('layers', 'h', h);
  return roundUp(h, layer);
}
function allowance(fn, kind) {
  if (typeof kind === 'number') return checkNumber(fn, 'allowance', kind);
  if (typeof kind !== 'string' || !(kind in FITS)) throw new TypeError(`${fn}: kind must be ${Object.keys(FITS).map((k) => `'${k}'`).join(' | ')} or a number in mm, got ${describe(kind)}`);
  return FITS[kind];
}
/** The hole diameter to model so a part of diameter d fits it. */
function fit(d, kind = 'clearance') { checkPositive('fit', 'd', d); return +(d + printProfile().holeCompensation + allowance('fit', kind)).toFixed(6); }
/** The peg diameter to model so it fits an existing hole of diameter d the same way. */
function peg(d, kind = 'clearance') { checkPositive('peg', 'd', d); return +(d - printProfile().holeCompensation / 2 - allowance('peg', kind)).toFixed(6); }

// ---- screws and holes (cad.js) ------------------------------------------------------------
// clearance: ISO 273 medium fit. head: ISO 4762 socket cap (dia, height). csk: ISO 10642 head dia (90°).
// nut: ISO 4032 across-flats, thickness. insert: typical heat-set insert hole dia. tap: tap drill dia.

const SCREWS = {
  M2:   { d: 2,   clearance: 2.4, head: [3.8, 2.0],  csk: 3.8,  nut: [4.0, 1.6],  insert: 3.2,  tap: 1.6 },
  M2_5: { d: 2.5, clearance: 2.9, head: [4.5, 2.5],  csk: 4.7,  nut: [5.0, 2.0],  insert: 3.5,  tap: 2.05 },
  M3:   { d: 3,   clearance: 3.4, head: [5.5, 3.0],  csk: 6.7,  nut: [5.5, 2.4],  insert: 4.0,  tap: 2.5 },
  M4:   { d: 4,   clearance: 4.5, head: [7.0, 4.0],  csk: 9.0,  nut: [7.0, 3.2],  insert: 5.6,  tap: 3.3 },
  M5:   { d: 5,   clearance: 5.5, head: [8.5, 5.0],  csk: 11.2, nut: [8.0, 4.7],  insert: 6.4,  tap: 4.2 },
  M6:   { d: 6,   clearance: 6.6, head: [10.0, 6.0], csk: 13.4, nut: [10.0, 5.2], insert: 8.0,  tap: 5.0 },
  M8:   { d: 8,   clearance: 9.0, head: [13.0, 8.0], csk: 17.9, nut: [13.0, 6.8], insert: 10.0, tap: 6.8 },
};
const SCREW_KEYS = ['M2', 'M2_5', 'M3', 'M4', 'M5', 'M6', 'M8'];
function screw(size) {
  const key = String(size).toUpperCase().replace('.', '_');
  const s = SCREWS[key] !== undefined ? SCREWS[key] : SCREWS['M' + key];
  if (!s) throw new Error(`Unknown screw size "${size}". Known: ${SCREW_KEYS.join(', ').replace(/_/g, '.')}`);
  return s;
}
const OVERSHOOT = 1; // cutters poke this far above y = 0 so subtractions cut cleanly through the top face

/** A cutter for a screw hole: axis Y, top surface y = 0, shank going down `length`. */
function screwHole(size, length = 10, opts = {}) {
  const type = opts.type === undefined ? 'clearance' : opts.type;
  const headDepth = opts.headDepth;
  const tolerance = opts.tolerance === undefined ? 0.2 : opts.tolerance;
  const segments = opts.segments === undefined ? 32 : opts.segments;
  const bridge = opts.bridge === undefined ? 0 : opts.bridge;
  const s = screw(size);
  checkPositive('screwHole', 'length', length); checkNonNegative('screwHole', 'tolerance', tolerance); checkInt('screwHole', 'segments', segments, 3);
  checkNonNegative('screwHole', 'bridge', bridge);
  const shank = ((type === 'tap' ? s.tap : s.clearance) + tolerance) / 2;
  const L = length, O = OVERSHOOT;
  let profile;
  if (type === 'clearance' || type === 'tap') {
    profile = [[0, -L], [shank, -L], [shank, O], [0, O]];
  } else if (type === 'counterbore') {
    const hd = s.head[0], hh = s.head[1];
    const head = (hd + tolerance) / 2, depth = headDepth === undefined ? hh : headDepth;
    if (bridge > 0) return union(revolve(polygon2d([[0, -L], [shank, -L], [shank, -depth - bridge], [0, -depth - bridge]]), { segments }), revolve(polygon2d([[0, -depth], [head, -depth], [head, O], [0, O]]), { segments }));
    profile = [[0, -L], [shank, -L], [shank, -depth], [head, -depth], [head, O], [0, O]];
  } else if (type === 'countersunk') {
    const top = (s.csk + tolerance) / 2;
    const depth = top - shank;
    if (bridge > 0) return union(revolve(polygon2d([[0, -L], [shank, -L], [shank, -depth - bridge], [0, -depth - bridge]]), { segments }), revolve(polygon2d([[0, -depth], [shank, -depth], [top, 0], [top, O], [0, O]]), { segments }));
    profile = [[0, -L], [shank, -L], [shank, -depth], [top, 0], [top, O], [0, O]];
  } else {
    throw new Error(`screwHole: unknown type "${type}"`);
  }
  return revolve(polygon2d(profile), { segments });
}
/** A printable hole cutter along `axis`; horizontal holes get a teardrop (default), bridge or round section. */
function hole(r = 1, length = 10, opts = {}) {
  const axis = opts.axis === undefined ? 'z' : opts.axis;
  const shape = opts.shape === undefined ? 'teardrop' : opts.shape;
  const angle = opts.angle === undefined ? 45 : opts.angle;
  const flat = opts.flat;
  let tolerance = opts.tolerance;
  const segments = opts.segments === undefined ? 48 : opts.segments;
  if (tolerance === undefined) { const p = printProfile(); tolerance = p.declared ? p.holeCompensation : 0; }
  checkPositive('hole', 'radius', r); checkPositive('hole', 'length', length); checkNonNegative('hole', 'tolerance', tolerance);
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') throw new TypeError(`hole: axis must be 'x', 'y' or 'z', got ${describe(axis)}`);
  if (shape !== 'teardrop' && shape !== 'bridge' && shape !== 'round') throw new TypeError(`hole: shape must be 'teardrop', 'bridge' or 'round', got ${describe(shape)}`);
  const R = r + tolerance / 2;
  if (axis === 'y') return cylinder(R, length, { segments });
  const section = shape === 'teardrop' ? teardrop(R, { angle, flat, segments }) : shape === 'bridge' ? bridgedCircle(R, { angle, segments }) : circle(R, { segments });
  const s = extrude(section, length, { center: true }).rotate(90, 0, 0);
  return axis === 'x' ? s.rotate(0, 90, 0) : s;
}
/** Hexagonal nut pocket cutter: axis Y, top at y = 0. opts: { depth, tolerance=0.2 } */
function nutPocket(size, opts = {}) {
  const tolerance = opts.tolerance === undefined ? 0.2 : opts.tolerance;
  const nut = screw(size).nut;
  const d = opts.depth === undefined ? nut[1] : opts.depth;
  const r = (nut[0] + tolerance) / Math.sqrt(3);
  return prism(6, r, d + OVERSHOOT).rotate(0, 30, 0).translate(0, OVERSHOOT / 2 - d / 2, 0);
}
/** Heat-set insert hole cutter: axis Y, top at y = 0. opts: { depth, tolerance=0, segments } */
function heatInsert(size, opts = {}) {
  const tolerance = opts.tolerance === undefined ? 0 : opts.tolerance;
  const segments = opts.segments === undefined ? 32 : opts.segments;
  const s = screw(size);
  const d = opts.depth === undefined ? s.d * 2 : opts.depth;
  return cylinder((s.insert + tolerance) / 2, d + OVERSHOOT, { segments }).translate(0, OVERSHOOT / 2 - d / 2, 0);
}

// ---- helpers --------------------------------------------------------------------

const deg = (radians) => (radians * 180) / Math.PI;
const rad = (degrees) => (degrees * Math.PI) / 180;

function fmt(v) {
  if (isShape(v)) {
    const b = v.bounds();
    return `Shape(${v.meta.name ? `"${v.meta.name}", ` : ''}size ${b.size.map((n) => +n.toFixed(3)).join('×')})`;
  }
  if (isSketch(v)) { const b = v.bounds(); return `Sketch(size ${b.size.map((n) => +n.toFixed(3)).join('×')})`; }
  if (typeof v === 'object' && v !== null) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  return String(v);
}
function fmtEcho(v, depth = 0) {
  if (v === null || v === undefined || typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'function') return `function ${v.name || '(anonymous)'}`;
  if (isShape(v) || isSketch(v)) return fmt(v);
  if (Array.isArray(v)) return `[${v.map((x) => fmtEcho(x, depth + 1)).join(', ')}]`;
  if (typeof v === 'object') {
    const entries = Object.keys(v).map((k) => `${k} = ${fmtEcho(v[k], depth + 1)}`);
    return depth === 0 ? entries.join(', ') : `{ ${entries.join(', ')} }`;
  }
  return String(v);
}

const log = (...args) => { cad.log(args.map(fmt).join(' ')); };
/** echo(...values): OpenSCAD-style output; returns the first value so it works inline. */
const echo = (...args) => {
  const w = cad.where();
  const loc = w ? (w[0] === 'main.js' ? `line ${w[1]}` : `${w[0]} line ${w[1]}`) : '';
  cad.log(`ECHO${loc ? ` (${loc})` : ''}: ${args.map((a) => fmtEcho(a)).join(', ')}`);
  return args[0];
};
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
  declaredProfile = null;
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
  return { parts, profile: declaredProfile };
}

export const api = {
  Shape, box, cube, sphere, cylinder, cone, roundedBox, torus, polygon, prism, resize,
  union, difference, intersect, hull, linearArray, polarArray, grid,
  Sketch, circle, ellipse, rect, square, roundedRect, regularPolygon, polygon2d, slot, teardrop, bridgedCircle,
  union2d, difference2d, intersect2d, hull2d, extrude, revolve, projection, sketch, SketchBuilder,
  SCREWS, screw, screwHole, nutPocket, heatInsert, hole,
  printer, printProfile, wall, layers, fit, peg, FITS,
  deg, rad, log, print: log, echo, assert, show,
};
