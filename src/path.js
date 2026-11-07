import { M } from './engine.js';
import { Shape, describe, checkNumber, checkPositive, checkInt, hooks } from './shape.js';
import { Sketch } from './sketch.js';
import { manifoldFromTriangles } from './mesh.js';

/*
 * Paths are 3D polylines in world space (Y up). A point may be [x, y, z], or [x, y] for a point
 * on the ground plane using the sketch convention (sketch y is world −Z). Smooth paths are
 * sampled into polylines, so every path is ultimately a list of points, open or closed.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? mul(a, 1 / l) : [0, 0, 0]; };
const EPS = 1e-9;

function checkPoint(fn, p, i) {
  if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) throw new TypeError(`${fn}: point ${i} must be [x, y, z] or [x, y], got ${describe(p)}`);
  p.forEach((v, k) => checkNumber(fn, `point ${i}[${k}]`, v));
  return p.length === 2 ? [p[0], 0, -p[1]] : [p[0], p[1], p[2]];
}

function checkPathPoints(fn, points) {
  if (!Array.isArray(points) || points.length < 2) throw new TypeError(`${fn}: need an array of at least 2 points, got ${describe(points)}`);
  const out = [];
  points.forEach((p, i) => {
    const q = checkPoint(fn, p, i);
    if (out.length && len(sub(q, out[out.length - 1])) < EPS) return; // drop repeated points
    out.push(q);
  });
  if (out.length < 2) throw new RangeError(`${fn}: the points are all the same`);
  return out;
}

function rotationMatrix(x, y, z) {
  const [cx, sx, cy, sy, cz, sz] = [x, y, z].flatMap((d) => { const r = (d * Math.PI) / 180; return [Math.cos(r), Math.sin(r)]; });
  const rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  const mm = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  return mm(rz, mm(ry, rx));
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
export class Path {
  constructor(points, closed = false) { this.points = points; this.closed = closed; Object.freeze(this); }

  _map(f) { return new Path(this.points.map(f), this.closed); }
  translate(x = 0, y = 0, z = 0) {
    if (Array.isArray(x)) [x, y = 0, z = 0] = x;
    checkNumber('translate', 'x', x); checkNumber('translate', 'y', y); checkNumber('translate', 'z', z);
    return this._map((p) => [p[0] + x, p[1] + y, p[2] + z]);
  }
  /** Rotate in degrees about X, then Y, then Z (like Shape.rotate). */
  rotate(x = 0, y = 0, z = 0) {
    if (Array.isArray(x)) [x, y = 0, z = 0] = x;
    checkNumber('rotate', 'x', x); checkNumber('rotate', 'y', y); checkNumber('rotate', 'z', z);
    const m = rotationMatrix(x, y, z);
    return this._map((p) => m.map((row) => dot(row, p)));
  }
  scale(x = 1, y = x, z = x) {
    checkNumber('scale', 'x', x); checkNumber('scale', 'y', y); checkNumber('scale', 'z', z);
    if (x === 0 || y === 0 || z === 0) throw new RangeError('scale: factors must not be 0');
    return this._map((p) => [p[0] * x, p[1] * y, p[2] * z]);
  }
  mirror(axis = 'x') {
    const i = { x: 0, y: 1, z: 2 }[axis];
    if (i === undefined) throw new Error(`mirror: axis must be 'x', 'y' or 'z'`);
    return this._map((p) => { const q = [...p]; q[i] = -q[i]; return q; });
  }
  reverse() { return new Path([...this.points].reverse(), this.closed); }
  /** Join the ends: the sweep becomes a ring with no caps. */
  close() { return new Path(this.points, true); }
  /** Replace the corners with a smooth curve through the same points. */
  smooth({ segments = 8 } = {}) {
    checkInt('smooth', 'segments', segments, 1);
    return new Path(catmullRom(this.points, segments, this.closed), this.closed);
  }
  /** Continue with another path, moved so that it starts where this one ends. */
  append(other) {
    if (!(other instanceof Path)) throw new TypeError(`append: expected a path, got ${describe(other)}`);
    if (this.closed) throw new Error('append: this path is already closed');
    const d = sub(this.points[this.points.length - 1], other.points[0]);
    return new Path(checkPathPoints('append', [...this.points, ...other.points.map((p) => addv(p, d))]), false);
  }

  /** Straight segments as [a, b] pairs, including the closing one for a closed path. */
  segments() {
    const s = [];
    for (let i = 0; i < this.points.length - 1; i++) s.push([this.points[i], this.points[i + 1]]);
    if (this.closed) s.push([this.points[this.points.length - 1], this.points[0]]);
    return s;
  }
  length() { return this.segments().reduce((t, [a, b]) => t + len(sub(b, a)), 0); }
  /** Point at fraction t (0..1) of the length. */
  pointAt(t) { return this._at(t).point; }
  /** Unit direction of travel at fraction t (0..1) of the length. */
  tangentAt(t) { return this._at(t).tangent; }
  _at(t) {
    checkNumber('pointAt', 't', t);
    const segs = this.segments(); const total = this.length();
    let target = Math.min(Math.max(t, 0), 1) * total;
    for (const [a, b] of segs) {
      const l = len(sub(b, a));
      if (target <= l || segs[segs.length - 1][0] === a) return { point: addv(a, mul(sub(b, a), l > 0 ? Math.min(target / l, 1) : 0)), tangent: norm(sub(b, a)) };
      target -= l;
    }
    return { point: this.points[0], tangent: norm(sub(this.points[1], this.points[0])) };
  }
  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of this.points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    return { min, max, size: sub(max, min), center: mul(addv(min, max), 0.5) };
  }
}

// ---------- constructors ----------

/** Polyline through points. opts: { closed, smooth } (smooth: true or a segments-per-span count). */
export function path(points, { closed = false, smooth = false } = {}) {
  let p = new Path(checkPathPoints('path', points), !!closed);
  if (smooth) p = p.smooth({ segments: smooth === true ? 8 : smooth });
  return p;
}
export function line(a, b) { return new Path(checkPathPoints('line', [a, b])); }

/** Arc on the ground plane centred on the origin: from +X, `angle` degrees counter-clockwise seen from above. */
export function arc(r = 1, angle = 90, { segments } = {}) {
  checkPositive('arc', 'radius', r); checkNumber('arc', 'angle', angle);
  if (angle === 0) throw new RangeError('arc: angle must not be 0');
  const n = segments ?? Math.max(2, Math.ceil((Math.abs(angle) / 360) * 64));
  checkInt('arc', 'segments', n, 1);
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = (angle * (i / n) * Math.PI) / 180; pts.push([r * Math.cos(a), 0, -r * Math.sin(a)]); }
  return new Path(pts, Math.abs(Math.abs(angle) - 360) < EPS);
}

/** Helix around the Y axis, starting at [r, 0, 0], rising to `height` over `turns` turns (negative turns go clockwise). */
export function helix(r = 1, height = 1, turns = 1, { segments = 48 } = {}) {
  checkPositive('helix', 'radius', r); checkNumber('helix', 'height', height); checkNumber('helix', 'turns', turns);
  if (turns === 0) throw new RangeError('helix: turns must not be 0');
  checkInt('helix', 'segments', segments, 3);
  const n = Math.max(2, Math.ceil(Math.abs(turns) * segments));
  const pts = [];
  for (let i = 0; i <= n; i++) { const f = i / n, a = turns * f * 2 * Math.PI; pts.push([r * Math.cos(a), height * f, -r * Math.sin(a)]); }
  return new Path(pts);
}

/** Cubic Bézier from p0 to p3 with control points p1, p2. */
export function bezier(p0, p1, p2, p3, { segments = 32 } = {}) {
  const [a, b, c, d] = [p0, p1, p2, p3].map((p, i) => checkPoint('bezier', p, i));
  checkInt('bezier', 'segments', segments, 1);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, u = 1 - t;
    pts.push([0, 1, 2].map((k) => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k]));
  }
  return new Path(checkPathPoints('bezier', pts));
}

// ---------- sweep ----------

/** The profile's "up" at a tangent: world +Y unless the path is vertical, then −Z (so a vertical sweep matches extrude). */
function defaultUp(t, up) {
  if (up) return up;
  return Math.abs(t[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
}
function frameFromUp(t, upHint) {
  const up = defaultUp(t, upHint);
  let u = sub(up, mul(t, dot(up, t)));
  if (len(u) < 1e-6) throw new Error("sweep: the up direction is parallel to the path; choose another { up }");
  u = norm(u);
  return { r: cross(u, t), u };
}

/**
 * Frames along a polyline. Each vertex gets a tangent (the bisector of its two segments), a right
 * vector r and an up vector u, with r × u = t. 'minimal' propagates the first frame with the
 * double-reflection method, so the profile never twists; 'upright' keeps u as close to `up` as possible.
 */
function frames(points, closed, mode, upHint) {
  const n = points.length;
  const dirs = [];
  for (let i = 0; i < n - 1; i++) dirs.push(norm(sub(points[i + 1], points[i])));
  if (closed) dirs.push(norm(sub(points[0], points[n - 1])));
  const tangents = points.map((_, i) => {
    const din = i === 0 ? (closed ? dirs[n - 1] : dirs[0]) : dirs[i - 1];
    const dout = i === n - 1 ? (closed ? dirs[n - 1] : dirs[n - 2]) : dirs[i];
    let t = norm(addv(din, dout));
    if (len(t) < 1e-9) t = din; // the path doubles back on itself
    return { t, din, dout };
  });
  const out = [];
  if (mode === 'upright') {
    for (const { t, din, dout } of tangents) out.push({ ...frameFromUp(t, upHint), t, din, dout });
    return out;
  }
  let { r, u } = frameFromUp(tangents[0].t, upHint);
  out.push({ r, u, t: tangents[0].t, din: tangents[0].din, dout: tangents[0].dout });
  const steps = closed ? n : n - 1;
  for (let i = 1; i <= steps; i++) {
    const j = i % n;
    const v1 = sub(points[j], points[(i - 1) % n]);
    const c1 = dot(v1, v1);
    const rL = sub(r, mul(v1, (2 / c1) * dot(v1, r)));
    const tL = sub(out[i - 1].t, mul(v1, (2 / c1) * dot(v1, out[i - 1].t)));
    const v2 = sub(tangents[j].t, tL);
    const c2 = dot(v2, v2);
    r = c2 < 1e-18 ? rL : sub(rL, mul(v2, (2 / c2) * dot(v2, rL)));
    r = norm(sub(r, mul(tangents[j].t, dot(r, tangents[j].t))));
    u = cross(tangents[j].t, r);
    if (i < n) out.push({ r, u, t: tangents[j].t, din: tangents[j].din, dout: tangents[j].dout });
    else {
      // Closed loop: the propagated frame rarely lands on the first one; spread the mismatch over the loop.
      const f0 = out[0];
      const ang = Math.atan2(dot(cross(r, f0.r), f0.t), dot(r, f0.r));
      out.forEach((f, k) => {
        const a = (ang * k) / n, c = Math.cos(a), s = Math.sin(a);
        const nr = addv(mul(f.r, c), mul(f.u, s));
        f.r = nr; f.u = cross(f.t, nr);
      });
    }
  }
  return out;
}

/**
 * Sweep a 2D profile along a path. The profile is placed perpendicular to the path with sketch x
 * to the right and sketch y up (for a vertical path this matches extrude; for a horizontal path
 * sketch y points up). A closed path makes a ring with no end caps.
 * opts: { frame: 'minimal' | 'upright', up: [x, y, z], twist (deg), scale (number | [sx, sy]), segments }
 * `profile` may be a function of t (0..1 along the path) returning a sketch, to vary the section.
 */
export function sweep(profile, p, { frame = 'minimal', up, twist = 0, scale = 1, segments = 32 } = {}) {
  if (!(p instanceof Path)) throw new TypeError(`sweep: second argument must be a path, got ${describe(p)}`);
  const varying = typeof profile === 'function';
  if (!varying && !(profile instanceof Sketch)) throw new TypeError(`sweep: profile must be a 2D sketch or a function returning one, got ${describe(profile)}`);
  if (!['minimal', 'upright'].includes(frame)) throw new TypeError(`sweep: frame must be 'minimal' or 'upright', got ${describe(frame)}`);
  if (up !== undefined) { if (!Array.isArray(up) || up.length !== 3) throw new TypeError(`sweep: up must be [x, y, z]`); up = norm(up.map((v, i) => checkNumber('sweep', `up[${i}]`, v))); }
  checkNumber('sweep', 'twist', twist);
  const [sx, sy] = Array.isArray(scale) ? scale : [scale, scale];
  checkPositive('sweep', 'scale', sx); checkPositive('sweep', 'scale', sy);
  checkInt('sweep', 'segments', segments, 3);
  const { points, closed } = p;
  if (closed && points.length < 3) throw new RangeError('sweep: a closed path needs at least 3 points');
  const n = points.length;
  const fr = frames(points, closed, frame, up);

  // Fraction of the length at each vertex, for twist, scale and varying profiles.
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + len(sub(points[i], points[i - 1])));
  const total = closed ? cum[n - 1] + len(sub(points[0], points[n - 1])) : cum[n - 1];
  const tAt = (i) => cum[i] / total;

  // Profile rings at each vertex, in sketch units. A fixed profile keeps its own points; a varying one is resampled.
  const ringsAt = (i) => {
    const sk = varying ? profile(tAt(i)) : profile;
    if (!(sk instanceof Sketch)) throw new TypeError(`sweep: profile(${tAt(i).toFixed(3)}) must return a 2D sketch, got ${describe(sk)}`);
    const polys = sk.toPolygons();
    if (!polys.length) throw new Error('sweep: the profile is empty');
    return varying ? polys.map((ring) => resampleRing(ring, segments)) : polys;
  };
  const first = ringsAt(0);
  const contours = first.length, counts = first.map((r) => r.length);
  let maxR = 0;
  for (const ring of first) for (const [x, y] of ring) maxR = Math.max(maxR, Math.hypot(x, y));

  // Warn when a corner is too sharp for the profile to turn without the surface folding into itself.
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const { din, dout } = fr[i];
    const cosHalf = len(addv(din, dout)) / 2;
    if (cosHalf > 0.9999) continue;
    const tanHalf = Math.sqrt(Math.max(0, 1 - cosHalf * cosHalf)) / cosHalf;
    const need = maxR * tanHalf;
    const lin = len(sub(points[i], points[(i - 1 + n) % n])), lout = len(sub(points[(i + 1) % n], points[i]));
    if (lin < need - 1e-6 || lout < need - 1e-6) { hooks.warn(`sweep: the bend at point ${i} is too tight for the profile (segments of ${Math.min(lin, lout).toFixed(2)} mm, needs ${need.toFixed(2)} mm); the surface may fold into itself`); break; }
  }

  const pos = [];
  const starts = []; // vertex index where each (vertex, contour) ring starts
  for (let i = 0; i < n; i++) {
    const rings = i === 0 ? first : ringsAt(i);
    if (rings.length !== contours || rings.some((r, c) => r.length !== counts[c])) throw new Error('sweep: every profile along the path must have the same contours');
    const t = tAt(i);
    const { r, u, t: tan, din, dout } = fr[i];
    const a = (twist * t * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const fx = 1 + (sx - 1) * t, fy = 1 + (sy - 1) * t;
    // Mitre: stretch the section along the bisector plane so the tube keeps its width around the corner.
    const bis = sub(din, dout); const bl = len(bis);
    const cosHalf = len(addv(din, dout)) / 2;
    const stretchAxis = bl > 1e-9 && cosHalf > 1e-6 ? norm(bis) : null;
    const k = stretchAxis ? 1 / cosHalf - 1 : 0;
    const centre = points[i];
    starts.push(pos.length / 3);
    for (const ring of rings) for (const [x0, y0] of ring) {
      const x = (x0 * ca - y0 * sa) * fx, y = (x0 * sa + y0 * ca) * fy;
      let q = addv(mul(r, x), mul(u, y));
      if (stretchAxis) q = addv(q, mul(stretchAxis, k * dot(q, stretchAxis)));
      const w = addv(centre, q);
      pos.push(w[0], w[1], w[2]);
    }
    void tan;
  }
  const tris = [];
  const ringOffset = (c) => counts.slice(0, c).reduce((s, v) => s + v, 0);
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const a = starts[i], b = starts[(i + 1) % n];
    for (let c = 0; c < contours; c++) {
      const o = ringOffset(c), m = counts[c];
      for (let kk = 0; kk < m; kk++) {
        const k2 = (kk + 1) % m;
        tris.push(a + o + kk, a + o + k2, b + o + k2, a + o + kk, b + o + k2, b + o + kk);
      }
    }
  }
  if (!closed) {
    const last = ringsAt(n - 1);
    const capFor = (rings) => M().triangulate(rings, 1e-9);
    for (const [i0, i1, i2] of capFor(first)) tris.push(i0, i2, i1);
    const top = starts[n - 1];
    for (const [i0, i1, i2] of capFor(last)) tris.push(top + i0, top + i1, top + i2);
  }
  return new Shape(manifoldFromTriangles('sweep', pos, tris));
}

/** Resample a closed ring to n points spaced evenly by arc length. */
export function resampleRing(ring, n) {
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

Sketch.prototype.sweep = function (p, opts) { return sweep(this, p, opts); };

export const pathApi = { Path, path, line, arc, helix, bezier, sweep };
