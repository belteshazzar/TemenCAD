/**
 * Printability checks and statistics on a built mesh ({ positions, indices }), for the command line's
 * --check and --report. The same rules as the script-side printability() in the core's prelude:
 *   meshStats(positions, indices)          volume, surface area, centre of mass, bounds
 *   printabilityOfMesh(positions, indices) { ok, problems, overhangs, unsupported, minWall, bounds }
 * y = 0 is the plate, +Y is up. Pure JavaScript over the buffers; no geometry kernel involved.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Triangles of a mesh as { a, b, c, n (unit), area, centroid }. */
function triangles(P, I) {
  const out = [];
  for (let t = 0; t < I.length / 3; t++) {
    const ia = I[t * 3] * 3, ib = I[t * 3 + 1] * 3, ic = I[t * 3 + 2] * 3;
    const a = [P[ia], P[ia + 1], P[ia + 2]], b = [P[ib], P[ib + 1], P[ib + 2]], c = [P[ic], P[ic + 1], P[ic + 2]];
    const cr = cross(sub(b, a), sub(c, a)), l = len(cr);
    if (l < 1e-12) continue;
    out.push({ a, b, c, n: [cr[0] / l, cr[1] / l, cr[2] / l], area: l / 2, centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
  }
  return out;
}

/** Volume, surface area, centre of mass and bounds of a closed mesh. */
export function meshStats(positions, indices) {
  let vol = 0, area = 0; const cm = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles(positions, indices)) {
    const v = dot(t.a, cross(t.b, t.c)) / 6;
    vol += v; area += t.area;
    for (let k = 0; k < 3; k++) cm[k] += (v * (t.a[k] + t.b[k] + t.c[k])) / 4;
    for (const p of [t.a, t.b, t.c]) for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  }
  const centerOfMass = Math.abs(vol) > 1e-12 ? cm.map((v) => v / vol) : [0, 0, 0];
  return { volume: Math.abs(vol), surfaceArea: area, centerOfMass, bounds: { min, max, size: sub(max, min), center: min.map((v, k) => (v + max[k]) / 2) } };
}

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

const FIRST_LAYER = 0.3;

function overhangFaces(tris, angle, plateY = 0) {
  const limit = Math.sin((angle * Math.PI) / 180) + 1e-6;
  const out = [];
  for (const t of tris) {
    if (t.n[1] >= 0 || -t.n[1] < limit) continue;
    if (t.a[1] <= plateY + FIRST_LAYER && t.b[1] <= plateY + FIRST_LAYER && t.c[1] <= plateY + FIRST_LAYER) continue;
    out.push({ ...t, angle: (Math.asin(Math.min(1, -t.n[1])) * 180) / Math.PI });
  }
  return out;
}

function summarise(faces) {
  let area = 0, worst = 0, lowest = Infinity;
  for (const f of faces) { area += f.area; if (f.angle > worst) worst = f.angle; if (f.centroid[1] < lowest) lowest = f.centroid[1]; }
  return { area, worstAngle: worst, lowest: faces.length ? lowest : null, faces: faces.length };
}

function minWall(all, samples = 600) {
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

/** A printing verdict for a mesh. opts: { angle = 45, minWall = 0.8, maxUnsupported = 1 (mm²) } */
export function printabilityOfMesh(positions, indices, { angle = 45, minWall: minWallLimit = 0.8, maxUnsupported = 1 } = {}) {
  const all = triangles(positions, indices);
  const over = summarise(overhangFaces(all, angle));
  const un = summarise(overhangFaces(all, angle).filter((f) => !Number.isFinite(rayDistance(f.centroid, [0, -1, 0], all)) && f.centroid[1] > FIRST_LAYER));
  const wall = minWall(all);
  const { bounds } = meshStats(positions, indices);
  const problems = [];
  if (bounds.min[1] < -1e-4) problems.push(`sits ${(-bounds.min[1]).toFixed(2)} mm below the plate (y = 0); use .onPlate()`);
  if (un.area > maxUnsupported) problems.push(`${un.area.toFixed(1)} mm² of unsupported faces (islands or bridges) with nothing below; lowest at y = ${un.lowest.toFixed(1)}`);
  if (over.area > maxUnsupported) problems.push(`${over.area.toFixed(1)} mm² of overhangs steeper than ${angle}° (worst ${over.worstAngle.toFixed(0)}°); needs supports or a redesign`);
  if (wall.thickness < minWallLimit) problems.push(`thinnest wall ${wall.thickness.toFixed(2)} mm at [${wall.at.map((v) => v.toFixed(1)).join(', ')}], under ${minWallLimit} mm`);
  return { ok: problems.length === 0, problems, overhangs: over, unsupported: un, minWall: wall, bounds };
}
