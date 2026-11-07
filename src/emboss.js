import { Shape, Anchor, describe, checkPositive, checkNumber } from './shape.js';
import { Sketch, extrude, text } from './sketch.js';
import { Face } from './place.js';

/*
 * Lettering and logos on a face:
 *   s.emboss(sketch | 'text', face | anchor, { depth, at, angle, size, font, center })   raised by depth
 *   s.engrave(sketch | 'text', face | anchor, opts)                                      cut in by depth
 * The sketch is laid on the face so it reads correctly from outside: on top as a drawing seen from
 * above; on front, back, left and right upright with its x to the viewer's right; on the bottom seen
 * from below with x along +X. It is centred on the face (or on `at`) unless center is false.
 */

// Rotation (degrees about X, then Y, then Z) that lays a ground-plane sketch on each face, readable from outside.
const LAY = { top: [0, 0, 0], bottom: [180, 0, 0], front: [90, 0, 0], back: [90, 180, 0], right: [90, 90, 0], left: [90, -90, 0] };
const OVERLAP = 0.01;

function toSketch(fn, what, { size = 6, font, align = 'center' } = {}) {
  if (what instanceof Sketch) return what;
  if (typeof what === 'string') return text(what, { size, font, align });
  throw new TypeError(`${fn}: expected a 2D sketch or a string, got ${describe(what)}`);
}

function rotationToward(n) {
  const [x, y, z] = n;
  if (Math.abs(y - 1) < 1e-9) return [0, 0, 0];
  if (Math.abs(y + 1) < 1e-9) return [180, 0, 0];
  return [(Math.acos(Math.max(-1, Math.min(1, y))) * 180) / Math.PI, (Math.atan2(x, z) * 180) / Math.PI, 0];
}

/** The solid of the lettering, placed on the target: from -below to +above along the normal. */
function lettering(fn, what, target, { depth = 1, at = [0, 0], angle = 0, center = true, ...textOpts }, below, above) {
  checkPositive(fn, 'depth', depth); checkNumber(fn, 'angle', angle);
  let sk = toSketch(fn, what, textOpts);
  if (center) sk = sk.center();
  if (angle) sk = sk.rotate(angle);
  let solid = extrude(sk, below + above).translate(0, -below, 0);
  let point, rot;
  if (target instanceof Face) { rot = LAY[target.name]; point = target.point(at); }
  else if (target instanceof Anchor) { rot = rotationToward(target.normal ?? [0, 1, 0]); point = target.point.map((v, k) => v + (Array.isArray(at) && at.length === 3 ? at[k] : 0)); }
  else throw new TypeError(`${fn}: expected a face (shape.face('top')) or an anchor, got ${describe(target)}`);
  if (rot[0] || rot[1] || rot[2]) solid = solid.rotate(...rot);
  return solid.translate(...point);
}

/** Raise a sketch or text out of a face by depth. */
export function emboss(shape, what, target, opts = {}) {
  if (!(shape instanceof Shape)) throw new TypeError(`emboss: expected a Shape, got ${describe(shape)}`);
  const d = opts.depth ?? 1;
  return shape.add(lettering('emboss', what, target, { ...opts, depth: d }, OVERLAP, d));
}
/** Cut a sketch or text into a face by depth. */
export function engrave(shape, what, target, opts = {}) {
  if (!(shape instanceof Shape)) throw new TypeError(`engrave: expected a Shape, got ${describe(shape)}`);
  const d = opts.depth ?? 1;
  return shape.subtract(lettering('engrave', what, target, { ...opts, depth: d }, d, OVERLAP));
}

Shape.prototype.emboss = function (what, target, opts) { return emboss(this, what, target, opts); };
Shape.prototype.engrave = function (what, target, opts) { return engrave(this, what, target, opts); };

export const embossApi = { emboss, engrave };
