import { Shape, describe, checkShape, checkNumber, checkNonNegative } from './shape.js';

/*
 * Placement by named features, so scripts say where things go instead of doing the arithmetic:
 *   s.face('top')                       a face of the bounding box: { name, normal, center, min, max, size }
 *   part.placeOn(base, 'top', opts)     put part's opposite face on base's face (centred, or at an offset)
 *   cutter.at(face, [u, v], opts)       put a shape's origin on a face, +Y turned along the face normal
 *   a.alignTo(b, { x, y, z }, opts)     align bounding boxes axis by axis: 'min' 'center' 'max', or next to b
 *   distance(a, b)                      between faces or points, along the first face's normal
 *   rectPattern(w, d) / gridPattern()   [u, v] point lists for hole patterns and arrays of features
 */

const FACES = {
  top: { axis: 1, sign: 1, u: 0, v: 2, rotate: [0, 0, 0] },
  bottom: { axis: 1, sign: -1, u: 0, v: 2, rotate: [180, 0, 0] },
  front: { axis: 2, sign: 1, u: 0, v: 1, rotate: [90, 0, 0] },
  back: { axis: 2, sign: -1, u: 0, v: 1, rotate: [-90, 0, 0] },
  right: { axis: 0, sign: 1, u: 2, v: 1, rotate: [0, 0, -90] },
  left: { axis: 0, sign: -1, u: 2, v: 1, rotate: [0, 0, 90] },
};
export const FACE_NAMES = Object.keys(FACES);
const AXES = 'xyz';

/** A face of a shape's bounding box. */
export class Face {
  constructor(shape, name) {
    const f = FACES[name];
    if (!f) throw new TypeError(`face: expected one of ${FACE_NAMES.join(', ')}, got ${describe(name)}`);
    const b = shape.bounds();
    this.name = name; this.shape = shape;
    this.axis = AXES[f.axis]; this.sign = f.sign;
    this.normal = [0, 0, 0]; this.normal[f.axis] = f.sign;
    this.center = [...b.center]; this.center[f.axis] = f.sign > 0 ? b.max[f.axis] : b.min[f.axis];
    this.min = b.min; this.max = b.max; this.size = b.size;
    this.u = AXES[f.u]; this.v = AXES[f.v]; // the in-plane axes an [u, v] offset refers to
    Object.freeze(this);
  }
  /** A point on the face: [u, v] along the face's in-plane axes, or { x, y, z } offsets in world axes. */
  point(at = [0, 0]) {
    const p = [...this.center];
    if (Array.isArray(at)) {
      if (at.length !== 2) throw new TypeError(`${this.name} face: an offset is [${this.u}, ${this.v}], got ${describe(at)}`);
      p[AXES.indexOf(this.u)] += checkNumber('at', this.u, at[0]); p[AXES.indexOf(this.v)] += checkNumber('at', this.v, at[1]);
    } else if (at && typeof at === 'object') {
      for (const k of AXES) if (at[k] !== undefined) p[AXES.indexOf(k)] += checkNumber('at', k, at[k]);
    } else throw new TypeError(`at: expected [u, v] or { x, y, z }, got ${describe(at)}`);
    return p;
  }
}

const isFace = (f) => f instanceof Face;
const checkFace = (fn, f) => { if (!isFace(f)) throw new TypeError(`${fn}: expected a face (shape.face('top')), got ${describe(f)}`); return f; };

/** Put this shape's origin on a point of a face, with its +Y turned along the face normal (so cutters and bosses built on y = 0 land on it). */
function at(shape, face, offset = [0, 0], { gap = 0, orient = true } = {}) {
  checkFace('at', face); checkNumber('at', 'gap', gap);
  const f = FACES[face.name];
  const p = face.point(offset);
  for (let k = 0; k < 3; k++) p[k] += face.normal[k] * gap;
  const s = orient && (f.rotate[0] || f.rotate[1] || f.rotate[2]) ? shape.rotate(...f.rotate) : shape;
  return s.translate(...p);
}

/**
 * Put this shape on a face of another: its opposite face touches the target face.
 * opts: { at: [u, v] | { x, y, z } offset from the face centre, gap, align: 'center' (default) | 'keep' }
 */
function placeOn(shape, base, faceName = 'top', { at: offset = [0, 0], gap = 0, align = 'center' } = {}) {
  checkShape('placeOn', 'base', base); checkNumber('placeOn', 'gap', gap);
  const face = new Face(base, faceName);
  const f = FACES[faceName];
  const b = shape.bounds();
  const target = face.point(offset);
  const d = [0, 0, 0];
  // Along the normal: the shape's facing side meets the face (plus the gap).
  const mine = f.sign > 0 ? b.min[f.axis] : b.max[f.axis];
  d[f.axis] = target[f.axis] + f.sign * gap - mine;
  if (align === 'center') { d[f.u] = target[f.u] - b.center[f.u]; d[f.v] = target[f.v] - b.center[f.v]; }
  else if (align === 'keep') { /* only move along the normal */ }
  else throw new TypeError(`placeOn: align must be 'center' or 'keep', got ${describe(align)}`);
  return shape.translate(...d);
}

const RELATIONS = {
  x: { left: -1, right: 1 },
  y: { below: -1, above: 1 },
  z: { back: -1, front: 1 },
};

/**
 * Align this shape's bounding box to another's, axis by axis. Each of x, y, z may be
 * 'min' | 'center' | 'max' (match that side), or a side of the other shape to sit against:
 * x: 'left' | 'right', y: 'below' | 'above', z: 'back' | 'front'. Axes not given stay put.
 * opts: { gap } space left when sitting against a side.
 */
function alignTo(shape, other, spec = {}, { gap = 0 } = {}) {
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
  return shape.translate(...d);
}

/** Distance between two faces (along the first one's normal), a face and a point, or two points. */
export function distance(a, b) {
  const pt = (v) => (isFace(v) ? v.center : Array.isArray(v) && v.length === 3 ? v.map((x, i) => checkNumber('distance', AXES[i], x)) : null);
  const pa = pt(a), pb = pt(b);
  if (!pa || !pb) throw new TypeError(`distance: expected faces or [x, y, z] points, got ${describe(a)} and ${describe(b)}`);
  if (isFace(a)) return Math.abs((pb[0] - pa[0]) * a.normal[0] + (pb[1] - pa[1]) * a.normal[1] + (pb[2] - pa[2]) * a.normal[2]);
  if (isFace(b)) return distance(b, a);
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
}

/** The four corners of a w × d rectangle centred on the origin, as [u, v] points. */
export function rectPattern(w, d = w) {
  checkNumber('rectPattern', 'w', w); checkNumber('rectPattern', 'd', d);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]];
}
/** An nu × nv grid of [u, v] points with the given pitch, centred on the origin. */
export function gridPattern(nu, nv, du, dv = du) {
  checkNumber('gridPattern', 'nu', nu); checkNumber('gridPattern', 'nv', nv); checkNumber('gridPattern', 'du', du); checkNumber('gridPattern', 'dv', dv);
  const out = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) out.push([(i - (nu - 1) / 2) * du, (j - (nv - 1) / 2) * dv]);
  return out;
}

Shape.prototype.face = function (name) { return new Face(this, name); };
Shape.prototype.at = function (face, offset, opts) { return at(this, face, offset, opts); };
Shape.prototype.placeOn = function (base, face, opts) { return placeOn(this, base, face, opts); };
Shape.prototype.alignTo = function (other, spec, opts) { return alignTo(this, other, spec, opts); };

export const placeApi = { Face, distance, rectPattern, gridPattern };
