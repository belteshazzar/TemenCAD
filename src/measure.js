import { M } from './engine.js';
import { Shape, checkShape, checkNumber } from './shape.js';

/*
 * Questions about how shapes relate, for checking a design in the script itself:
 *   intersects(a, b)     do they share any volume?
 *   interference(a, b)   the shared volume in mm³ (0 when they do not touch)
 *   overlap(a, b)        that shared volume as a Shape, to look at or subtract
 *   clearance(a, b)      the smallest gap between them in mm (0 when they touch or overlap)
 */

const diag = (s) => { const { size } = s.bounds(); return Math.hypot(size[0], size[1], size[2]); };

export function overlap(a, b) {
  checkShape('overlap', 'a', a); checkShape('overlap', 'b', b);
  return new Shape(M().Manifold.intersection(a.m, b.m));
}
export function interference(a, b) {
  checkShape('interference', 'a', a); checkShape('interference', 'b', b);
  const o = M().Manifold.intersection(a.m, b.m);
  const v = o.volume(); o.delete();
  return v;
}
export const intersects = (a, b) => interference(a, b) > 1e-9;

/** Smallest distance between the surfaces of two shapes; 0 when they touch or overlap. opts: { searchLength } */
export function clearance(a, b, { searchLength } = {}) {
  checkShape('clearance', 'a', a); checkShape('clearance', 'b', b);
  if (searchLength !== undefined) checkNumber('clearance', 'searchLength', searchLength);
  if (interference(a, b) > 1e-9) return 0;
  const L = searchLength ?? diag(a) + diag(b) + 1;
  const g = a.m.minGap(b.m, L);
  return g >= L ? Infinity : g;
}

Shape.prototype.intersects = function (o) { return intersects(this, o); };
Shape.prototype.interference = function (o) { return interference(this, o); };
Shape.prototype.overlap = function (o) { return overlap(this, o); };
Shape.prototype.clearance = function (o, opts) { return clearance(this, o, opts); };

export const measureApi = { intersects, interference, overlap, clearance };
