import { Shape, checkShape, checkNumber, checkPositive } from './shape.js';

/*
 * Printability checks on meshes, for the command line (--check, --report) and for scripts:
 *   overhangs(s, { angle })      downward faces steeper than `angle` from vertical: their area and the worst angle
 *   unsupported(s, { angle })    the part of those with nothing of the shape below them (islands and bridges)
 *   minWallThickness(s)          the thinnest wall found by casting rays inward from the surface
 *   printability(s, opts)        all of the above with a verdict and a list of problems
 * Everything works on the mesh a shape exports; y = 0 is the plate, +Y is up.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Triangles of a mesh as { a, b, c, n (unit), area, centroid }. */
function triangles(positions, indices) {
  const P = positions, I = indices, out = [];
  const n = I ? I.length / 3 : P.length / 9;
  for (let t = 0; t < n; t++) {
    const ia = (I ? I[t * 3] : t * 3) * 3, ib = (I ? I[t * 3 + 1] : t * 3 + 1) * 3, ic = (I ? I[t * 3 + 2] : t * 3 + 2) * 3;
    const a = [P[ia], P[ia + 1], P[ia + 2]], b = [P[ib], P[ib + 1], P[ib + 2]], c = [P[ic], P[ic + 1], P[ic + 2]];
    const cr = cross(sub(b, a), sub(c, a)), l = len(cr);
    if (l < 1e-12) continue;
    out.push({ a, b, c, n: [cr[0] / l, cr[1] / l, cr[2] / l], area: l / 2, centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
  }
  return out;
}

/** Volume, surface area, centre of mass and bounds of a closed mesh. */
export function meshStats(positions, indices) {
  const tris = triangles(positions, indices);
  let vol = 0, area = 0; const cm = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    const v = dot(t.a, cross(t.b, t.c)) / 6; // signed tetrahedron with the origin
    vol += v; area += t.area;
    for (let k = 0; k < 3; k++) cm[k] += (v * (t.a[k] + t.b[k] + t.c[k])) / 4;
    for (const p of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  }
  const centerOfMass = Math.abs(vol) > 1e-12 ? cm.map((v) => v / vol) : [0, 0, 0];
  return { volume: Math.abs(vol), surfaceArea: area, centerOfMass, bounds: { min, max, size: sub(max, min), center: min.map((v, k) => (v + max[k]) / 2) } };
}

/** Distance along a ray (origin o, unit direction d) to the first triangle hit, skipping those closer than `skip`. */
function rayDistance(o, d, tris, skip = 1e-4) {
  let best = Infinity;
  for (const t of tris) {
    const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a);
    const p = cross(d, e2), det = dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det, s = sub(o, t.a);
    const u = dot(s, p) * inv; if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q = cross(s, e1);
    const v = dot(d, q) * inv; if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const dist = dot(e2, q) * inv;
    if (dist > skip && dist < best) best = dist;
  }
  return best;
}

const FIRST_LAYER = 0.3; // faces this close to the plate are the first layer: the plate supports them

/** Faces whose underside slopes more than `angle` degrees from vertical, ignoring faces on or within a first layer of the plate. */
export function overhangFaces(positions, indices, angle = 45, plateY = 0) {
  const limit = Math.sin((angle * Math.PI) / 180) + 1e-6;
  const out = [];
  for (const t of triangles(positions, indices)) {
    if (t.n[1] >= 0 || -t.n[1] < limit) continue; // facing up, or within the allowed slope
    if (t.a[1] <= plateY + FIRST_LAYER && t.b[1] <= plateY + FIRST_LAYER && t.c[1] <= plateY + FIRST_LAYER) continue; // sitting on the plate
    out.push({ ...t, angle: (Math.asin(Math.min(1, -t.n[1])) * 180) / Math.PI });
  }
  return out;
}

function meshOf(fn, s) { checkShape(fn, 'shape', s); const { positions, indices } = s.toMesh(); return { positions, indices }; }

/** Overhangs of a shape: { area, worstAngle, lowest } for faces steeper than angle (default 45°). */
export function overhangs(s, { angle = 45 } = {}) {
  checkNumber('overhangs', 'angle', angle);
  const { positions, indices } = meshOf('overhangs', s);
  return summarise(overhangFaces(positions, indices, angle));
}
function summarise(faces) {
  let area = 0, worst = 0, lowest = Infinity;
  for (const f of faces) { area += f.area; if (f.angle > worst) worst = f.angle; if (f.centroid[1] < lowest) lowest = f.centroid[1]; }
  return { area, worstAngle: worst, lowest: faces.length ? lowest : null, faces: faces.length };
}

/** Overhangs with nothing of the shape beneath them: islands and bridges. Same summary as overhangs(). */
export function unsupported(s, { angle = 45 } = {}) {
  checkNumber('unsupported', 'angle', angle);
  const { positions, indices } = meshOf('unsupported', s);
  const all = triangles(positions, indices);
  const faces = overhangFaces(positions, indices, angle).filter((f) => !Number.isFinite(rayDistance(f.centroid, [0, -1, 0], all)) && f.centroid[1] > FIRST_LAYER);
  return summarise(faces);
}

/** The thinnest wall of a shape, by casting rays inward from a sample of faces: { thickness, at } (thickness Infinity for a solid with no second surface). */
export function minWallThickness(s, { samples = 600 } = {}) {
  checkPositive('minWallThickness', 'samples', samples);
  const { positions, indices } = meshOf('minWallThickness', s);
  const all = triangles(positions, indices);
  // Rays start from real faces, not the slivers a boolean or a fillet seam leaves behind, and a hit closer
  // than 0.05 mm is such a sliver on the same surface, not a wall.
  const total = all.reduce((n, t) => n + t.area, 0);
  const faces = all.filter((t) => t.area >= Math.min(0.02, total / 1e5));
  const picked = [];
  if (faces.length <= samples) picked.push(...faces);
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

/**
 * A printing verdict: overhang and unsupported areas, the thinnest wall, and the problems found.
 * opts: { angle = 45, minWall = 0.8, maxUnsupported = 1 (mm²) }
 */
export function printability(s, { angle = 45, minWall = 0.8, maxUnsupported = 1 } = {}) {
  const over = overhangs(s, { angle }), un = unsupported(s, { angle }), wall = minWallThickness(s);
  const { bounds } = meshStats(...Object.values(meshOf('printability', s)));
  const problems = [];
  if (bounds.min[1] < -1e-4) problems.push(`sits ${(-bounds.min[1]).toFixed(2)} mm below the plate (y = 0); use .onPlate()`);
  if (un.area > maxUnsupported) problems.push(`${un.area.toFixed(1)} mm² of unsupported faces (islands or bridges) with nothing below; lowest at y = ${un.lowest.toFixed(1)}`);
  if (over.area > maxUnsupported) problems.push(`${over.area.toFixed(1)} mm² of overhangs steeper than ${angle}° (worst ${over.worstAngle.toFixed(0)}°); needs supports or a redesign`);
  if (wall.thickness < minWall) problems.push(`thinnest wall ${wall.thickness.toFixed(2)} mm at [${wall.at.map((v) => v.toFixed(1)).join(', ')}], under ${minWall} mm`);
  return { ok: problems.length === 0, problems, overhangs: over, unsupported: un, minWall: wall, bounds };
}

Shape.prototype.overhangs = function (o) { return overhangs(this, o); };
Shape.prototype.unsupported = function (o) { return unsupported(this, o); };
Shape.prototype.minWallThickness = function (o) { return minWallThickness(this, o); };
Shape.prototype.printability = function (o) { return printability(this, o); };

export const printApi = { overhangs, unsupported, minWallThickness, printability };
