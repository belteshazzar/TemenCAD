import { Shape, hooks, describe, checkNumber } from './shape.js';
import { Face } from './place.js';

/*
 * Annotations: notes a script attaches to the model, drawn over the rendered views (app and command
 * line) and listed in the build report. They never become geometry.
 *   dimension(a, b, { label, offset })   a measured line between two points, faces or shape centres; returns the length
 *   mark(point, text)                    a dot with a label
 */

function toPoint(fn, v) {
  if (v instanceof Face) return [...v.center];
  if (v instanceof Shape) return [...v.bounds().center];
  if (Array.isArray(v) && v.length === 3) return v.map((x, i) => checkNumber(fn, 'xyz'[i], x));
  throw new TypeError(`${fn}: expected [x, y, z], a face or a shape, got ${describe(v)}`);
}

const fmtMm = (v) => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(2).replace(/0$/, ''));

/** A dimension between a and b. opts: { label (default: the length in mm), offset: [dx, dy, dz] shifts the line away from the geometry } */
export function dimension(a, b, { label, offset } = {}) {
  let pa = toPoint('dimension', a), pb = toPoint('dimension', b);
  const length = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
  if (offset !== undefined) { const o = toPoint('dimension', offset); pa = pa.map((v, i) => v + o[i]); pb = pb.map((v, i) => v + o[i]); }
  hooks.annotate({ type: 'dimension', a: pa, b: pb, label: label === undefined ? `${fmtMm(length)} mm` : String(label), length });
  return length;
}

/** A labelled point. */
export function mark(point, text = '') {
  const p = toPoint('mark', point);
  hooks.annotate({ type: 'mark', p, text: String(text) });
  return p;
}

export const annotateApi = { dimension, mark };
