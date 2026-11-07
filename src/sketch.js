import { M, track } from './engine.js';
import { Shape, Z_TO_Y, describe, checkNumber, checkPositive, checkNonNegative, checkInt, resizeFactors } from './shape.js';
import { textOutlines } from './fonts.js';

/*
 * 2D sketches live on the ground plane. Sketch x maps to world X and sketch y
 * maps to world -Z, so a sketch viewed from above (+Y) looks like a normal
 * 2D drawing. Extrusions go up along +Y; revolves spin around the Y axis.
 * (Manifold builds along Z; Z_TO_Y rotates the result into our frame.)
 */

const CS = () => M().CrossSection;
const JOIN = { round: 'Round', miter: 'Miter', square: 'Square' };

function checkPoints(points, fn) {
  if (!Array.isArray(points) || points.length < 3) throw new TypeError(`${fn}: need an array of at least 3 [x, y] points, got ${describe(points)}`);
  return points.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) throw new TypeError(`${fn}: point ${i} must be [x, y], got ${describe(p)}`);
    return [checkNumber(fn, `point ${i} x`, p[0]), checkNumber(fn, `point ${i} y`, p[1])];
  });
}

/** A 2D region (multi-polygon with holes). Immutable; every op returns a new Sketch. */
export class Sketch {
  constructor(cs) { this.cs = track(cs); }

  static fromPoints(points, fn = 'polygon2d') {
    return new Sketch(new (CS())([checkPoints(points, fn)], 'EvenOdd'));
  }

  _wrap(cs) { return new Sketch(cs); }

  translate(x = 0, y = 0) {
    if (Array.isArray(x)) [x, y = 0] = x;
    checkNumber('translate', 'x', x); checkNumber('translate', 'y', y);
    return this._wrap(this.cs.translate([x, y]));
  }
  rotate(degrees = 0) { checkNumber('rotate', 'degrees', degrees); return this._wrap(this.cs.rotate(degrees)); }
  scale(x = 1, y = x) {
    checkNumber('scale', 'x', x); checkNumber('scale', 'y', y);
    if (x === 0 || y === 0) throw new RangeError('scale: factors must not be 0');
    return this._wrap(this.cs.scale([x, y]));
  }
  /** Scale so the bounding box becomes [w, h]; 0 keeps an axis, or scales it proportionally with { auto: true }. */
  resize(x, y = 0, opts = {}) {
    if (Array.isArray(x)) { opts = (y && typeof y === 'object') ? y : {}; [x, y = 0] = x; }
    const f = resizeFactors('resize', this.bounds().size, [x, y], !!opts.auto);
    return this.scale(...f);
  }
  mirror(axis = 'x') {
    const n = { x: [1, 0], y: [0, 1] }[axis];
    if (!n) throw new Error(`mirror: axis must be 'x' or 'y'`);
    return this._wrap(this.cs.mirror(n));
  }

  add(...o) { return union2d(this, ...o); }
  union(...o) { return union2d(this, ...o); }
  subtract(...o) { return difference2d(this, ...o); }
  intersect(...o) { return intersect2d(this, ...o); }
  hull(...o) { return hull2d(this, ...o); }

  /**
   * Grow (positive) or shrink (negative) the region by `delta`.
   * opts: { join: 'round' | 'miter' | 'square', segments }
   */
  offset(delta = 1, { join = 'round', segments = 16 } = {}) {
    checkNumber('offset', 'delta', delta);
    const j = JOIN[join];
    if (!j) throw new TypeError(`offset: join must be 'round', 'miter' or 'square', got ${describe(join)}`);
    return this._wrap(this.cs.offset(delta, j, 2, segments));
  }

  /** Round every corner with radius r (clamped so adjacent corners never overlap). */
  fillet(r = 1, { segments = 8 } = {}) {
    checkPositive('fillet', 'radius', r); checkInt('fillet', 'segments', segments, 1);
    return this._wrap(new (CS())(this.toPolygons().map((ring) => processCorners(ring, r, segments)), 'Positive'));
  }
  /** Cut every corner back by distance d along both edges. */
  chamfer(d = 1) {
    checkPositive('chamfer', 'distance', d);
    return this._wrap(new (CS())(this.toPolygons().map((ring) => processCorners(ring, d, 0)), 'Positive'));
  }

  bounds() {
    const { min, max } = this.cs.bounds();
    return { min: [...min], max: [...max], size: [max[0] - min[0], max[1] - min[1]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] };
  }
  center() { const c = this.bounds().center; return this.translate(-c[0], -c[1]); }
  area() { return this.cs.area(); }
  isEmpty() { return this.cs.isEmpty(); }
  /** Outline(s) as arrays of [x, y]. */
  toPolygons() { return this.cs.toPolygons(); }

  extrude(h, opts) { return extrude(this, h, opts); }
  revolve(opts) { return revolve(this, opts); }
}

function sketches(fn, list) {
  const out = list.flat(Infinity).map((s) => {
    if (!(s instanceof Sketch)) throw new TypeError(`${fn}: arguments must be 2D sketches, got ${describe(s)}`);
    return s.cs;
  });
  if (!out.length) throw new TypeError(`${fn}: needs at least one sketch`);
  return out;
}
export function union2d(...s) { return new Sketch(CS().union(sketches('union', s))); }
export function difference2d(...s) { return new Sketch(CS().difference(sketches('difference', s))); }
export function intersect2d(...s) { return new Sketch(CS().intersection(sketches('intersect', s))); }
export function hull2d(...s) { return new Sketch(CS().hull(sketches('hull', s))); }

/**
 * Replace each corner of a ring with a chamfer (segments = 0) or an arc.
 * `amount` is the chamfer leg length or the fillet radius.
 */
function processCorners(ring, amount, segments) {
  const n = ring.length;
  if (n < 3) return ring;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i + n - 1) % n], p1 = ring[i], p2 = ring[(i + 1) % n];
    const e1 = [p0[0] - p1[0], p0[1] - p1[1]], e2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    if (l1 < 1e-12 || l2 < 1e-12) { out.push(p1); continue; }
    const u1 = [e1[0] / l1, e1[1] / l1], u2 = [e2[0] / l2, e2[1] / l2];
    const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const theta = Math.acos(cos); // angle between the two edges at this corner
    if (theta > Math.PI - 1e-6 || theta < 1e-6) { out.push(p1); continue; } // straight or spike
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

/**
 * Text as a 2D sketch, baseline on y = 0, starting at x = 0.
 * opts: { size=10 (em height in mm; capitals ≈ 0.73 × size), font='Inter', align='left'|'center'|'right',
 *         letterSpacing=0 (em fraction), kerning=true, curveSegments=8 }
 */
export function text(str, opts = {}) {
  if (typeof str !== 'string') throw new TypeError(`text: first argument must be a string, got ${describe(str)}`);
  if (opts.size !== undefined) checkPositive('text', 'size', opts.size);
  if (opts.align !== undefined && !['left', 'center', 'right'].includes(opts.align)) throw new TypeError(`text: align must be 'left', 'center' or 'right', got ${describe(opts.align)}`);
  const { rings } = textOutlines(str, opts);
  if (!rings.length) return new Sketch(new (CS())([], 'NonZero'));
  // Font contours use non-zero winding (holes run the opposite way).
  return new Sketch(new (CS())(rings, 'NonZero'));
}

/** Text extruded to `height` (mm). Same opts as text(), plus { height=1 }. */
export function text3d(str, { height = 1, ...opts } = {}) {
  checkPositive('text3d', 'height', height);
  return extrude(text(str, opts), height);
}

// ---------- 2D primitives ----------

export function circle(r = 1, { segments = 48 } = {}) {
  if (typeof r === 'object') ({ r = 1, segments = 48 } = r);
  checkPositive('circle', 'radius', r); checkInt('circle', 'segments', segments, 3);
  return new Sketch(CS().circle(r, segments));
}
export function ellipse(rx = 1, ry = 0.5, { segments = 48 } = {}) {
  checkPositive('ellipse', 'rx', rx); checkPositive('ellipse', 'ry', ry);
  return circle(1, { segments }).scale(rx, ry);
}

export function rect(w = 1, h = w, { center = true } = {}) {
  checkPositive('rect', 'width', w); checkPositive('rect', 'height', h);
  return new Sketch(CS().square([w, h], center));
}
export const square = rect;

export function roundedRect(w = 1, h = w, r = 0.1, { center = true, segments = 8 } = {}) {
  checkPositive('roundedRect', 'width', w); checkPositive('roundedRect', 'height', h); checkNonNegative('roundedRect', 'radius', r);
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return rect(w, h, { center });
  const pts = [];
  const corners = [[w - r, h - r, 0], [r, h - r, 90], [r, r, 180], [w - r, r, 270]];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = ((start + (i / segments) * 90) * Math.PI) / 180;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  const s = Sketch.fromPoints(pts, 'roundedRect');
  return center ? s.translate(-w / 2, -h / 2) : s;
}

/** Regular polygon with `sides`, circumradius `r` (first vertex on +x). */
export function regularPolygon(sides = 6, r = 1) {
  checkInt('regularPolygon', 'sides', sides, 3); checkPositive('regularPolygon', 'radius', r);
  return Sketch.fromPoints(Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }), 'regularPolygon');
}

/** Arbitrary polygon from [[x,y], ...]. Pass `{ holes: [[...], ...] }` for holes. */
export function polygon2d(points, { holes = [] } = {}) {
  const rings = [checkPoints(points, 'polygon2d'), ...holes.map((h, i) => checkPoints(h, `polygon2d hole ${i}`))];
  return new Sketch(new (CS())(rings, 'EvenOdd'));
}

/** Capsule / slot: two semicircles `length` apart (center to center) with radius r. */
export function slot(length = 2, r = 0.5, { segments = 32 } = {}) {
  checkNonNegative('slot', 'length', length); checkPositive('slot', 'radius', r);
  if (length === 0) return circle(r, { segments });
  return hull2d(circle(r, { segments }).translate(-length / 2, 0), circle(r, { segments }).translate(length / 2, 0));
}

// ---------- 2D -> 3D ----------

/**
 * Extrude a sketch along +Y.
 * opts: { center=false, twist=0 (degrees over the height), scale=1 (number or [sx,sy] at top), slices }
 */
export function extrude(sketch, h = 1, { center = false, twist = 0, scale = 1, slices } = {}) {
  if (!(sketch instanceof Sketch)) throw new TypeError(`extrude: first argument must be a 2D sketch (circle, rect, …), got ${describe(sketch)}`);
  checkPositive('extrude', 'height', h); checkNumber('extrude', 'twist', twist);
  const top = Array.isArray(scale) ? scale : [scale, scale];
  slices ??= twist ? Math.max(1, Math.ceil(Math.abs(twist) / 5)) : 0;
  const zUp = track(sketch.cs.extrude(h, slices, twist, top, center));
  return new Shape(zUp.rotate(Z_TO_Y));
}

/**
 * Revolve a sketch around the Y axis. Sketch x is the radius (must be >= 0), sketch y is height.
 * opts: { angle=360, segments=64 }
 */
export function revolve(sketch, { angle = 360, segments = 64 } = {}) {
  if (!(sketch instanceof Sketch)) throw new TypeError(`revolve: first argument must be a 2D sketch (circle, rect, …), got ${describe(sketch)}`);
  checkNumber('revolve', 'angle', angle); checkInt('revolve', 'segments', segments, 3);
  if (angle === 0) throw new RangeError('revolve: angle must not be 0');
  if (sketch.bounds().min[0] < -1e-9) throw new RangeError('revolve: sketch must lie at x >= 0 (x is the radius)');
  const zUp = track(sketch.cs.revolve(segments, angle));
  return new Shape(zUp.rotate(Z_TO_Y));
}

export const sketchApi = {
  Sketch, circle, ellipse, rect, square, roundedRect, regularPolygon, polygon2d, slot, text, text3d,
  union2d, difference2d, intersect2d, hull2d, extrude, revolve,
};
