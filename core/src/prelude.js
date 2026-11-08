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
  if (isFace(v)) return `the ${v.name} face of a shape`;
  if (isPath(v)) return 'a path';
  if (isImage(v)) return 'an image';
  if (isAnchor(v)) return `the anchor '${v.name}'`;
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

/** A named point on a shape, with an optional direction. */
function Anchor(name, point, normal) {
  this.name = name; this.point = [point[0], point[1], point[2]]; this.normal = normal ? [normal[0], normal[1], normal[2]] : null;
  Object.freeze(this);
}
function isAnchor(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Anchor.prototype; }

function rotationMatrix(x, y, z) {
  const r = (d) => (d * Math.PI) / 180;
  const cx = Math.cos(r(x)), sx = Math.sin(r(x)), cy = Math.cos(r(y)), sy = Math.sin(r(y)), cz = Math.cos(r(z)), sz = Math.sin(r(z));
  const rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]], ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mm = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  return mm(rz, mm(ry, rx));
}
/** Apply a point transform to every anchor (and, for rotations and mirrors, to their directions too). */
function mapAnchors(meta, mapPoint, directions) {
  if (!meta.anchors) return meta;
  const anchors = {};
  for (const k of Object.keys(meta.anchors)) {
    const a = meta.anchors[k];
    let normal = a.normal;
    if (normal && directions) { const n = mapPoint(normal); const l = Math.hypot(n[0], n[1], n[2]) || 1; normal = n.map((v) => v / l); }
    anchors[k] = { point: mapPoint(a.point), normal };
  }
  return Object.assign({}, meta, { anchors });
}

/** A solid: an immutable wrapper around a Manifold handle (world space, Y up). */
function Shape(h, color, meta) {
  this.h = h;
  this.colorValue = color === undefined ? DEFAULT_COLOR : color;
  this.meta = meta === undefined ? {} : meta;
  // Shapes never change, so the anchor view is built once here (the app exposes it as a getter).
  const anchors = {};
  if (this.meta.anchors) for (const k of Object.keys(this.meta.anchors)) { const a = this.meta.anchors[k]; anchors[k] = new Anchor(k, a.point, a.normal); }
  this.anchors = anchors;
}
function isShape(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Shape.prototype; }
/** A new shape from a handle, with anchors carried through `mapPoint` when given. */
function wrap(s, h, mapPoint, directions) { return new Shape(h, s.colorValue, mapPoint ? mapAnchors(s.meta, mapPoint, !!directions) : s.meta); }
function withMeta(s, patch) { return new Shape(s.h, s.colorValue, Object.assign({}, s.meta, patch)); }
/** Anchors of several shapes combined; the first shape wins on a clash. */
function mergeAnchors(shapes) {
  const anchors = {};
  for (const s of shapes) if (s.meta.anchors) for (const k of Object.keys(s.meta.anchors)) if (!(k in anchors)) anchors[k] = s.meta.anchors[k];
  return Object.keys(anchors).length ? Object.assign({}, shapes[0].meta, { anchors }) : shapes[0].meta;
}

const P = Shape.prototype;
P.translate = function (x = 0, y = 0, z = 0) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; z = v[2] === undefined ? 0 : v[2]; }
  checkNumber('translate', 'x', x); checkNumber('translate', 'y', y); checkNumber('translate', 'z', z);
  return wrap(this, cad.translate(this.h, x, y, z), (p) => [p[0] + x, p[1] + y, p[2] + z]);
};
P.rotate = function (x = 0, y = 0, z = 0) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; z = v[2] === undefined ? 0 : v[2]; }
  checkNumber('rotate', 'x', x); checkNumber('rotate', 'y', y); checkNumber('rotate', 'z', z);
  const R = rotationMatrix(x, y, z);
  return wrap(this, cad.rotate(this.h, x, y, z), (p) => R.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]), true);
};
P.scale = function (x = 1, y, z) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1]; z = v[2]; }
  if (y === undefined) { y = x; z = x; }
  checkNumber('scale', 'x', x); checkNumber('scale', 'y', y); checkNumber('scale', 'z', z);
  if (x === 0 || y === 0 || z === 0) throw new RangeError('scale: factors must not be 0');
  return wrap(this, cad.scale(this.h, x, y, z), (p) => [p[0] * x, p[1] * y, p[2] * z]);
};
P.mirror = function (axis = 'x') {
  const n = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : axis === 'z' ? [0, 0, 1] : null;
  if (!n) throw new Error("mirror: axis must be 'x', 'y' or 'z'");
  const i = n.indexOf(1);
  return wrap(this, cad.mirror(this.h, n[0], n[1], n[2]), (p) => p.map((v, k) => (k === i ? -v : v)), true);
};
/** anchor(name, point, normal?) records a named point that travels with the shape; anchor(name) reads it back. */
P.anchor = function (name, point, normal) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError(`anchor: expected a name, got ${describe(name)}`);
  if (point === undefined) {
    const a = this.meta.anchors ? this.meta.anchors[name] : undefined;
    if (!a) throw new Error(`anchor: "${name}" is not an anchor of this shape${this.meta.anchors ? ` (it has ${Object.keys(this.meta.anchors).map((k) => `'${k}'`).join(', ')})` : ''}`);
    return new Anchor(name, a.point, a.normal);
  }
  checkVec('anchor', 'point', point);
  if (normal !== undefined) { checkVec('anchor', 'normal', normal); const l = Math.hypot(normal[0], normal[1], normal[2]) || 1; normal = normal.map((v) => v / l); }
  const anchors = Object.assign({}, this.meta.anchors);
  anchors[name] = { point: [point[0], point[1], point[2]], normal: normal ? [normal[0], normal[1], normal[2]] : null };
  return withMeta(this, { anchors });
};
P.face = function (name) { return new Face(this, name); };
P.at = function (target, offset, opts) { return at(this, target, offset, opts); };
P.placeOn = function (base, faceName, opts) { return placeOn(this, base, faceName, opts); };
P.alignTo = function (other, spec, opts) { return alignTo(this, other, spec, opts); };
P.intersects = function (o) { return intersects(this, o); };
P.interference = function (o) { return interference(this, o); };
P.overlap = function (o) { return overlap(this, o); };
P.clearance = function (o, opts) { return clearance(this, o, opts); };
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
  return new Shape(h, shapes[0].colorValue, mergeAnchors(shapes));
}
function difference(first, ...rest) {
  if (allSketches([first, rest])) return difference2d(first, ...rest);
  if (Array.isArray(first)) { const all = flattenShapes('difference', [first]); first = all[0]; rest = all.slice(1).concat(rest); }
  if (!isShape(first)) throw new TypeError(`difference: first argument must be a Shape, got ${describe(first)}`);
  const cutters = flattenShapes('difference', rest);
  if (!cutters.length) return first;
  const cutter = cutters.length === 1 ? cutters[0].h : cad.batch(cutters.map((s) => s.h), 0);
  return new Shape(cad.boolean(first.h, cutter, 1), first.colorValue, mergeAnchors([first].concat(cutters)));
}
function intersect(...items) {
  if (allSketches(items)) return intersect2d(...items);
  const shapes = flattenShapes('intersect', items);
  if (!shapes.length) throw new TypeError('intersect: needs at least one Shape');
  let h = shapes[0].h;
  for (let i = 1; i < shapes.length; i++) h = cad.boolean(h, shapes[i].h, 2);
  return new Shape(h, shapes[0].colorValue, mergeAnchors(shapes));
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

// ---- text (sketch.js + fonts.js): outlines come from the fonts natively ----------------------

const DEFAULT_FONT = 'Inter';
/** Text as a 2D sketch, baseline on y = 0, starting at x = 0. opts: { size=10, font, align, letterSpacing=0, kerning=true, curveSegments=8 } */
function text(str, opts = {}) {
  if (typeof str !== 'string') throw new TypeError(`text: first argument must be a string, got ${describe(str)}`);
  const size = opts.size === undefined ? 10 : opts.size;
  const font = opts.font === undefined ? DEFAULT_FONT : opts.font;
  const align = opts.align === undefined ? 'left' : opts.align;
  const letterSpacing = opts.letterSpacing === undefined ? 0 : opts.letterSpacing;
  const kerning = opts.kerning === undefined ? true : opts.kerning;
  const curveSegments = opts.curveSegments === undefined ? 8 : opts.curveSegments;
  if (opts.size !== undefined) checkPositive('text', 'size', size);
  if (align !== 'left' && align !== 'center' && align !== 'right') throw new TypeError(`text: align must be 'left', 'center' or 'right', got ${describe(align)}`);
  const out = cad.textOutlines(str, String(font), size, align === 'center' ? 1 : align === 'right' ? 2 : 0, letterSpacing, kerning ? 1 : 0, curveSegments);
  // Font contours use non-zero winding (holes run the opposite way).
  return sketchFromRings(out.rings, FILL.nonZero);
}
/** Text extruded to `height` (mm). Same opts as text(), plus { height=1 }. */
function text3d(str, opts = {}) {
  const height = opts.height === undefined ? 1 : opts.height;
  checkPositive('text3d', 'height', height);
  const textOpts = Object.assign({}, opts);
  delete textOpts.height;
  return extrude(text(str, textOpts), height);
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

// ---- placement by named features (place.js) ------------------------------------------

const FACES = {
  top: { axis: 1, sign: 1, u: 0, v: 2, rotate: [0, 0, 0] },
  bottom: { axis: 1, sign: -1, u: 0, v: 2, rotate: [180, 0, 0] },
  front: { axis: 2, sign: 1, u: 0, v: 1, rotate: [90, 0, 0] },
  back: { axis: 2, sign: -1, u: 0, v: 1, rotate: [-90, 0, 0] },
  right: { axis: 0, sign: 1, u: 2, v: 1, rotate: [0, 0, -90] },
  left: { axis: 0, sign: -1, u: 2, v: 1, rotate: [0, 0, 90] },
};
const FACE_NAMES = ['top', 'bottom', 'front', 'back', 'right', 'left'];
const AXES = 'xyz';

/** A face of a shape's bounding box: { name, normal, center, min, max, size, u, v }. */
function Face(shape, name) {
  const f = FACES[name];
  if (!f) throw new TypeError(`face: expected one of ${FACE_NAMES.join(', ')}, got ${describe(name)}`);
  const b = shape.bounds();
  this.name = name; this.shape = shape;
  this.axis = AXES[f.axis]; this.sign = f.sign;
  this.normal = [0, 0, 0]; this.normal[f.axis] = f.sign;
  this.center = [b.center[0], b.center[1], b.center[2]]; this.center[f.axis] = f.sign > 0 ? b.max[f.axis] : b.min[f.axis];
  this.min = b.min; this.max = b.max; this.size = b.size;
  this.u = AXES[f.u]; this.v = AXES[f.v];
  Object.freeze(this);
}
function isFace(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Face.prototype; }
/** A point on the face: [u, v] along its in-plane axes, or { x, y, z } offsets in world axes. */
Face.prototype.point = function (at = [0, 0]) {
  const p = [this.center[0], this.center[1], this.center[2]];
  if (Array.isArray(at)) {
    if (at.length !== 2) throw new TypeError(`${this.name} face: an offset is [${this.u}, ${this.v}], got ${describe(at)}`);
    p[AXES.indexOf(this.u)] += checkNumber('at', this.u, at[0]); p[AXES.indexOf(this.v)] += checkNumber('at', this.v, at[1]);
  } else if (at && typeof at === 'object') {
    for (const k of AXES) if (at[k] !== undefined) p[AXES.indexOf(k)] += checkNumber('at', k, at[k]);
  } else throw new TypeError(`at: expected [u, v] or { x, y, z }, got ${describe(at)}`);
  return p;
};
const checkFace = (fn, f) => { if (!isFace(f)) throw new TypeError(`${fn}: expected a face (shape.face('top')), got ${describe(f)}`); return f; };

/** Rotation (degrees about X, Y, Z) that turns +Y onto a unit direction. */
function rotationToward(n) {
  const x = n[0], y = n[1], z = n[2];
  if (Math.abs(y - 1) < 1e-9) return [0, 0, 0];
  if (Math.abs(y + 1) < 1e-9) return [180, 0, 0];
  const tilt = (Math.acos(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
  const turn = (Math.atan2(x, z) * 180) / Math.PI;
  return [tilt, turn, 0];
}
/** Put a shape's origin on a point of a face or on an anchor, +Y turned along the normal. */
function at(shape, target, offset = [0, 0], opts = {}) {
  const gap = opts.gap === undefined ? 0 : opts.gap;
  const orient = opts.orient === undefined ? true : opts.orient;
  checkNumber('at', 'gap', gap);
  if (isAnchor(target)) {
    const n = target.normal === null ? [0, 1, 0] : target.normal;
    const p = target.point.map((v, k) => v + n[k] * gap);
    if (Array.isArray(offset) && offset.length === 3) for (let k = 0; k < 3; k++) p[k] += checkNumber('at', 'xyz'[k], offset[k]);
    const rot = rotationToward(n);
    const s = orient && target.normal ? shape.rotate(rot[0], rot[1], rot[2]) : shape;
    return s.translate(p[0], p[1], p[2]);
  }
  const face = checkFace('at', target);
  const f = FACES[face.name];
  const p = face.point(offset);
  for (let k = 0; k < 3; k++) p[k] += face.normal[k] * gap;
  const s = orient && (f.rotate[0] || f.rotate[1] || f.rotate[2]) ? shape.rotate(f.rotate[0], f.rotate[1], f.rotate[2]) : shape;
  return s.translate(p[0], p[1], p[2]);
}
/** Put a shape on a face of another: its opposite face touches the target face. opts: { at, gap, align } */
function placeOn(shape, base, faceName = 'top', opts = {}) {
  const offset = opts.at === undefined ? [0, 0] : opts.at;
  const gap = opts.gap === undefined ? 0 : opts.gap;
  const align = opts.align === undefined ? 'center' : opts.align;
  checkShape('placeOn', 'base', base); checkNumber('placeOn', 'gap', gap);
  const face = new Face(base, faceName);
  const f = FACES[faceName];
  const b = shape.bounds();
  const target = face.point(offset);
  const d = [0, 0, 0];
  const mine = f.sign > 0 ? b.min[f.axis] : b.max[f.axis];
  d[f.axis] = target[f.axis] + f.sign * gap - mine;
  if (align === 'center') { d[f.u] = target[f.u] - b.center[f.u]; d[f.v] = target[f.v] - b.center[f.v]; }
  else if (align !== 'keep') throw new TypeError(`placeOn: align must be 'center' or 'keep', got ${describe(align)}`);
  return shape.translate(d[0], d[1], d[2]);
}
const RELATIONS = { x: { left: -1, right: 1 }, y: { below: -1, above: 1 }, z: { back: -1, front: 1 } };
/** Align bounding boxes axis by axis: 'min' | 'center' | 'max', or a side of the other shape to sit against. */
function alignTo(shape, other, spec = {}, opts = {}) {
  const gap = opts.gap === undefined ? 0 : opts.gap;
  checkShape('alignTo', 'other', other); checkNonNegative('alignTo', 'gap', gap);
  if (!spec || typeof spec !== 'object') throw new TypeError(`alignTo: expected { x, y, z }, got ${describe(spec)}`);
  const a = shape.bounds(), b = other.bounds();
  const d = [0, 0, 0];
  for (const k of AXES) {
    const how = spec[k]; if (how === undefined) continue;
    const i = AXES.indexOf(k);
    if (how === 'min') d[i] = b.min[i] - a.min[i];
    else if (how === 'center') d[i] = b.center[i] - a.center[i];
    else if (how === 'max') d[i] = b.max[i] - a.max[i];
    else if (RELATIONS[k][how] === 1) d[i] = b.max[i] + gap - a.min[i];
    else if (RELATIONS[k][how] === -1) d[i] = b.min[i] - gap - a.max[i];
    else throw new TypeError(`alignTo: ${k} must be 'min', 'center', 'max' or ${Object.keys(RELATIONS[k]).map((s) => `'${s}'`).join(' | ')}, got ${describe(how)}`);
  }
  return shape.translate(d[0], d[1], d[2]);
}
/** Distance between two faces (along the first one's normal), a face and a point, or two points. */
function distance(a, b) {
  const pt = (v) => (isFace(v) ? v.center : isAnchor(v) ? v.point : Array.isArray(v) && v.length === 3 ? v.map((x, i) => checkNumber('distance', AXES[i], x)) : null);
  const pa = pt(a), pb = pt(b);
  if (!pa || !pb) throw new TypeError(`distance: expected faces, anchors or [x, y, z] points, got ${describe(a)} and ${describe(b)}`);
  if (isFace(a)) return Math.abs((pb[0] - pa[0]) * a.normal[0] + (pb[1] - pa[1]) * a.normal[1] + (pb[2] - pa[2]) * a.normal[2]);
  if (isFace(b)) return distance(b, a);
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
}
/** The four corners of a w x d rectangle centred on the origin, as [u, v] points. */
function rectPattern(w, d) {
  if (d === undefined) d = w;
  checkNumber('rectPattern', 'w', w); checkNumber('rectPattern', 'd', d);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]];
}
/** An nu x nv grid of [u, v] points with the given pitch, centred on the origin. */
function gridPattern(nu, nv, du, dv) {
  if (dv === undefined) dv = du;
  checkNumber('gridPattern', 'nu', nu); checkNumber('gridPattern', 'nv', nv); checkNumber('gridPattern', 'du', du); checkNumber('gridPattern', 'dv', dv);
  const out = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) out.push([(i - (nu - 1) / 2) * du, (j - (nv - 1) / 2) * dv]);
  return out;
}

// ---- measurements (measure.js) -----------------------------------------------------------

const diag = (s) => { const size = s.bounds().size; return Math.hypot(size[0], size[1], size[2]); };
function overlap(a, b) { checkShape('overlap', 'a', a); checkShape('overlap', 'b', b); return new Shape(cad.boolean(a.h, b.h, 2)); }
function interference(a, b) { checkShape('interference', 'a', a); checkShape('interference', 'b', b); return cad.volume(cad.boolean(a.h, b.h, 2)); }
const intersects = (a, b) => interference(a, b) > 1e-9;
/** Smallest distance between the surfaces of two shapes; 0 when they touch or overlap. opts: { searchLength } */
function clearance(a, b, opts = {}) {
  checkShape('clearance', 'a', a); checkShape('clearance', 'b', b);
  if (opts.searchLength !== undefined) checkNumber('clearance', 'searchLength', opts.searchLength);
  if (interference(a, b) > 1e-9) return 0;
  const L = opts.searchLength === undefined ? diag(a) + diag(b) + 1 : opts.searchLength;
  const g = cad.minGap(a.h, b.h, L);
  return g >= L ? Infinity : g;
}

// ---- annotations (annotate.js): drawn over renders and listed in the report, never geometry -----

function toPoint(fn, v) {
  if (isFace(v)) return [v.center[0], v.center[1], v.center[2]];
  if (isAnchor(v)) return [v.point[0], v.point[1], v.point[2]];
  if (isShape(v)) { const c = v.bounds().center; return [c[0], c[1], c[2]]; }
  if (Array.isArray(v) && v.length === 3) return v.map((x, i) => checkNumber(fn, 'xyz'[i], x));
  throw new TypeError(`${fn}: expected [x, y, z], a face, an anchor or a shape, got ${describe(v)}`);
}
const fmtMm = (v) => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(2).replace(/0$/, ''));
/** A dimension between a and b; returns the length. opts: { label, offset } */
function dimension(a, b, opts = {}) {
  let pa = toPoint('dimension', a), pb = toPoint('dimension', b);
  const length = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
  if (opts.offset !== undefined) { const o = toPoint('dimension', opts.offset); pa = pa.map((v, i) => v + o[i]); pb = pb.map((v, i) => v + o[i]); }
  cad.annotate(JSON.stringify({ type: 'dimension', a: pa, b: pb, label: opts.label === undefined ? `${fmtMm(length)} mm` : String(opts.label), length }));
  return length;
}
/** A labelled point. */
function mark(point, text = '') {
  const p = toPoint('mark', point);
  cad.annotate(JSON.stringify({ type: 'mark', p, text: String(text) }));
  return p;
}

// ---- solids from raw triangles (mesh.js) ------------------------------------------------

/** Flip triangles as needed so every shared edge is traversed in opposite directions. */
function orientConsistently(tris) {
  const n = tris.length / 3;
  const faces = [];
  for (let i = 0; i < n; i++) faces.push([tris[i * 3], tris[i * 3 + 1], tris[i * 3 + 2]]);
  const byEdge = new Map();
  const key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let i = 0; i < n; i++) { const f = faces[i]; for (let k = 0; k < 3; k++) { const e = key(f[k], f[(k + 1) % 3]); if (!byEdge.has(e)) byEdge.set(e, []); byEdge.get(e).push(i); } }
  const hasDirected = (f, a, b) => (f[0] === a && f[1] === b) || (f[1] === a && f[2] === b) || (f[2] === a && f[0] === b);
  const visited = [];
  for (let i = 0; i < n; i++) visited.push(false);
  for (let seed = 0; seed < n; seed++) {
    if (visited[seed]) continue;
    visited[seed] = true;
    const stack = [seed];
    while (stack.length) {
      const i = stack.pop(), f = faces[i];
      for (let k = 0; k < 3; k++) {
        const a = f[k], b = f[(k + 1) % 3];
        for (const j of byEdge.get(key(a, b))) {
          if (j === i || visited[j]) continue;
          if (hasDirected(faces[j], a, b)) faces[j] = [faces[j][0], faces[j][2], faces[j][1]];
          visited[j] = true; stack.push(j);
        }
      }
    }
  }
  const out = [];
  for (const f of faces) out.push(f[0], f[1], f[2]);
  return out;
}
function manifoldFromTriangles(fn, positions, tris) {
  const oriented = orientConsistently(tris);
  let h;
  try { h = cad.meshFromTriangles(positions, oriented); }
  catch (err) { throw new Error(`${fn}: mesh is not a closed, manifold solid (${err.message}). Check that every edge is shared by exactly two faces.`); }
  if (cad.volume(h) < 0) {
    const flipped = [];
    for (let i = 0; i < oriented.length; i += 3) flipped.push(oriented[i], oriented[i + 2], oriented[i + 1]);
    h = cad.meshFromTriangles(positions, flipped);
  }
  return h;
}
/** A solid from points and faces (index lists, any winding). */
function polyhedron(points, faces) {
  if (!Array.isArray(points) || points.length < 4) throw new TypeError(`polyhedron: points must be an array of at least 4 [x,y,z], got ${describe(points)}`);
  if (!Array.isArray(faces) || faces.length < 4) throw new TypeError(`polyhedron: faces must be an array of at least 4 index lists, got ${describe(faces)}`);
  for (let i = 0; i < points.length; i++) checkVec('polyhedron', `points[${i}]`, points[i]);
  const tris = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (!Array.isArray(f) || f.length < 3) throw new TypeError(`polyhedron: faces[${i}] must list at least 3 point indices, got ${describe(f)}`);
    for (const k of f) { checkInt('polyhedron', `faces[${i}] index`, k, 0); if (k >= points.length) throw new RangeError(`polyhedron: faces[${i}] refers to point ${k} but there are only ${points.length} points`); }
    for (let k = 1; k < f.length - 1; k++) tris.push(f[0], f[k], f[k + 1]);
  }
  const flat = [];
  for (const p of points) flat.push(p[0], p[1], p[2]);
  return new Shape(manifoldFromTriangles('polyhedron', flat, tris));
}
/** Resample a closed ring to n points spaced evenly by arc length. */
function resampleRing(ring, n) {
  const l = []; let total = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; const d = Math.hypot(b[0] - a[0], b[1] - a[1]); l.push(d); total += d; }
  const out = []; let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (seg < ring.length - 1 && acc + l[seg] < target) { acc += l[seg]; seg++; }
    const a = ring[seg], b = ring[(seg + 1) % ring.length];
    const t = l[seg] > 0 ? (target - acc) / l[seg] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
/** Triangulate rings (outer + holes) into index triples over their points in order. */
function triangulateRings(rings) {
  const flat = cad.triangulate(rings, 1e-9);
  const out = [];
  for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}
/** Loft (skin) between 2D profiles stacked along Y. loft([a, b, c], 30) or loft([a, b], [0, 12]); opts: { segments=64 } */
function loft(profiles, heights = 1, opts = {}) {
  const segments = opts.segments === undefined ? 64 : opts.segments;
  if (!Array.isArray(profiles) || profiles.length < 2) throw new TypeError(`loft: need an array of at least 2 sketches, got ${describe(profiles)}`);
  for (let i = 0; i < profiles.length; i++) if (!isSketch(profiles[i])) throw new TypeError(`loft: profiles[${i}] must be a 2D sketch, got ${describe(profiles[i])}`);
  checkInt('loft', 'segments', segments, 3);
  let ys;
  if (typeof heights === 'number') { checkPositive('loft', 'height', heights); ys = profiles.map((_, i) => (i / (profiles.length - 1)) * heights); }
  else {
    if (!Array.isArray(heights) || heights.length !== profiles.length) throw new TypeError('loft: heights must be a number or one height per profile');
    for (let i = 0; i < heights.length; i++) checkNumber('loft', `heights[${i}]`, heights[i]);
    for (let i = 1; i < heights.length; i++) if (heights[i] <= heights[i - 1]) throw new RangeError('loft: heights must increase');
    ys = heights;
  }
  const rings = profiles.map((p, i) => {
    const polys = p.toPolygons();
    if (polys.length !== 1) throw new Error(`loft: profiles[${i}] must be a single outline without holes (it has ${polys.length} contours)`);
    return resampleRing(polys[0], segments);
  });
  for (let i = 1; i < rings.length; i++) {
    const prev = rings[i - 1], cur = rings[i];
    let best = 0, bestD = Infinity;
    for (let off = 0; off < segments; off++) {
      let d = 0;
      for (let k = 0; k < segments; k++) { const a = prev[k], b = cur[(k + off) % segments]; d += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
      if (d < bestD) { bestD = d; best = off; }
    }
    rings[i] = cur.map((_, k) => cur[(k + best) % segments]);
  }
  const pos = [];
  for (let i = 0; i < rings.length; i++) for (const p of rings[i]) pos.push(p[0], ys[i], -p[1]);
  const tris = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = i * segments, b = (i + 1) * segments;
    for (let k = 0; k < segments; k++) { const k2 = (k + 1) % segments; tris.push(a + k, a + k2, b + k2, a + k, b + k2, b + k); }
  }
  const cap = triangulateRings([rings[0]]);
  const top = (rings.length - 1) * segments;
  for (const t of cap) { tris.push(t[0], t[2], t[1]); tris.push(top + t[0], top + t[1], top + t[2]); }
  return new Shape(manifoldFromTriangles('loft', pos, tris));
}

// ---- paths and sweep (path.js) -----------------------------------------------------------
//
// Paths are 3D polylines in world space (Y up). A point may be [x, y, z], or [x, y] for a point on
// the ground plane using the sketch convention (sketch y is world -Z).

const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vmul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a); return l > 0 ? vmul(a, 1 / l) : [0, 0, 0]; };

function checkPathPoint(fn, p, i) {
  if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) throw new TypeError(`${fn}: point ${i} must be [x, y, z] or [x, y], got ${describe(p)}`);
  for (let k = 0; k < p.length; k++) checkNumber(fn, `point ${i}[${k}]`, p[k]);
  return p.length === 2 ? [p[0], 0, -p[1]] : [p[0], p[1], p[2]];
}
function checkPathPoints(fn, points) {
  if (!Array.isArray(points) || points.length < 2) throw new TypeError(`${fn}: need an array of at least 2 points, got ${describe(points)}`);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const q = checkPathPoint(fn, points[i], i);
    if (out.length && vlen(vsub(q, out[out.length - 1])) < EPS) continue;
    out.push(q);
  }
  if (out.length < 2) throw new RangeError(`${fn}: the points are all the same`);
  return out;
}
/** Catmull-Rom spline through the points, `segments` samples per span. */
function catmullRom(points, segments, closed) {
  const n = points.length;
  const at = (i) => (closed ? points[((i % n) + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const out = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < segments; k++) {
      const t = k / segments, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((a) => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)));
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/** A 3D polyline, open or closed. Immutable; every op returns a new Path. */
function Path(points, closed) { this.points = points; this.closed = !!closed; Object.freeze(this); }
function isPath(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Path.prototype; }
const T = Path.prototype;
T._map = function (f) { return new Path(this.points.map(f), this.closed); };
T.translate = function (x = 0, y = 0, z = 0) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; z = v[2] === undefined ? 0 : v[2]; }
  checkNumber('translate', 'x', x); checkNumber('translate', 'y', y); checkNumber('translate', 'z', z);
  return this._map((p) => [p[0] + x, p[1] + y, p[2] + z]);
};
T.rotate = function (x = 0, y = 0, z = 0) {
  if (Array.isArray(x)) { const v = x; x = v[0]; y = v[1] === undefined ? 0 : v[1]; z = v[2] === undefined ? 0 : v[2]; }
  checkNumber('rotate', 'x', x); checkNumber('rotate', 'y', y); checkNumber('rotate', 'z', z);
  const m = rotationMatrix(x, y, z);
  return this._map((p) => m.map((row) => vdot(row, p)));
};
T.scale = function (x = 1, y, z) {
  if (y === undefined) y = x;
  if (z === undefined) z = x;
  checkNumber('scale', 'x', x); checkNumber('scale', 'y', y); checkNumber('scale', 'z', z);
  if (x === 0 || y === 0 || z === 0) throw new RangeError('scale: factors must not be 0');
  return this._map((p) => [p[0] * x, p[1] * y, p[2] * z]);
};
T.mirror = function (axis = 'x') {
  const i = axis === 'x' ? 0 : axis === 'y' ? 1 : axis === 'z' ? 2 : undefined;
  if (i === undefined) throw new Error("mirror: axis must be 'x', 'y' or 'z'");
  return this._map((p) => { const q = [p[0], p[1], p[2]]; q[i] = -q[i]; return q; });
};
T.reverse = function () { return new Path(this.points.slice().reverse(), this.closed); };
T.close = function () { return new Path(this.points, true); };
T.smooth = function (opts = {}) {
  const segments = opts.segments === undefined ? 8 : opts.segments;
  checkInt('smooth', 'segments', segments, 1);
  return new Path(catmullRom(this.points, segments, this.closed), this.closed);
};
T.append = function (other) {
  if (!isPath(other)) throw new TypeError(`append: expected a path, got ${describe(other)}`);
  if (this.closed) throw new Error('append: this path is already closed');
  const d = vsub(this.points[this.points.length - 1], other.points[0]);
  return new Path(checkPathPoints('append', this.points.concat(other.points.map((p) => vadd(p, d)))), false);
};
T.segments = function () {
  const s = [];
  for (let i = 0; i < this.points.length - 1; i++) s.push([this.points[i], this.points[i + 1]]);
  if (this.closed) s.push([this.points[this.points.length - 1], this.points[0]]);
  return s;
};
T.length = function () { let t = 0; for (const s of this.segments()) t += vlen(vsub(s[1], s[0])); return t; };
T.pointAt = function (t) { return this._at(t).point; };
T.tangentAt = function (t) { return this._at(t).tangent; };
T._at = function (t) {
  checkNumber('pointAt', 't', t);
  const segs = this.segments(); const total = this.length();
  let target = Math.min(Math.max(t, 0), 1) * total;
  for (const s of segs) {
    const a = s[0], b = s[1];
    const l = vlen(vsub(b, a));
    if (target <= l || segs[segs.length - 1][0] === a) return { point: vadd(a, vmul(vsub(b, a), l > 0 ? Math.min(target / l, 1) : 0)), tangent: vnorm(vsub(b, a)) };
    target -= l;
  }
  return { point: this.points[0], tangent: vnorm(vsub(this.points[1], this.points[0])) };
};
T.bounds = function () {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of this.points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return { min, max, size: vsub(max, min), center: vmul(vadd(min, max), 0.5) };
};
T.sweep = function (profile, opts) { return sweep(profile, this, opts); };

/** Polyline through points. opts: { closed, smooth } */
function path(points, opts = {}) {
  const closed = !!opts.closed, smooth = opts.smooth === undefined ? false : opts.smooth;
  let p = new Path(checkPathPoints('path', points), closed);
  if (smooth) p = p.smooth({ segments: smooth === true ? 8 : smooth });
  return p;
}
function line(a, b) { return new Path(checkPathPoints('line', [a, b]), false); }
/** Arc on the ground plane centred on the origin: from +X, `angle` degrees counter-clockwise seen from above. */
function arc(r = 1, angle = 90, opts = {}) {
  checkPositive('arc', 'radius', r); checkNumber('arc', 'angle', angle);
  if (angle === 0) throw new RangeError('arc: angle must not be 0');
  const n = opts.segments === undefined ? Math.max(2, Math.ceil((Math.abs(angle) / 360) * 64)) : opts.segments;
  checkInt('arc', 'segments', n, 1);
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = (angle * (i / n) * Math.PI) / 180; pts.push([r * Math.cos(a), 0, -r * Math.sin(a)]); }
  return new Path(pts, Math.abs(Math.abs(angle) - 360) < EPS);
}
/** Helix around the Y axis, starting at [r, 0, 0], rising to `height` over `turns` turns. */
function helix(r = 1, height = 1, turns = 1, opts = {}) {
  const segments = opts.segments === undefined ? 48 : opts.segments;
  checkPositive('helix', 'radius', r); checkNumber('helix', 'height', height); checkNumber('helix', 'turns', turns);
  if (turns === 0) throw new RangeError('helix: turns must not be 0');
  checkInt('helix', 'segments', segments, 3);
  const n = Math.max(2, Math.ceil(Math.abs(turns) * segments));
  const pts = [];
  for (let i = 0; i <= n; i++) { const f = i / n, a = turns * f * 2 * Math.PI; pts.push([r * Math.cos(a), height * f, -r * Math.sin(a)]); }
  return new Path(pts, false);
}
/** Cubic Bezier from p0 to p3 with control points p1, p2. */
function bezier(p0, p1, p2, p3, opts = {}) {
  const segments = opts.segments === undefined ? 32 : opts.segments;
  const a = checkPathPoint('bezier', p0, 0), b = checkPathPoint('bezier', p1, 1), c = checkPathPoint('bezier', p2, 2), d = checkPathPoint('bezier', p3, 3);
  checkInt('bezier', 'segments', segments, 1);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, u = 1 - t;
    pts.push([0, 1, 2].map((k) => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k]));
  }
  return new Path(checkPathPoints('bezier', pts), false);
}

function defaultUp(t, up) { if (up) return up; return Math.abs(t[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0]; }
function frameFromUp(t, upHint) {
  const up = defaultUp(t, upHint);
  let u = vsub(up, vmul(t, vdot(up, t)));
  if (vlen(u) < 1e-6) throw new Error('sweep: the up direction is parallel to the path; choose another { up }');
  u = vnorm(u);
  return { r: vcross(u, t), u };
}
/** Frames along a polyline: tangent, right and up per vertex; 'minimal' never twists, 'upright' keeps u near `up`. */
function pathFrames(points, closed, mode, upHint) {
  const n = points.length;
  const dirs = [];
  for (let i = 0; i < n - 1; i++) dirs.push(vnorm(vsub(points[i + 1], points[i])));
  if (closed) dirs.push(vnorm(vsub(points[0], points[n - 1])));
  const tangents = points.map((_, i) => {
    const din = i === 0 ? (closed ? dirs[n - 1] : dirs[0]) : dirs[i - 1];
    const dout = i === n - 1 ? (closed ? dirs[n - 1] : dirs[n - 2]) : dirs[i];
    let t = vnorm(vadd(din, dout));
    if (vlen(t) < 1e-9) t = din;
    return { t, din, dout };
  });
  const out = [];
  if (mode === 'upright') {
    for (const tg of tangents) { const f = frameFromUp(tg.t, upHint); out.push({ r: f.r, u: f.u, t: tg.t, din: tg.din, dout: tg.dout }); }
    return out;
  }
  const f0 = frameFromUp(tangents[0].t, upHint);
  let r = f0.r, u = f0.u;
  out.push({ r, u, t: tangents[0].t, din: tangents[0].din, dout: tangents[0].dout });
  const steps = closed ? n : n - 1;
  for (let i = 1; i <= steps; i++) {
    const j = i % n;
    const v1 = vsub(points[j], points[(i - 1) % n]);
    const c1 = vdot(v1, v1);
    const rL = vsub(r, vmul(v1, (2 / c1) * vdot(v1, r)));
    const tL = vsub(out[i - 1].t, vmul(v1, (2 / c1) * vdot(v1, out[i - 1].t)));
    const v2 = vsub(tangents[j].t, tL);
    const c2 = vdot(v2, v2);
    r = c2 < 1e-18 ? rL : vsub(rL, vmul(v2, (2 / c2) * vdot(v2, rL)));
    r = vnorm(vsub(r, vmul(tangents[j].t, vdot(r, tangents[j].t))));
    u = vcross(tangents[j].t, r);
    if (i < n) out.push({ r, u, t: tangents[j].t, din: tangents[j].din, dout: tangents[j].dout });
    else {
      const first = out[0];
      const ang = Math.atan2(vdot(vcross(r, first.r), first.t), vdot(r, first.r));
      for (let k = 0; k < out.length; k++) {
        const f = out[k];
        const a = (ang * k) / n, c = Math.cos(a), s = Math.sin(a);
        const nr = vadd(vmul(f.r, c), vmul(f.u, s));
        f.r = nr; f.u = vcross(f.t, nr);
      }
    }
  }
  return out;
}
/** Sweep a 2D profile (or a function of t returning one) along a path. opts: { frame, up, twist, scale, segments } */
function sweep(profile, p, opts = {}) {
  const frame = opts.frame === undefined ? 'minimal' : opts.frame;
  let up = opts.up;
  const twist = opts.twist === undefined ? 0 : opts.twist;
  const scale = opts.scale === undefined ? 1 : opts.scale;
  const segments = opts.segments === undefined ? 32 : opts.segments;
  if (!isPath(p)) throw new TypeError(`sweep: second argument must be a path, got ${describe(p)}`);
  const varying = typeof profile === 'function';
  if (!varying && !isSketch(profile)) throw new TypeError(`sweep: profile must be a 2D sketch or a function returning one, got ${describe(profile)}`);
  if (frame !== 'minimal' && frame !== 'upright') throw new TypeError(`sweep: frame must be 'minimal' or 'upright', got ${describe(frame)}`);
  if (up !== undefined) { if (!Array.isArray(up) || up.length !== 3) throw new TypeError('sweep: up must be [x, y, z]'); up = vnorm(up.map((v, i) => checkNumber('sweep', `up[${i}]`, v))); }
  checkNumber('sweep', 'twist', twist);
  const sx = Array.isArray(scale) ? scale[0] : scale, sy = Array.isArray(scale) ? scale[1] : scale;
  checkPositive('sweep', 'scale', sx); checkPositive('sweep', 'scale', sy);
  checkInt('sweep', 'segments', segments, 3);
  const points = p.points, closed = p.closed;
  if (closed && points.length < 3) throw new RangeError('sweep: a closed path needs at least 3 points');
  const n = points.length;
  const fr = pathFrames(points, closed, frame, up);
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + vlen(vsub(points[i], points[i - 1])));
  const total = closed ? cum[n - 1] + vlen(vsub(points[0], points[n - 1])) : cum[n - 1];
  const tAt = (i) => cum[i] / total;
  const ringsAt = (i) => {
    const sk = varying ? profile(tAt(i)) : profile;
    if (!isSketch(sk)) throw new TypeError(`sweep: profile(${tAt(i).toFixed(3)}) must return a 2D sketch, got ${describe(sk)}`);
    const polys = sk.toPolygons();
    if (!polys.length) throw new Error('sweep: the profile is empty');
    return varying ? polys.map((ring) => resampleRing(ring, segments)) : polys;
  };
  const first = ringsAt(0);
  const contours = first.length, counts = first.map((r) => r.length);
  let maxR = 0;
  for (const ring of first) for (const q of ring) maxR = Math.max(maxR, Math.hypot(q[0], q[1]));
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const din = fr[i].din, dout = fr[i].dout;
    const cosHalf = vlen(vadd(din, dout)) / 2;
    if (cosHalf > 0.9999) continue;
    const tanHalf = Math.sqrt(Math.max(0, 1 - cosHalf * cosHalf)) / cosHalf;
    const need = maxR * tanHalf;
    const lin = vlen(vsub(points[i], points[(i - 1 + n) % n])), lout = vlen(vsub(points[(i + 1) % n], points[i]));
    if (lin < need - 1e-6 || lout < need - 1e-6) { cad.warn(`sweep: the bend at point ${i} is too tight for the profile (segments of ${Math.min(lin, lout).toFixed(2)} mm, needs ${need.toFixed(2)} mm); the surface may fold into itself`); break; }
  }
  const pos = [];
  const starts = [];
  for (let i = 0; i < n; i++) {
    const rings = i === 0 ? first : ringsAt(i);
    if (rings.length !== contours || rings.some((r, c) => r.length !== counts[c])) throw new Error('sweep: every profile along the path must have the same contours');
    const t = tAt(i);
    const f = fr[i];
    const a = (twist * t * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const fx = 1 + (sx - 1) * t, fy = 1 + (sy - 1) * t;
    const bis = vsub(f.din, f.dout); const bl = vlen(bis);
    const cosHalf = vlen(vadd(f.din, f.dout)) / 2;
    const stretchAxis = bl > 1e-9 && cosHalf > 1e-6 ? vnorm(bis) : null;
    const k = stretchAxis ? 1 / cosHalf - 1 : 0;
    const centre = points[i];
    starts.push(pos.length / 3);
    for (const ring of rings) for (const q0 of ring) {
      const x = (q0[0] * ca - q0[1] * sa) * fx, y = (q0[0] * sa + q0[1] * ca) * fy;
      let q = vadd(vmul(f.r, x), vmul(f.u, y));
      if (stretchAxis) q = vadd(q, vmul(stretchAxis, k * vdot(q, stretchAxis)));
      const w = vadd(centre, q);
      pos.push(w[0], w[1], w[2]);
    }
  }
  const tris = [];
  const offsets = [0];
  for (let c = 0; c < contours; c++) offsets.push(offsets[c] + counts[c]);
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const a = starts[i], b = starts[(i + 1) % n];
    for (let c = 0; c < contours; c++) {
      const o = offsets[c], m = counts[c];
      for (let kk = 0; kk < m; kk++) {
        const k2 = (kk + 1) % m;
        tris.push(a + o + kk, a + o + k2, b + o + k2, a + o + kk, b + o + k2, b + o + kk);
      }
    }
  }
  if (!closed) {
    const last = ringsAt(n - 1);
    for (const t of triangulateRings(first)) tris.push(t[0], t[2], t[1]);
    const top = starts[n - 1];
    for (const t of triangulateRings(last)) tris.push(top + t[0], top + t[1], top + t[2]);
  }
  return new Shape(manifoldFromTriangles('sweep', pos, tris));
}
Q.sweep = function (p, opts) { return sweep(this, p, opts); };

// ---- edge fillets and chamfers (fillet.js) ----------------------------------------------
//
// Every sharp edge of a planar-faced solid gets a prism whose section is the corner minus a
// quarter circle (or a triangle for a chamfer): subtracted on convex edges, added on concave ones,
// mitred against neighbouring edges of the same kind. Concave edges go first and the mesh is read
// again, so a convex fillet that runs into a concave one follows its curve.

const pkey = (p) => p.map((v) => Math.round(v * 1e5)).join(',');

/** The mesh as unique vertices and triangles. */
function readMesh(shape) {
  const m = cad.mesh(shape.h);
  const vp = m.positions, tv = m.triangles;
  const ids = new Map(); const verts = []; const remap = [];
  for (let i = 0; i < vp.length / 3; i++) {
    const p = [vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]];
    const k = pkey(p);
    let id = ids.get(k);
    if (id === undefined) { id = verts.length; ids.set(k, id); verts.push(p); }
    remap.push(id);
  }
  const tris = [];
  for (let i = 0; i < tv.length; i += 3) {
    const t = [remap[tv[i]], remap[tv[i + 1]], remap[tv[i + 2]]];
    if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) tris.push(t);
  }
  return { verts, tris };
}

/** Sharp edges of a solid: straight runs where two planar face groups meet at >= minAngle degrees. */
function sharpEdges(shape, minAngle = 30) {
  checkShape('sharpEdges', 'shape', shape);
  const rm = readMesh(shape);
  const verts = rm.verts, tris = rm.tris;
  const normals = tris.map((t) => vnorm(vcross(vsub(verts[t[1]], verts[t[0]]), vsub(verts[t[2]], verts[t[0]]))));
  const edgeKey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const byEdge = new Map();
  for (let i = 0; i < tris.length; i++) { const t = tris[i]; for (let k = 0; k < 3; k++) { const e = edgeKey(t[k], t[(k + 1) % 3]); const l = byEdge.get(e); if (l) l.push(i); else byEdge.set(e, [i]); } }
  const face = [];
  for (let i = 0; i < tris.length; i++) face.push(-1);
  const faceNormal = [];
  for (let seed = 0; seed < tris.length; seed++) {
    if (face[seed] >= 0 || vlen(normals[seed]) === 0) continue;
    const id = faceNormal.length; faceNormal.push(normals[seed]);
    face[seed] = id; const stack = [seed];
    while (stack.length) {
      const i = stack.pop(); const t = tris[i];
      for (let k = 0; k < 3; k++) for (const j of byEdge.get(edgeKey(t[k], t[(k + 1) % 3]))) {
        if (face[j] < 0 && vdot(normals[j], normals[seed]) > 0.99995) { face[j] = id; stack.push(j); }
      }
    }
  }
  const cosMin = Math.cos((minAngle * Math.PI) / 180);
  const pairs = new Map();
  for (const entry of byEdge) {
    const e = entry[0], list = entry[1];
    if (list.length !== 2) continue;
    const A = face[list[0]], B = face[list[1]];
    if (A === B || A < 0 || B < 0) continue;
    if (vdot(faceNormal[A], faceNormal[B]) > cosMin) continue;
    const lo = Math.min(A, B), hi = Math.max(A, B);
    const pk = lo * 4294967296 + hi;
    const a = Math.floor(e / 4294967296), b = e % 4294967296;
    const g = pairs.get(pk); if (g) g.push([a, b]); else pairs.set(pk, [[a, b]]);
  }
  const out = [];
  for (const entry of pairs) {
    const pk = entry[0], edges = entry[1];
    const A = Math.floor(pk / 4294967296), B = pk % 4294967296;
    const nA = faceNormal[A], nB = faceNormal[B];
    const t = vnorm(vcross(nA, nB));
    const origin = verts[edges[0][0]];
    const param = (v) => vdot(vsub(verts[v], origin), t);
    const ivs = edges.map((ed) => { const pa = param(ed[0]), pb = param(ed[1]); return pa < pb ? [pa, pb, ed[0], ed[1]] : [pb, pa, ed[1], ed[0]]; }).sort((x, y) => x[0] - y[0]);
    let cur = null;
    const runs = [];
    for (const iv of ivs) {
      if (cur && iv[0] <= cur[1] + 1e-6) { if (iv[1] > cur[1]) { cur[1] = iv[1]; cur[3] = iv[3]; } }
      else { cur = iv.slice(); runs.push(cur); }
    }
    let tri = null;
    for (let i = 0; i < tris.length && !tri; i++) if (face[i] === A && tris[i].includes(edges[0][0]) && tris[i].includes(edges[0][1])) tri = tris[i];
    const centroid = vmul(vadd(vadd(verts[tri[0]], verts[tri[1]]), verts[tri[2]]), 1 / 3);
    let a = vcross(nA, t); if (vdot(a, vsub(centroid, origin)) < 0) a = vmul(a, -1);
    const convex = vdot(a, nB) < 0;
    const angle = (Math.acos(Math.max(-1, Math.min(1, vdot(nA, nB)))) * 180) / Math.PI;
    for (const run of runs) {
      if (run[1] - run[0] < 1e-6) continue;
      const p0 = verts[run[2]], p1 = verts[run[3]];
      out.push({ p0, p1, t: vnorm(vsub(p1, p0)), nA, nB, convex, angle, length: run[1] - run[0], faces: [A, B], v0: pkey(p0), v1: pkey(p1) });
    }
  }
  return out;
}

const EDGE_FILTERS = {
  all: () => true,
  convex: (e) => e.convex,
  concave: (e) => !e.convex,
  horizontal: (e) => Math.abs(e.t[1]) < 0.01,
  vertical: (e) => Math.abs(e.t[1]) > 0.99,
  top: (e) => (e.nA[1] > 0.99 && Math.abs(e.nB[1]) < 0.99) || (e.nB[1] > 0.99 && Math.abs(e.nA[1]) < 0.99),
  bottom: (e) => (e.nA[1] < -0.99 && Math.abs(e.nB[1]) < 0.99) || (e.nB[1] < -0.99 && Math.abs(e.nA[1]) < 0.99),
};
function edgeFilter(fn, edges) {
  if (typeof edges === 'function') return edges;
  const names = Array.isArray(edges) ? edges : [edges];
  const fns = names.map((n) => {
    const f = typeof n === 'string' ? EDGE_FILTERS[n] : undefined;
    if (!f) throw new TypeError(`${fn}: edges must be 'all', 'top', 'bottom', 'horizontal', 'vertical', 'convex', 'concave', a list of those, or a function, got ${describe(n)}`);
    return f;
  });
  return (e) => fns.every((f) => f(e));
}
function slerp(a, b, f) {
  const c = Math.max(-1, Math.min(1, vdot(a, b))), w = Math.acos(c);
  if (w < 1e-9) return a;
  return vnorm(vadd(vmul(a, Math.sin((1 - f) * w) / Math.sin(w)), vmul(b, Math.sin(f * w) / Math.sin(w))));
}
/** The section of an edge's cutter (convex) or filler (concave), as offsets from the edge in its normal plane. */
function edgeSection(e, kind, amount, segments, eps) {
  const s = e.convex ? 1 : -1;
  const nA = e.nA, nB = e.nB;
  const c = vdot(nA, nB);
  const pts = [];
  pts.push(vmul(vadd(nA, nB), s * eps));
  let Ta, Tb;
  const inner = [];
  if (kind === 'chamfer') {
    const a = vmul(vnorm(vsub(nB, vmul(nA, c))), -s), b = vmul(vnorm(vsub(nA, vmul(nB, c))), -s);
    Ta = vmul(a, amount); Tb = vmul(b, amount);
  } else {
    const centre = vmul(vadd(nA, nB), (-s * amount) / (1 + c));
    Ta = vadd(centre, vmul(nA, s * amount)); Tb = vadd(centre, vmul(nB, s * amount));
    for (let k = 1; k < segments; k++) inner.push(vadd(centre, vmul(slerp(nA, nB, k / segments), s * amount)));
  }
  pts.push(vadd(Ta, vmul(nA, s * eps)), Ta);
  for (const q of inner) pts.push(q);
  pts.push(Tb, vadd(Tb, vmul(nB, s * eps)));
  return pts;
}
/** Planes (unit normals through the end vertex) that trim one end of an edge's prism. */
function endPlanes(e, atEnd, edges) {
  const v = atEnd ? e.v1 : e.v0;
  const planes = [];
  for (const o of edges) {
    if (o === e || o.convex !== e.convex) continue;
    if (!o.faces.some((f) => e.faces.includes(f))) continue;
    let to;
    if (atEnd) { if (o.v0 === v) to = o.t; else if (o.v1 === v) to = vmul(o.t, -1); else continue; }
    else { if (o.v1 === v) to = o.t; else if (o.v0 === v) to = vmul(o.t, -1); else continue; }
    const n = vnorm(atEnd ? vadd(e.t, to) : vadd(to, e.t));
    if (vlen(n) > 1e-6 && Math.abs(vdot(n, e.t)) > 0.05) planes.push(n);
  }
  if (!planes.length) planes.push(e.t);
  return planes;
}
function ringAt(sec, t, station, planes, pickMax) {
  return sec.map((q) => {
    let best = pickMax ? -Infinity : Infinity;
    for (const n of planes) { const l = -vdot(q, n) / vdot(t, n); best = pickMax ? Math.max(best, l) : Math.min(best, l); }
    return vadd(vadd(station, q), vmul(t, best));
  });
}
const orientEdge = (e, v) => (e.v0 === v ? e : Object.assign({}, e, { p0: e.p1, p1: e.p0, v0: e.v1, v1: e.v0, t: vmul(e.t, -1) }));
const sharedFace = (a, b) => a.faces.find((f) => b.faces.includes(f));
/** Group edges of one kind into chains: [{ edges (oriented head to tail), face, closed }]. */
function edgeChains(edges) {
  for (let i = 0; i < edges.length; i++) edges[i].id = i;
  const at = new Map();
  for (const e of edges) for (const v of [e.v0, e.v1]) { const l = at.get(v); if (l) l.push(e); else at.set(v, [e]); }
  const nextOf = (e, v) => { const c = (at.get(v) || []).filter((o) => o.id !== e.id && sharedFace(e, o) !== undefined); return c.length === 1 ? c[0] : null; };
  const used = new Set(), out = [];
  for (const start of edges) {
    if (used.has(start.id)) continue;
    let head = start, v = start.v0, closed = false;
    const back = new Set([start.id]);
    for (;;) {
      const p = nextOf(head, v);
      if (!p) break;
      if (p.id === start.id) { closed = true; break; }
      if (back.has(p.id)) break;
      back.add(p.id); v = p.v0 === v ? p.v1 : p.v0; head = p;
    }
    let cur = closed ? orientEdge(start, start.v0) : orientEdge(head, v);
    let chain = [cur], face = null;
    used.add(cur.id);
    for (;;) {
      const n = nextOf(cur, cur.v1);
      if (!n || used.has(n.id)) break;
      const f = sharedFace(cur, n);
      if (face === null) face = f;
      if (f !== face) { out.push({ edges: chain, face, closed: false }); chain = []; face = f; }
      const o = orientEdge(n, cur.v1);
      chain.push(o); used.add(n.id); cur = o;
    }
    const loop = closed && chain.length >= 3 && chain[chain.length - 1].v1 === chain[0].v0 && sharedFace(chain[chain.length - 1], chain[0]) === face;
    out.push({ edges: chain, face: face === null ? chain[0].faces[0] : face, closed: loop });
  }
  return out;
}
/** One continuous skin along a chain of edges: sections at every vertex, mitred, capped at open ends. */
function chainMesh(ch, kind, amount, segments, eps, all) {
  const chain = ch.edges, face = ch.face, closed = ch.closed;
  const k = chain.length;
  const secs = chain.map((e) => edgeSection(e.faces[0] === face ? e : Object.assign({}, e, { nA: e.nB, nB: e.nA }), kind, amount, segments, eps));
  const n = secs[0].length;
  const rings = [];
  const stations = closed ? k : k + 1;
  for (let i = 0; i < stations; i++) {
    const ein = chain[(i - 1 + k) % k], eout = chain[i % k];
    const station = i < k ? eout.p0 : ein.p1;
    if (!closed && i === 0) rings.push(ringAt(secs[0], eout.t, station, endPlanes(eout, false, all), false));
    else if (!closed && i === k) rings.push(ringAt(secs[k - 1], ein.t, station, endPlanes(ein, true, all), true));
    else {
      let nb = vnorm(vadd(ein.t, eout.t));
      if (vlen(nb) < 1e-6 || Math.abs(vdot(nb, ein.t)) < 0.05) nb = ein.t;
      rings.push(ringAt(secs[(i - 1 + k) % k], ein.t, station, [nb], true));
    }
  }
  const pos = [];
  for (const ring of rings) for (const p of ring) pos.push(p[0], p[1], p[2]);
  const tris = [];
  for (let i = 0; i < k; i++) {
    const a = i * n, b = ((i + 1) % rings.length) * n;
    for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; tris.push(a + j, a + j2, b + j2, a + j, b + j2, b + j); }
  }
  if (!closed) {
    const cap = (sec, e) => { const e1 = e.faces[0] === face ? e.nA : e.nB, e2 = vcross(e.t, e1); return triangulateRings([sec.map((q) => [vdot(q, e1), vdot(q, e2)])]); };
    for (const t of cap(secs[0], chain[0])) tris.push(t[0], t[2], t[1]);
    const top = k * n;
    for (const t of cap(secs[k - 1], chain[k - 1])) tris.push(top + t[0], top + t[1], top + t[2]);
  }
  return manifoldFromTriangles('fillet', pos, tris);
}
function filletPass(shape, kind, amount, o, concavePass) {
  const all = sharpEdges(shape, o.minAngle);
  const chosen = all.filter((e) => o.want(e) && !e.convex === concavePass);
  if (!chosen.length) return { shape, count: 0 };
  const parts = [];
  const edges = chosen.filter((e) => e.length >= amount * 0.05);
  for (const c of edgeChains(edges)) {
    try { parts.push(chainMesh(c, kind, amount, o.segments, o.eps, edges)); }
    catch (err) { cad.warn(`${kind}: skipped ${c.edges.length} edge${c.edges.length === 1 ? '' : 's'} (${err.message})`); }
  }
  if (!parts.length) return { shape, count: 0 };
  const tool = parts.length === 1 ? parts[0] : cad.batch(parts, 0);
  const h = concavePass ? cad.boolean(shape.h, tool, 0) : cad.boolean(shape.h, tool, 1);
  return { shape: wrap(shape, h), count: parts.length };
}
/** Round (fillet) or bevel (chamfer) the sharp edges of a solid with planar faces. opts: { edges, segments=8, minAngle=30 } */
function filletEdges(kind, shape, amount, opts = {}) {
  const edges = opts.edges === undefined ? 'all' : opts.edges;
  const segments = opts.segments === undefined ? 8 : opts.segments;
  const minAngle = opts.minAngle === undefined ? 30 : opts.minAngle;
  if (!isShape(shape)) throw new TypeError(`${kind}: expected a Shape, got ${describe(shape)}`);
  checkPositive(kind, kind === 'fillet' ? 'radius' : 'distance', amount);
  checkInt(kind, 'segments', segments, 1);
  const want = edgeFilter(kind, edges);
  const o = { want, segments, minAngle, eps: Math.max(amount * 0.02, 1e-3) };
  let r = filletPass(shape, kind, amount, o, true);
  r = filletPass(r.shape, kind, amount, o, false);
  return r.shape;
}
const fillet = (shape, r, opts) => (isShape(shape) ? filletEdges('fillet', shape, r, opts) : isSketch(shape) ? shape.fillet(r, opts) : filletEdges('fillet', shape, r, opts));
const chamfer = (shape, d, opts) => (isShape(shape) ? filletEdges('chamfer', shape, d, opts) : isSketch(shape) ? shape.chamfer(d, opts) : filletEdges('chamfer', shape, d, opts));
P.fillet = function (r, opts) { return filletEdges('fillet', this, r, opts); };
P.chamfer = function (d, opts) { return filletEdges('chamfer', this, d, opts); };

// ---- lettering on a face (emboss.js) ---------------------------------------------------------
//
// The sketch is laid on the face so it reads correctly from outside: on top as a drawing seen from
// above; on the sides upright with x to the viewer's right; on the bottom seen from below.

const LAY = { top: [0, 0, 0], bottom: [180, 0, 0], front: [90, 0, 0], back: [90, 180, 0], right: [90, 90, 0], left: [90, -90, 0] };
const LETTER_OVERLAP = 0.01;
function toLetterSketch(fn, what, opts) {
  if (isSketch(what)) return what;
  if (typeof what === 'string') return text(what, { size: opts.size === undefined ? 6 : opts.size, font: opts.font, align: opts.align === undefined ? 'center' : opts.align });
  throw new TypeError(`${fn}: expected a 2D sketch or a string, got ${describe(what)}`);
}
/** The solid of the lettering, placed on the target: from -below to +above along the normal. */
function lettering(fn, what, target, opts, below, above) {
  const depth = opts.depth === undefined ? 1 : opts.depth;
  const at = opts.at === undefined ? [0, 0] : opts.at;
  const angle = opts.angle === undefined ? 0 : opts.angle;
  const center = opts.center === undefined ? true : opts.center;
  checkPositive(fn, 'depth', depth); checkNumber(fn, 'angle', angle);
  let sk = toLetterSketch(fn, what, opts);
  if (center) sk = sk.center();
  if (angle) sk = sk.rotate(angle);
  let solid = extrude(sk, below + above).translate(0, -below, 0);
  let point, rot;
  if (isFace(target)) { rot = LAY[target.name]; point = target.point(at); }
  else if (isAnchor(target)) { rot = rotationToward(target.normal === null ? [0, 1, 0] : target.normal); point = target.point.map((v, k) => v + (Array.isArray(at) && at.length === 3 ? at[k] : 0)); }
  else throw new TypeError(`${fn}: expected a face (shape.face('top')) or an anchor, got ${describe(target)}`);
  if (rot[0] || rot[1] || rot[2]) solid = solid.rotate(rot[0], rot[1], rot[2]);
  return solid.translate(point[0], point[1], point[2]);
}
/** Raise a sketch or text out of a face by depth. */
function emboss(shape, what, target, opts = {}) {
  if (!isShape(shape)) throw new TypeError(`emboss: expected a Shape, got ${describe(shape)}`);
  const d = opts.depth === undefined ? 1 : opts.depth;
  return shape.add(lettering('emboss', what, target, Object.assign({}, opts, { depth: d }), LETTER_OVERLAP, d));
}
/** Cut a sketch or text into a face by depth. */
function engrave(shape, what, target, opts = {}) {
  if (!isShape(shape)) throw new TypeError(`engrave: expected a Shape, got ${describe(shape)}`);
  const d = opts.depth === undefined ? 1 : opts.depth;
  return shape.subtract(lettering('engrave', what, target, Object.assign({}, opts, { depth: d }), d, LETTER_OVERLAP));
}
P.emboss = function (what, target, opts) { return emboss(this, what, target, opts); };
P.engrave = function (what, target, opts) { return engrave(this, what, target, opts); };

// ---- images and reliefs (image.js) -----------------------------------------------------------
//
// `import photo from './photo.png'` gives a GrayImage: width, height and one brightness per pixel
// (0 black .. 1 white, transparency composited onto white). heightmap() makes a relief, lithophane()
// a plate whose thickness follows the picture.

function GrayImage(width, height, gray) { this.width = width; this.height = height; this.gray = gray; Object.freeze(this); }
function isImage(v) { return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === GrayImage.prototype; }
function imageFromFunction(width, height, fn) {
  const gray = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray.push(fn(x, y));
  return new GrayImage(width, height, gray);
}
// (the app's GrayImage.fromFunction static stays internal: lamassu does not allow properties on function values)
const G = GrayImage.prototype;
G.at = function (x, y) {
  x = Math.min(this.width - 1, Math.max(0, x)); y = Math.min(this.height - 1, Math.max(0, y));
  return this.gray[y * this.width + x];
};
G.sample = function (x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const a = this.at(x0, y0), b = this.at(x0 + 1, y0), c = this.at(x0, y0 + 1), d = this.at(x0 + 1, y0 + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
};
// The app keeps brightness in Float32Array; every derived value is rounded to float32 the same way.
const f32 = Math.fround;
G.invert = function () { return new GrayImage(this.width, this.height, this.gray.map((v) => f32(1 - v))); };
G.gamma = function (g = 1) { checkPositive('gamma', 'gamma', g); return new GrayImage(this.width, this.height, this.gray.map((v) => f32(Math.pow(v, g)))); };
G.normalize = function () {
  let lo = Infinity, hi = -Infinity;
  for (const v of this.gray) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const r = hi - lo || 1;
  return new GrayImage(this.width, this.height, this.gray.map((v) => f32((v - lo) / r)));
};
G.blur = function (radius = 1) {
  checkInt('blur', 'radius', radius, 0);
  if (radius === 0) return this;
  const w = this.width, h = this.height;
  const pass = (src) => {
    const tmp = [], out = [];
    for (let i = 0; i < src.length; i++) { tmp.push(0); out.push(0); }
    const n = 2 * radius + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[y * w + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = f32(acc / n);
        acc += src[y * w + Math.min(w - 1, x + radius + 1)] - src[y * w + Math.max(0, x - radius)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = f32(acc / n);
        acc += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
      }
    }
    return out;
  };
  return new GrayImage(w, h, pass(pass(this.gray)));
};
G.crop = function (x, y, w, h) {
  checkInt('crop', 'x', x, 0); checkInt('crop', 'y', y, 0); checkInt('crop', 'width', w, 1); checkInt('crop', 'height', h, 1);
  if (x + w > this.width || y + h > this.height) throw new RangeError(`crop: the rectangle leaves the image (${this.width}×${this.height})`);
  const gray = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) gray.push(this.gray[(y + j) * this.width + x + i]);
  return new GrayImage(w, h, gray);
};
G.resize = function (width, height) {
  if (height === undefined) height = Math.max(1, Math.round((width * this.height) / this.width));
  checkInt('resize', 'width', width, 1); checkInt('resize', 'height', height, 1);
  const gray = [];
  const sx = this.width / width, sy = this.height / height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray.push(f32(this.sample((x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5)));
  return new GrayImage(width, height, gray);
};
G.flip = function (axis = 'x') {
  const w = this.width, h = this.height;
  const gray = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray.push(axis === 'x' ? this.gray[y * w + (w - 1 - x)] : this.gray[(h - 1 - y) * w + x]);
  return new GrayImage(w, h, gray);
};
G.toString = function () { return `GrayImage(${this.width}×${this.height})`; };

function checkImage(fn, img) {
  if (typeof img === 'function') return img;
  if (!isImage(img)) throw new TypeError(`${fn}: expected an imported image (import photo from './photo.png') or a function (x, z) => 0..1, got ${describe(img)}`);
  return img;
}
/** A relief plate whose top rises with the image's brightness. opts: { width=50, depth, height=5, base=1, invert, smooth=0, gamma=1, resolution=200, center=true } */
function heightmap(img, opts = {}) {
  const width = opts.width === undefined ? 50 : opts.width;
  let depth = opts.depth;
  const height = opts.height === undefined ? 5 : opts.height;
  const base = opts.base === undefined ? 1 : opts.base;
  const invert = !!opts.invert;
  const smooth = opts.smooth === undefined ? 0 : opts.smooth;
  const gamma = opts.gamma === undefined ? 1 : opts.gamma;
  const resolution = opts.resolution === undefined ? 200 : opts.resolution;
  const center = opts.center === undefined ? true : opts.center;
  const src = checkImage('heightmap', img);
  checkPositive('heightmap', 'width', width); checkNonNegative('heightmap', 'height', height); checkPositive('heightmap', 'base', base);
  checkInt('heightmap', 'resolution', resolution, 2); checkInt('heightmap', 'smooth', smooth, 0); checkPositive('heightmap', 'gamma', gamma);
  const isFn = typeof src === 'function';
  if (depth === undefined) depth = isFn ? width : (width * src.height) / src.width;
  checkPositive('heightmap', 'depth', depth);
  const nx = Math.min(resolution, isFn ? resolution : Math.max(2, src.width));
  const nz = Math.max(2, Math.round((nx * depth) / width));
  let image = isFn ? imageFromFunction(nx, nz, (i, j) => {
    const v = src((i / (nx - 1) - (center ? 0.5 : 0)) * width, (j / (nz - 1) - (center ? 0.5 : 0)) * depth);
    return f32(checkNumber('heightmap', 'function value', v));
  }) : src.resize(nx, nz);
  if (smooth) image = image.blur(smooth);
  if (gamma !== 1) image = image.gamma(gamma);
  if (invert) image = image.invert();
  const x0 = center ? -width / 2 : 0, z0 = center ? -depth / 2 : 0;
  const pos = [];
  const top = (i, j) => j * nx + i, bottom = (i, j) => nx * nz + j * nx + i;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const v = Math.min(1, Math.max(0, image.gray[j * nx + i]));
    pos.push(x0 + (i / (nx - 1)) * width, base + v * height, z0 + (j / (nz - 1)) * depth);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) pos.push(x0 + (i / (nx - 1)) * width, 0, z0 + (j / (nz - 1)) * depth);
  const tris = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    tris.push(top(i, j), top(i, j + 1), top(i + 1, j + 1), top(i, j), top(i + 1, j + 1), top(i + 1, j));
    tris.push(bottom(i, j), bottom(i + 1, j + 1), bottom(i, j + 1), bottom(i, j), bottom(i + 1, j), bottom(i + 1, j + 1));
  }
  for (let i = 0; i < nx - 1; i++) {
    tris.push(top(i, 0), top(i + 1, 0), bottom(i + 1, 0), top(i, 0), bottom(i + 1, 0), bottom(i, 0));
    tris.push(top(i, nz - 1), bottom(i + 1, nz - 1), top(i + 1, nz - 1), top(i, nz - 1), bottom(i, nz - 1), bottom(i + 1, nz - 1));
  }
  for (let j = 0; j < nz - 1; j++) {
    tris.push(top(0, j), bottom(0, j + 1), top(0, j + 1), top(0, j), bottom(0, j), bottom(0, j + 1));
    tris.push(top(nx - 1, j), top(nx - 1, j + 1), bottom(nx - 1, j + 1), top(nx - 1, j), bottom(nx - 1, j + 1), bottom(nx - 1, j));
  }
  return new Shape(manifoldFromTriangles('heightmap', pos, tris));
}
/** Positions and triangles of a box centred in X and Z with its base at y = 0. */
function boxMesh(w, h, dd) {
  const pos = [];
  for (const y of [0, h]) for (const c of [[-w / 2, -dd / 2], [w / 2, -dd / 2], [w / 2, dd / 2], [-w / 2, dd / 2]]) pos.push(c[0], y, c[1]);
  const tris = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return [pos, tris];
}
/** A lithophane: thick where dark, thin where light. opts: { width=80, depth, minThickness=0.8, maxThickness=3, border=0, smooth=1, gamma=1, resolution=300, upright=false } */
function lithophane(img, opts = {}) {
  const width = opts.width === undefined ? 80 : opts.width;
  const minThickness = opts.minThickness === undefined ? 0.8 : opts.minThickness;
  const maxThickness = opts.maxThickness === undefined ? 3 : opts.maxThickness;
  const border = opts.border === undefined ? 0 : opts.border;
  const smooth = opts.smooth === undefined ? 1 : opts.smooth;
  const gamma = opts.gamma === undefined ? 1 : opts.gamma;
  const resolution = opts.resolution === undefined ? 300 : opts.resolution;
  const upright = !!opts.upright;
  const src = checkImage('lithophane', img);
  checkPositive('lithophane', 'width', width); checkPositive('lithophane', 'minThickness', minThickness); checkPositive('lithophane', 'maxThickness', maxThickness);
  checkNonNegative('lithophane', 'border', border);
  if (maxThickness <= minThickness) throw new RangeError('lithophane: maxThickness must be greater than minThickness');
  const d = opts.depth !== undefined ? opts.depth : typeof src === 'function' ? width : (width * src.height) / src.width;
  let s = heightmap(src, { width, depth: d, height: maxThickness - minThickness, base: minThickness, invert: true, smooth, gamma, resolution });
  if (border > 0) {
    const outer = boxMesh(width + 2 * border, maxThickness, d + 2 * border), inner = boxMesh(width, maxThickness + 2, d);
    const frame = new Shape(manifoldFromTriangles('lithophane', outer[0], outer[1])).subtract(new Shape(manifoldFromTriangles('lithophane', inner[0], inner[1])));
    s = s.add(frame);
  }
  return upright ? s.rotate(90, 0, 0).translate(0, d / 2 + border, 0) : s;
}
/** `import photo from './photo.png'` evaluates to this. */
function __temenImage(name) {
  const d = cad.decodeImage(name);
  return new GrayImage(d.width, d.height, d.gray);
}
/** `import part from './part.stl'` evaluates to this: the mesh as a Shape, Z-up converted to Y-up. */
function __temenMesh(name) {
  const m = cad.parseSTL(name);
  if (!m.triangles.length) throw new Error(`${name}: the mesh has no triangles`);
  return new Shape(manifoldFromTriangles(name, m.positions, m.triangles));
}

// ---- printability (print.js) -------------------------------------------------------------------
//
// Checks on the mesh a shape exports; y = 0 is the plate, +Y is up.

/** Triangles of a mesh as { a, b, c, n (unit), area, centroid }. */
function meshTriangles(positions, indices) {
  const P = positions, I = indices, out = [];
  const n = I.length / 3;
  for (let t = 0; t < n; t++) {
    const ia = I[t * 3] * 3, ib = I[t * 3 + 1] * 3, ic = I[t * 3 + 2] * 3;
    const a = [P[ia], P[ia + 1], P[ia + 2]], b = [P[ib], P[ib + 1], P[ib + 2]], c = [P[ic], P[ic + 1], P[ic + 2]];
    const cr = vcross(vsub(b, a), vsub(c, a)), l = vlen(cr);
    if (l < 1e-12) continue;
    out.push({ a, b, c, n: [cr[0] / l, cr[1] / l, cr[2] / l], area: l / 2, centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
  }
  return out;
}
/** Volume, surface area, centre of mass and bounds of a closed mesh. */
function meshStats(positions, indices) {
  const tris = meshTriangles(positions, indices);
  let vol = 0, area = 0; const cm = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    const v = vdot(t.a, vcross(t.b, t.c)) / 6;
    vol += v; area += t.area;
    for (let k = 0; k < 3; k++) cm[k] += (v * (t.a[k] + t.b[k] + t.c[k])) / 4;
    for (const p of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  }
  const centerOfMass = Math.abs(vol) > 1e-12 ? cm.map((v) => v / vol) : [0, 0, 0];
  return { volume: Math.abs(vol), surfaceArea: area, centerOfMass, bounds: { min, max, size: vsub(max, min), center: min.map((v, k) => (v + max[k]) / 2) } };
}
/** Distance along a ray to the first triangle hit, skipping hits closer than `skip`. */
function rayDistance(o, d, tris, skip = 1e-4) {
  let best = Infinity;
  for (const t of tris) {
    const e1 = vsub(t.b, t.a), e2 = vsub(t.c, t.a);
    const p = vcross(d, e2), det = vdot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det, s = vsub(o, t.a);
    const u = vdot(s, p) * inv; if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q = vcross(s, e1);
    const v = vdot(d, q) * inv; if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const dist = vdot(e2, q) * inv;
    if (dist > skip && dist < best) best = dist;
  }
  return best;
}
const FIRST_LAYER = 0.3;
/** Faces whose underside slopes more than `angle` degrees from vertical, ignoring the first layer on the plate. */
function overhangFaces(positions, indices, angle = 45, plateY = 0) {
  const limit = Math.sin((angle * Math.PI) / 180) + 1e-6;
  const out = [];
  for (const t of meshTriangles(positions, indices)) {
    if (t.n[1] >= 0 || -t.n[1] < limit) continue;
    if (t.a[1] <= plateY + FIRST_LAYER && t.b[1] <= plateY + FIRST_LAYER && t.c[1] <= plateY + FIRST_LAYER) continue;
    out.push(Object.assign({}, t, { angle: (Math.asin(Math.min(1, -t.n[1])) * 180) / Math.PI }));
  }
  return out;
}
function meshOf(fn, s) { checkShape(fn, 'shape', s); const m = cad.mesh(s.h); return { positions: m.positions, indices: m.triangles }; }
function summarise(faces) {
  let area = 0, worst = 0, lowest = Infinity;
  for (const f of faces) { area += f.area; if (f.angle > worst) worst = f.angle; if (f.centroid[1] < lowest) lowest = f.centroid[1]; }
  return { area, worstAngle: worst, lowest: faces.length ? lowest : null, faces: faces.length };
}
/** Overhangs of a shape: { area, worstAngle, lowest, faces } for faces steeper than angle (default 45). */
function overhangs(s, opts = {}) {
  const angle = opts.angle === undefined ? 45 : opts.angle;
  checkNumber('overhangs', 'angle', angle);
  const m = meshOf('overhangs', s);
  return summarise(overhangFaces(m.positions, m.indices, angle));
}
/** Overhangs with nothing of the shape beneath them: islands and bridges. */
function unsupported(s, opts = {}) {
  const angle = opts.angle === undefined ? 45 : opts.angle;
  checkNumber('unsupported', 'angle', angle);
  const m = meshOf('unsupported', s);
  const all = meshTriangles(m.positions, m.indices);
  const faces = overhangFaces(m.positions, m.indices, angle).filter((f) => !Number.isFinite(rayDistance(f.centroid, [0, -1, 0], all)) && f.centroid[1] > FIRST_LAYER);
  return summarise(faces);
}
/** The thinnest wall, by casting rays inward from a sample of faces: { thickness, at }. */
function minWallThickness(s, opts = {}) {
  const samples = opts.samples === undefined ? 600 : opts.samples;
  checkPositive('minWallThickness', 'samples', samples);
  const m = meshOf('minWallThickness', s);
  const all = meshTriangles(m.positions, m.indices);
  let total = 0;
  for (const t of all) total += t.area;
  const faces = all.filter((t) => t.area >= Math.min(0.02, total / 1e5));
  const picked = [];
  if (faces.length <= samples) { for (const f of faces) picked.push(f); }
  else {
    const per = samples / total; let acc = 0;
    for (const t of faces) { acc += t.area * per; while (acc >= 1 && picked.length < samples) { acc -= 1; picked.push(t); } }
    for (let i = 0; picked.length < samples && i < faces.length; i += Math.ceil(faces.length / samples)) picked.push(faces[i]);
  }
  let best = Infinity, at = null;
  for (const t of picked) {
    const d = rayDistance(t.centroid, [-t.n[0], -t.n[1], -t.n[2]], all, 0.05);
    if (d < best) { best = d; at = t.centroid; }
  }
  return { thickness: best, at };
}
/** A printing verdict: overhang and unsupported areas, the thinnest wall, and the problems found. opts: { angle=45, minWall=0.8, maxUnsupported=1 } */
function printability(s, opts = {}) {
  const angle = opts.angle === undefined ? 45 : opts.angle;
  const minWall = opts.minWall === undefined ? 0.8 : opts.minWall;
  const maxUnsupported = opts.maxUnsupported === undefined ? 1 : opts.maxUnsupported;
  const over = overhangs(s, { angle }), un = unsupported(s, { angle }), wall = minWallThickness(s);
  const m = meshOf('printability', s);
  const bounds = meshStats(m.positions, m.indices).bounds;
  const problems = [];
  if (bounds.min[1] < -1e-4) problems.push(`sits ${(-bounds.min[1]).toFixed(2)} mm below the plate (y = 0); use .onPlate()`);
  if (un.area > maxUnsupported) problems.push(`${un.area.toFixed(1)} mm² of unsupported faces (islands or bridges) with nothing below; lowest at y = ${un.lowest.toFixed(1)}`);
  if (over.area > maxUnsupported) problems.push(`${over.area.toFixed(1)} mm² of overhangs steeper than ${angle}° (worst ${over.worstAngle.toFixed(0)}°); needs supports or a redesign`);
  if (wall.thickness < minWall) problems.push(`thinnest wall ${wall.thickness.toFixed(2)} mm at [${wall.at.map((v) => v.toFixed(1)).join(', ')}], under ${minWall} mm`);
  return { ok: problems.length === 0, problems, overhangs: over, unsupported: un, minWall: wall, bounds };
}
P.overhangs = function (o) { return overhangs(this, o); };
P.unsupported = function (o) { return unsupported(this, o); };
P.minWallThickness = function (o) { return minWallThickness(this, o); };
P.printability = function (o) { return printability(this, o); };

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
  union2d, difference2d, intersect2d, hull2d, extrude, revolve, projection, sketch, SketchBuilder, text, text3d, emboss, engrave,
  SCREWS, screw, screwHole, nutPocket, heatInsert, hole,
  Path, path, line, arc, helix, bezier, sweep, polyhedron, loft, fillet, chamfer, sharpEdges,
  GrayImage, heightmap, lithophane, __temenImage, __temenMesh,
  overhangs, unsupported, minWallThickness, printability,
  Face, distance, rectPattern, gridPattern, intersects, interference, overlap, clearance, dimension, mark,
  printer, printProfile, wall, layers, fit, peg, FITS,
  deg, rad, log, print: log, echo, assert, show,
};
