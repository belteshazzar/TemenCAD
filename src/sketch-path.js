import { describe, checkNumber, checkPositive, checkInt } from './shape.js';
import { polygon2d } from './sketch.js';

/*
 * A 2D profile drawn step by step, like a pen: sketch().moveTo(0, 0).lineTo(30, 0).arcTo(30, 10, { r: 5 })
 * .lineTo(0, 10).fillet(2).close() gives a Sketch. Arcs are sampled into points; fillet() rounds the
 * corner just drawn. close({ mirror: 'y' }) completes a symmetric outline by mirroring across the axis.
 */

const EPS = 1e-9;

export class SketchBuilder {
  constructor(points = []) {
    this.pts = []; this.radii = []; this.lastDir = null;
    for (const p of points) this.lineTo(p[0], p[1]);
  }
  get current() { return this.pts.length ? this.pts[this.pts.length - 1] : null; }
  _push(x, y) {
    const c = this.current;
    if (c && Math.hypot(x - c[0], y - c[1]) < EPS) return this;
    if (c) this.lastDir = [x - c[0], y - c[1]];
    this.pts.push([x, y]); this.radii.push(0);
    return this;
  }

  /** Start the outline here (or move the pen before the first segment). */
  moveTo(x, y) {
    checkNumber('moveTo', 'x', x); checkNumber('moveTo', 'y', y);
    if (this.pts.length > 1) throw new Error('moveTo: the outline has started; a sketch is one closed outline');
    this.pts = [[x, y]]; this.radii = [0]; this.lastDir = null;
    return this;
  }
  lineTo(x, y) { checkNumber('lineTo', 'x', x); checkNumber('lineTo', 'y', y); return this._push(x, y); }
  /** A segment relative to the current point. */
  line(dx, dy = 0) { checkNumber('line', 'dx', dx); checkNumber('line', 'dy', dy); const c = this.current ?? [0, 0]; return this._push(c[0] + dx, c[1] + dy); }
  horizontal(dx) { return this.line(dx, 0); }
  vertical(dy) { return this.line(0, dy); }

  /**
   * A circular arc of radius r from the current point to (x, y). side: 'left' (counter-clockwise, default)
   * or 'right'; large: take the long way round. segments: points per full circle (default 48).
   */
  arcTo(x, y, { r, side = 'left', large = false, segments = 48 } = {}) {
    checkNumber('arcTo', 'x', x); checkNumber('arcTo', 'y', y); checkPositive('arcTo', 'r', r); checkInt('arcTo', 'segments', segments, 8);
    const c = this.current; if (!c) throw new Error('arcTo: moveTo first');
    const dx = x - c[0], dy = y - c[1], d = Math.hypot(dx, dy);
    if (d < EPS) return this;
    if (r < d / 2 - 1e-9) throw new RangeError(`arcTo: radius ${r} is too small for a chord of ${d.toFixed(3)} (needs at least ${(d / 2).toFixed(3)})`);
    const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
    const left = [-dy / d, dx / d];
    const ccw = side === 'left';
    if (side !== 'left' && side !== 'right') throw new TypeError(`arcTo: side must be 'left' or 'right', got ${describe(side)}`);
    // The short counter-clockwise arc has its centre on the left of the chord; large or clockwise flips it.
    const s = (ccw ? 1 : -1) * (large ? -1 : 1);
    const cx = c[0] + dx / 2 + left[0] * h * s, cy = c[1] + dy / 2 + left[1] * h * s;
    return this._arc(cx, cy, r, Math.atan2(c[1] - cy, c[0] - cx), Math.atan2(y - cy, x - cx), ccw, segments);
  }
  /** An arc tangent to the previous segment, ending at (x, y). */
  tangentArcTo(x, y, { segments = 48 } = {}) {
    checkNumber('tangentArcTo', 'x', x); checkNumber('tangentArcTo', 'y', y);
    const c = this.current; if (!c || !this.lastDir) throw new Error('tangentArcTo: draw a segment first, so there is a direction to be tangent to');
    const [tx, ty] = this.lastDir, tl = Math.hypot(tx, ty), n = [-ty / tl, tx / tl]; // left normal
    const ex = x - c[0], ey = y - c[1];
    const dn = ex * n[0] + ey * n[1];
    if (Math.abs(dn) < 1e-9) return this._push(x, y); // straight on
    const t = (ex * ex + ey * ey) / (2 * dn);
    const cx = c[0] + n[0] * t, cy = c[1] + n[1] * t, r = Math.abs(t);
    return this._arc(cx, cy, r, Math.atan2(c[1] - cy, c[0] - cx), Math.atan2(y - cy, x - cx), t > 0, segments);
  }
  _arc(cx, cy, r, a0, a1, ccw, segments) {
    let sweep = a1 - a0;
    if (ccw) { while (sweep <= 1e-12) sweep += 2 * Math.PI; } else { while (sweep >= -1e-12) sweep -= 2 * Math.PI; }
    const n = Math.max(2, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * segments));
    for (let i = 1; i <= n; i++) { const a = a0 + (sweep * i) / n; this._push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    return this;
  }
  /** Round the corner at the current point when the outline is closed. */
  fillet(r) {
    checkPositive('fillet', 'r', r);
    if (!this.pts.length) throw new Error('fillet: nothing drawn yet');
    this.radii[this.pts.length - 1] = r;
    return this;
  }
  /** The points so far, for inspection. */
  points() { return this.pts.map((p) => [...p]); }

  /** Close the outline and return a Sketch. opts: { mirror: 'x' | 'y' } appends the mirror image to complete a symmetric outline. */
  close({ mirror, segments = 8 } = {}) {
    let pts = this.pts.map((p) => [...p]), radii = [...this.radii];
    if (mirror) {
      const i = mirror === 'x' ? 1 : mirror === 'y' ? 0 : null; // mirror across the x axis flips y, and vice versa
      if (i === null) throw new TypeError(`close: mirror must be 'x' or 'y', got ${describe(mirror)}`);
      const back = [], backR = [];
      for (let k = pts.length - 1; k >= 0; k--) {
        const q = [...pts[k]]; q[i] = -q[i];
        if (Math.abs(pts[k][i]) < EPS) continue; // points on the axis would repeat
        back.push(q); backR.push(radii[k]);
      }
      pts = pts.concat(back); radii = radii.concat(backR);
    }
    if (pts.length < 3) throw new Error('close: an outline needs at least 3 points');
    return polygon2d(roundCorners(pts, radii, segments));
  }
}

/** Replace vertices that have a radius with arcs tangent to their two edges. */
function roundCorners(pts, radii, segments) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const r = radii[i];
    const p = pts[i];
    if (!r) { out.push(p); continue; }
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const u1 = [a[0] - p[0], a[1] - p[1]], u2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(...u1), l2 = Math.hypot(...u2);
    if (l1 < EPS || l2 < EPS) { out.push(p); continue; }
    u1[0] /= l1; u1[1] /= l1; u2[0] /= l2; u2[1] /= l2;
    const cosA = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const half = Math.acos(cosA) / 2; // half the interior angle
    if (half < 1e-6 || Math.abs(half - Math.PI / 2) < 1e-6) { out.push(p); continue; } // straight or folded back
    let t = r / Math.tan(half);
    const tmax = Math.min(l1, l2) * 0.999;
    let rr = r;
    if (t > tmax) { t = tmax; rr = t * Math.tan(half); } // corner too short: use the biggest radius that fits
    const t1 = [p[0] + u1[0] * t, p[1] + u1[1] * t], t2 = [p[0] + u2[0] * t, p[1] + u2[1] * t];
    const bis = [u1[0] + u2[0], u1[1] + u2[1]], bl = Math.hypot(...bis);
    const c = [p[0] + (bis[0] / bl) * (rr / Math.sin(half)), p[1] + (bis[1] / bl) * (rr / Math.sin(half))];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]), a1 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let sweep = a1 - a0; while (sweep > Math.PI) sweep -= 2 * Math.PI; while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * segments));
    for (let k = 0; k <= steps; k++) { const ang = a0 + (sweep * k) / steps; out.push([c[0] + rr * Math.cos(ang), c[1] + rr * Math.sin(ang)]); }
  }
  return out;
}

/** Start a profile: sketch() for a pen at the origin, or sketch([[x, y], ...]) with a polyline already drawn. */
export function sketch(points) {
  if (points !== undefined && !Array.isArray(points)) throw new TypeError(`sketch: expected nothing or an array of [x, y] points, got ${describe(points)}`);
  return new SketchBuilder(points ?? []);
}

export const sketchPathApi = { sketch, SketchBuilder };
