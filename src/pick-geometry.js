/**
 * What the user clicked on a mesh: the whole flat face, or the curved surface (a hole, a boss,
 * a fillet, a sphere) the clicked triangle belongs to, described in words for the assistant.
 * Pure geometry over positions / indices, so it is testable without a browser.
 */

const EPS_ANGLE = 1e-6;          // coplanar: normals agree to this (1 - dot)
const SMOOTH = Math.cos(Math.PI / 6); // neighbouring facets of a curved surface meet at under 30 degrees
const AREA_RATIO = 4;            // a facet more than 4x the clicked one is a separate face (e.g. the flat beside a fillet)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Triangles, normals and edge neighbours of a mesh, with vertices welded by position. */
export function topology(positions, indices) {
  const nv = positions.length / 3;
  const canon = new Int32Array(nv), first = [];
  const seen = new Map();
  for (let v = 0; v < nv; v++) {
    const key = `${Math.round(positions[3 * v] * 1e5)},${Math.round(positions[3 * v + 1] * 1e5)},${Math.round(positions[3 * v + 2] * 1e5)}`;
    let id = seen.get(key);
    if (id === undefined) { id = first.length; seen.set(key, id); first.push(v); }
    canon[v] = id;
  }
  const P = (id) => [positions[3 * first[id]], positions[3 * first[id] + 1], positions[3 * first[id] + 2]];
  const triCount = (indices ? indices.length : nv) / 3;
  const tv = new Int32Array(triCount * 3);
  for (let t = 0; t < triCount * 3; t++) tv[t] = canon[indices ? indices[t] : t];
  const normals = new Float64Array(triCount * 3), areas = new Float64Array(triCount), centroids = new Float64Array(triCount * 3);
  const edges = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = P(tv[3 * t]), b = P(tv[3 * t + 1]), c = P(tv[3 * t + 2]);
    const n = cross(sub(b, a), sub(c, a)), l = len(n);
    areas[t] = l / 2;
    const u = l ? scale(n, 1 / l) : [0, 0, 0];
    normals.set(u, 3 * t);
    centroids.set([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], 3 * t);
    for (let k = 0; k < 3; k++) {
      const i = tv[3 * t + k], j = tv[3 * t + (k + 1) % 3];
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      const list = edges.get(key);
      if (list) list.push(t); else edges.set(key, [t]);
    }
  }
  const neighbors = Array.from({ length: triCount }, () => []);
  for (const list of edges.values()) for (const t of list) for (const u of list) if (u !== t) neighbors[t].push(u);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let id = 0; id < first.length; id++) { const p = P(id); lo = lo.map((x, k) => Math.min(x, p[k])); hi = hi.map((x, k) => Math.max(x, p[k])); }
  return {
    triCount, tv, P, normals, areas, centroids, neighbors, size: len(sub(hi, lo)) || 1,
    n: (t) => [normals[3 * t], normals[3 * t + 1], normals[3 * t + 2]],
    c: (t) => [centroids[3 * t], centroids[3 * t + 1], centroids[3 * t + 2]],
    facetOf: new Int32Array(triCount).fill(-1), facets: [],
  };
}

/** The flat face (all coplanar, edge-connected triangles) containing t, cached on the topology. */
function facet(topo, t) {
  if (topo.facetOf[t] >= 0) return topo.facets[topo.facetOf[t]];
  const n0 = topo.n(t), d0 = dot(n0, topo.c(t)), tol = 1e-5 * topo.size;
  const id = topo.facets.length, tris = [t];
  topo.facetOf[t] = id;
  for (let q = 0; q < tris.length; q++) {
    for (const u of topo.neighbors[tris[q]]) {
      if (topo.facetOf[u] >= 0) continue;
      const nu = topo.n(u);
      if (1 - dot(nu, n0) > EPS_ANGLE || Math.abs(dot(n0, topo.c(u)) - d0) > tol) continue;
      topo.facetOf[u] = id; tris.push(u);
    }
  }
  let area = 0, c = [0, 0, 0];
  for (const u of tris) { area += topo.areas[u]; c = add(c, scale(topo.c(u), topo.areas[u])); }
  const f = { id, tris, normal: n0, area, centroid: scale(c, 1 / (area || 1)) };
  topo.facets.push(f);
  return f;
}

/** Smallest-eigenvalue eigenvector of a symmetric 3x3 (Jacobi), with the eigenvalues. */
function smallestEigen(m) {
  const a = m.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  const vals = [a[0][0], a[1][1], a[2][2]];
  const i = vals.indexOf(Math.min(...vals));
  return { vector: norm([v[0][i], v[1][i], v[2][i]]), values: vals.slice().sort((x, y) => x - y) };
}

/**
 * The surface the user clicked: triangle t of the mesh. Returns
 *   { kind: 'flat', normal, offset, area, bounds, centroid, tris }
 *   { kind: 'curved', shape: 'cylinder' | 'sphere' | 'surface', radius?, convex?, axis?, center?, length?, span?, area, bounds, centroid, tris }
 */
export function surfaceAt(topo, t) {
  const f0 = facet(topo, t);
  // grow over facets that meet at shallow angles and are not much bigger than the clicked one
  const facets = [f0], seen = new Set([f0.id]);
  for (let q = 0; q < facets.length; q++) {
    for (const u of facets[q].tris) for (const w of topo.neighbors[u]) {
      const g = facet(topo, w);
      if (seen.has(g.id)) continue;
      const d = dot(g.normal, topo.n(u));
      if (d < SMOOTH || d > 1 - EPS_ANGLE) continue;
      if (g.area > AREA_RATIO * f0.area || f0.area > AREA_RATIO * g.area * AREA_RATIO) continue;
      seen.add(g.id); facets.push(g);
    }
  }
  const tris = facets.flatMap((f) => f.tris);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const u of tris) for (let k = 0; k < 3; k++) { const p = topo.P(topo.tv[3 * u + k]); lo = lo.map((x, j) => Math.min(x, p[j])); hi = hi.map((x, j) => Math.max(x, p[j])); }
  const bounds = { min: lo, max: hi, size: sub(hi, lo) };
  const area = facets.reduce((s, f) => s + f.area, 0);
  let centroid = [0, 0, 0];
  for (const f of facets) centroid = add(centroid, scale(f.centroid, f.area));
  centroid = scale(centroid, 1 / (area || 1));
  if (facets.length < 3) return { kind: 'flat', normal: f0.normal, offset: dot(f0.normal, f0.centroid), area: f0.area, bounds: boundsOf(topo, f0.tris), centroid: f0.centroid, tris: f0.tris };

  // Fit: the axis is the direction the normals avoid; then the circle (or sphere) through the facets
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const f of facets) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += f.area * f.normal[i] * f.normal[j];
  const eig = smallestEigen(M);
  const cylindrical = eig.values[0] < 0.02 * eig.values[2];
  const axis = cylindrical ? eig.vector : null;
  const flat = (v) => (axis ? sub(v, scale(axis, dot(v, axis))) : v);
  let pbar = [0, 0, 0], nbar = [0, 0, 0];
  for (const f of facets) { pbar = add(pbar, scale(flat(f.centroid), f.area)); nbar = add(nbar, scale(flat(f.normal), f.area)); }
  pbar = scale(pbar, 1 / area); nbar = scale(nbar, 1 / area);
  let num = 0, den = 0;
  for (const f of facets) { const dp = sub(flat(f.centroid), pbar), dn = sub(flat(f.normal), nbar); num += f.area * dot(dp, dn); den += f.area * dot(dn, dn); }
  const r = den > 1e-12 ? num / den : 0;
  const c = sub(pbar, scale(nbar, r));
  let res = 0;
  for (const f of facets) { const e = sub(sub(flat(f.centroid), c), scale(flat(f.normal), r)); res += f.area * dot(e, e); }
  const fits = Math.abs(r) > 1e-9 && Math.sqrt(res / area) < 0.08 * Math.abs(r);
  const base = { kind: 'curved', area, bounds, centroid, tris };
  if (!fits) return { ...base, shape: 'surface' };
  // the fitted centre is good; the radius is best read off the vertices, which lie on the true surface
  // (facet centroids sit on the polygon's flats, a little inside a circle)
  const verts = new Set();
  for (const t2 of tris) for (let k = 0; k < 3; k++) verts.add(topo.tv[3 * t2 + k]);
  let rsum = 0;
  for (const id of verts) rsum += len(sub(flat(topo.P(id)), c));
  const radius = rsum / verts.size;
  if (cylindrical) {
    // angular span of the normals around the axis: a full ring (hole, boss) or an arc (fillet)
    const u = norm(flat(facets[0].normal)), v = cross(axis, u);
    const ang = facets.map((f) => { const n = flat(f.normal); return Math.atan2(dot(n, v), dot(n, u)); }).sort((x, y) => x - y);
    let gap = 2 * Math.PI - (ang.at(-1) - ang[0]);
    for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
    const covered = 2 * Math.PI - gap, step = covered / Math.max(facets.length - 1, 1);
    const span = gap <= 1.5 * step ? 360 : Math.round((covered + step) * 180 / Math.PI); // each facet covers one step around its normal
    let amin = Infinity, amax = -Infinity;
    for (const id of verts) { const s2 = dot(topo.P(id), axis); amin = Math.min(amin, s2); amax = Math.max(amax, s2); }
    const center = add(c, scale(axis, (amin + amax) / 2));
    return { ...base, shape: 'cylinder', radius, convex: r > 0, axis, center, length: amax - amin, span };
  }
  return { ...base, shape: 'sphere', radius, convex: r > 0, center: c };
}

function boundsOf(topo, tris) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const u of tris) for (let k = 0; k < 3; k++) { const p = topo.P(topo.tv[3 * u + k]); lo = lo.map((x, j) => Math.min(x, p[j])); hi = hi.map((x, j) => Math.max(x, p[j])); }
  return { min: lo, max: hi, size: sub(hi, lo) };
}

// ---- words ----
const r2 = (x) => { const v = Math.round(x * 100) / 100; return Object.is(v, -0) ? 0 : v; };
export const fmtPoint = (p) => `[${p.map(r2).join(', ')}]`;
const AXES = [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]];
/** 'top' etc. for a normal along a world axis (Y up, +Z is the front), or null. */
function sideName(n) {
  const names = { '+x': 'right', '-x': 'left', '+y': 'top', '-y': 'bottom', '+z': 'front', '-z': 'back' };
  for (const [a, v] of AXES) { const d = dot(n, v); if (Math.abs(d) > 0.9999) return { axis: a, sign: d > 0 ? '+' : '-', name: names[(d > 0 ? '+' : '-') + a] }; }
  return null;
}
const axisName = (a) => { for (const [n, v] of AXES) if (Math.abs(dot(a, v)) > 0.999) return n.toUpperCase(); return fmtPoint(a); };

/** Short label for a chip: "lid · top face at y = 12", "base · Ø6 hole along Y". */
export function shortLabel(part, s) {
  if (s.kind === 'flat') {
    const side = sideName(s.normal);
    return side ? `${part} · ${side.name} face at ${side.axis} = ${r2(dot(s.centroid, AXES.find((x) => x[0] === side.axis)[1]))}` : `${part} · sloped face`;
  }
  if (s.shape === 'cylinder') {
    const d = r2(2 * s.radius);
    if (s.span < 359) return `${part} · R${r2(s.radius)} ${s.convex ? 'rounded edge' : 'inside corner'} along ${axisName(s.axis)}`;
    return `${part} · Ø${d} ${s.convex ? 'round' : 'hole'} along ${axisName(s.axis)}`;
  }
  if (s.shape === 'sphere') return `${part} · ${s.convex ? 'sphere' : 'spherical pocket'} R${r2(s.radius)}`;
  return `${part} · curved surface`;
}

/** Full description for the model. */
export function describeSurface(part, s, point) {
  const where = `on part "${part}", clicked at ${fmtPoint(point)} (mm; Y is up, +Z is the front)`;
  const box = `its extent is ${fmtPoint(s.bounds.min)} to ${fmtPoint(s.bounds.max)}`;
  if (s.kind === 'flat') {
    const side = sideName(s.normal);
    const facing = side ? `the flat ${side.name} face (normal ${side.sign}${side.axis.toUpperCase()}) at ${side.axis} = ${r2(dot(s.centroid, AXES.find((x) => x[0] === side.axis)[1]))}` : `a flat sloped face with normal ${fmtPoint(s.normal)}`;
    return `${facing}, ${where}; area ${r2(s.area)} mm², ${box}`;
  }
  if (s.shape === 'cylinder') {
    const full = s.span >= 359;
    const what = full ? (s.convex ? `a cylindrical surface (a round boss or rod) of diameter ≈ ${r2(2 * s.radius)}` : `a hole (inside of a cylinder) of diameter ≈ ${r2(2 * s.radius)}`)
      : `a curved ${s.convex ? 'rounded edge (convex fillet)' : 'inside corner (concave fillet)'} of radius ≈ ${r2(s.radius)} spanning about ${s.span}°`;
    return `${what}, axis along ${axisName(s.axis)} through ${fmtPoint(s.center)}, ${r2(s.length)} long, ${where}; ${box}`;
  }
  if (s.shape === 'sphere') return `a ${s.convex ? 'spherical surface' : 'spherical pocket'} of radius ≈ ${r2(s.radius)} centred at ${fmtPoint(s.center)}, ${where}; ${box}`;
  return `a curved surface ${where}; ${box}`;
}

/**
 * A measurement between two picked points, each { point: [x, y, z], snapped, part, surface }:
 * { d, delta: [|dx|, |dy|, |dz|], gap (parallel flat faces, else null), label, text }.
 * The core's temen_pick_measure gives the same words.
 */
export function measureBetween(a, b) {
  const dx = a.point[0] - b.point[0], dy = a.point[1] - b.point[1], dz = a.point[2] - b.point[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const delta = [Math.abs(b.point[0] - a.point[0]), Math.abs(b.point[1] - a.point[1]), Math.abs(b.point[2] - a.point[2])];
  const gap = parallelGap(a.surface, b.surface);
  const end = (e) => `${fmtPoint(e.point)} on part "${e.part}"${e.snapped ? ' (a corner)' : ''}, ${shortLabel(e.part, e.surface).split(' · ')[1]}`;
  const text = `from ${end(a)} to ${end(b)}: ${r2(d)} mm (|Δx| ${r2(delta[0])}, |Δy| ${r2(delta[1])}, |Δz| ${r2(delta[2])})${gap !== null ? `; the two faces are parallel and ${r2(gap)} mm apart` : ''}`;
  return { d, delta, gap, label: `Measured ${r2(d)} mm`, text };
}

/** Plane-to-plane distance when two flat picks are parallel, else null. */
export function parallelGap(a, b) {
  if (a.kind !== 'flat' || b.kind !== 'flat' || Math.abs(dot(a.normal, b.normal)) < 0.9999) return null;
  return Math.abs(dot(a.normal, sub(b.centroid, a.centroid)));
}
