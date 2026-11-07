import { M } from './engine.js';
import { Shape, describe, checkPositive, checkInt, hooks } from './shape.js';
import { manifoldFromTriangles } from './mesh.js';

/*
 * Edge fillets and chamfers for solids with planar faces, the way a rolling ball does it:
 * every sharp edge gets a prism whose section is the corner minus a quarter circle (or a
 * triangle for a chamfer). Convex edges have that prism subtracted; concave edges have the
 * mirror-image prism added. Prism ends are mitred against the neighbouring edges of the same
 * kind, so the pieces of a loop meet cleanly. Concave edges are done first and the mesh is
 * read again, so a convex fillet that runs into a concave one follows its curve.
 */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? mul(a, 1 / l) : [0, 0, 0]; };
const key = (p) => p.map((v) => Math.round(v * 1e5)).join(',');

/** Read the mesh back as unique vertices and triangles. */
function readMesh(shape) {
  const mesh = shape.m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const ids = new Map(); const verts = []; const remap = [];
  for (let i = 0; i < vp.length / np; i++) {
    const p = [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
    const k = key(p);
    let id = ids.get(k);
    if (id === undefined) { id = verts.length; ids.set(k, id); verts.push(p); }
    remap.push(id);
  }
  const tris = [];
  for (let i = 0; i < tv.length; i += 3) {
    const t = [remap[tv[i]], remap[tv[i + 1]], remap[tv[i + 2]]];
    if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) tris.push(t);
  }
  return { verts, tris };
}

/**
 * Sharp edges of a solid: straight segments where two planar face groups meet at an angle of at
 * least minAngle. Each is { p0, p1, t, nA, nB, convex, angle, length, faces: [A, B] }.
 */
export function sharpEdges(shape, minAngle = 30) {
  const { verts, tris } = readMesh(shape);
  const normals = tris.map(([a, b, c]) => norm(cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]))));
  const edgeKey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const byEdge = new Map();
  tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const e = edgeKey(t[k], t[(k + 1) % 3]); const l = byEdge.get(e); if (l) l.push(i); else byEdge.set(e, [i]); } });
  // Group connected coplanar triangles into faces.
  const face = new Int32Array(tris.length).fill(-1);
  const faceNormal = [];
  for (let seed = 0; seed < tris.length; seed++) {
    if (face[seed] >= 0 || len(normals[seed]) === 0) continue;
    const id = faceNormal.length; faceNormal.push(normals[seed]);
    face[seed] = id; const stack = [seed];
    while (stack.length) {
      const i = stack.pop(); const t = tris[i];
      for (let k = 0; k < 3; k++) for (const j of byEdge.get(edgeKey(t[k], t[(k + 1) % 3]))) {
        if (face[j] < 0 && dot(normals[j], normals[seed]) > 0.99995) { face[j] = id; stack.push(j); }
      }
    }
  }
  const cosMin = Math.cos((minAngle * Math.PI) / 180);
  // Mesh edges between two different faces, grouped by face pair.
  const pairs = new Map();
  for (const [e, list] of byEdge) {
    if (list.length !== 2) continue;
    const A = face[list[0]], B = face[list[1]];
    if (A === B || A < 0 || B < 0) continue;
    if (dot(faceNormal[A], faceNormal[B]) > cosMin) continue;
    const lo = Math.min(A, B), hi = Math.max(A, B);
    const pk = lo * 4294967296 + hi;
    const a = Math.floor(e / 4294967296), b = e % 4294967296;
    const g = pairs.get(pk); if (g) g.push([a, b]); else pairs.set(pk, [[a, b]]);
  }
  const out = [];
  for (const [pk, edges] of pairs) {
    const A = Math.floor(pk / 4294967296), B = pk % 4294967296;
    const nA = faceNormal[A], nB = faceNormal[B];
    const t = norm(cross(nA, nB)); // the faces' line of intersection
    const origin = verts[edges[0][0]];
    const param = (v) => dot(sub(verts[v], origin), t);
    // Merge the mesh edges into maximal straight runs along that line.
    const ivs = edges.map(([a, b]) => { const pa = param(a), pb = param(b); return pa < pb ? [pa, pb, a, b] : [pb, pa, b, a]; }).sort((x, y) => x[0] - y[0]);
    let cur = null;
    const runs = [];
    for (const iv of ivs) {
      if (cur && iv[0] <= cur[1] + 1e-6) { if (iv[1] > cur[1]) { cur[1] = iv[1]; cur[3] = iv[3]; } }
      else { cur = [...iv]; runs.push(cur); }
    }
    // Which way along face A is "into" the face? Use a triangle of A touching the edge.
    const tri = tris.find((tr, i) => face[i] === A && tr.includes(edges[0][0]) && tr.includes(edges[0][1]));
    const centroid = mul(addv(addv(verts[tri[0]], verts[tri[1]]), verts[tri[2]]), 1 / 3);
    let a = cross(nA, t); if (dot(a, sub(centroid, origin)) < 0) a = mul(a, -1);
    const convex = dot(a, nB) < 0;
    const angle = (Math.acos(Math.max(-1, Math.min(1, dot(nA, nB)))) * 180) / Math.PI;
    for (const [s0, s1, v0, v1] of runs) {
      if (s1 - s0 < 1e-6) continue;
      const p0 = verts[v0], p1 = verts[v1];
      out.push({ p0, p1, t: norm(sub(p1, p0)), nA, nB, convex, angle, length: s1 - s0, faces: [A, B], v0: key(p0), v1: key(p1) });
    }
  }
  return out;
}

const FILTERS = {
  all: () => true,
  convex: (e) => e.convex,
  concave: (e) => !e.convex,
  horizontal: (e) => Math.abs(e.t[1]) < 0.01,
  vertical: (e) => Math.abs(e.t[1]) > 0.99,
  top: (e) => (e.nA[1] > 0.99 && Math.abs(e.nB[1]) < 0.99) || (e.nB[1] > 0.99 && Math.abs(e.nA[1]) < 0.99),
  bottom: (e) => (e.nA[1] < -0.99 && Math.abs(e.nB[1]) < 0.99) || (e.nB[1] < -0.99 && Math.abs(e.nA[1]) < 0.99),
};

function edgeFilter(fn, edges) {
  if (typeof edges === 'function') return edges;
  const names = Array.isArray(edges) ? edges : [edges];
  const fns = names.map((n) => {
    if (!FILTERS[n]) throw new TypeError(`${fn}: edges must be 'all', 'top', 'bottom', 'horizontal', 'vertical', 'convex', 'concave', a list of those, or a function, got ${describe(n)}`);
    return FILTERS[n];
  });
  return (e) => fns.every((f) => f(e));
}

/** Spherical interpolation between two unit vectors. */
function slerp(a, b, f) {
  const c = Math.max(-1, Math.min(1, dot(a, b))), w = Math.acos(c);
  if (w < 1e-9) return a;
  return norm(addv(mul(a, Math.sin((1 - f) * w) / Math.sin(w)), mul(b, Math.sin(f * w) / Math.sin(w))));
}

/**
 * The section of an edge's cutter (convex) or filler (concave), as offsets from the edge
 * in the plane perpendicular to it. Overshoots the faces by eps so the boolean has no coplanar faces.
 */
function section(e, kind, amount, segments, eps) {
  const s = e.convex ? 1 : -1;
  const { nA, nB } = e;
  const c = dot(nA, nB);
  const pts = [];
  pts.push(mul(addv(nA, nB), s * eps)); // the edge itself, pushed outward (convex) or inward (concave)
  // Ta and Tb are where the new surface meets the faces; Ta' and Tb' sit just through the faces.
  let Ta, Tb;
  const inner = [];
  if (kind === 'chamfer') {
    const a = mul(norm(sub(nB, mul(nA, c))), -s), b = mul(norm(sub(nA, mul(nB, c))), -s);
    Ta = mul(a, amount); Tb = mul(b, amount);
  } else {
    const centre = mul(addv(nA, nB), -s * amount / (1 + c));
    Ta = addv(centre, mul(nA, s * amount)); Tb = addv(centre, mul(nB, s * amount));
    for (let k = 1; k < segments; k++) inner.push(addv(centre, mul(slerp(nA, nB, k / segments), s * amount)));
  }
  pts.push(addv(Ta, mul(nA, s * eps)), Ta, ...inner, Tb, addv(Tb, mul(nB, s * eps)));
  return pts;
}

/** Planes (unit normals through the end vertex) that trim one end of an edge's prism. */
function endPlanes(e, atEnd, edges) {
  const v = atEnd ? e.v1 : e.v0;
  const planes = [];
  for (const o of edges) {
    if (o === e || o.convex !== e.convex) continue;
    if (!o.faces.some((f) => e.faces.includes(f))) continue;
    let to; // the other edge's direction leaving the shared vertex, continuing our travel
    if (atEnd) { if (o.v0 === v) to = o.t; else if (o.v1 === v) to = mul(o.t, -1); else continue; }
    else { if (o.v1 === v) to = o.t; else if (o.v0 === v) to = mul(o.t, -1); else continue; }
    const n = norm(atEnd ? addv(e.t, to) : addv(to, e.t));
    if (len(n) > 1e-6 && Math.abs(dot(n, e.t)) > 0.05) planes.push(n);
  }
  if (!planes.length) planes.push(e.t);
  return planes;
}

/** Ring of points for a section placed at `station`, projected along t onto the plane(s): the nearest for a start (min), the furthest for an end (max). */
function ringAt(sec, t, station, planes, pickMax) {
  return sec.map((q) => {
    let best = pickMax ? -Infinity : Infinity;
    for (const n of planes) { const l = -dot(q, n) / dot(t, n); best = pickMax ? Math.max(best, l) : Math.min(best, l); }
    return addv(addv(station, q), mul(t, best));
  });
}

/** An edge oriented to start at vertex key v. */
const orient = (e, v) => (e.v0 === v ? e : { ...e, p0: e.p1, p1: e.p0, v0: e.v1, v1: e.v0, t: mul(e.t, -1) });
const sharedFace = (a, b) => a.faces.find((f) => b.faces.includes(f));

/**
 * Group edges of one kind into chains: an edge continues through a vertex when exactly one other
 * edge there shares a face with it, and the shared face stays the same along the chain. Returns
 * [{ edges (oriented head to tail), face, closed }].
 */
function chains(edges) {
  edges.forEach((e, i) => { e.id = i; });
  const at = new Map();
  for (const e of edges) for (const v of [e.v0, e.v1]) { const l = at.get(v); if (l) l.push(e); else at.set(v, [e]); }
  const nextOf = (e, v) => { const c = (at.get(v) ?? []).filter((o) => o.id !== e.id && sharedFace(e, o) !== undefined); return c.length === 1 ? c[0] : null; };
  const used = new Set(), out = [];
  for (const start of edges) {
    if (used.has(start.id)) continue;
    // Walk back to the head of the chain, or detect a loop.
    let head = start, v = start.v0, closed = false;
    const back = new Set([start.id]);
    for (;;) {
      const p = nextOf(head, v);
      if (!p) break;
      if (p.id === start.id) { closed = true; break; }
      if (back.has(p.id)) break;
      back.add(p.id); v = p.v0 === v ? p.v1 : p.v0; head = p;
    }
    let cur = closed ? orient(start, start.v0) : orient(head, v);
    let chain = [cur], face = null;
    used.add(cur.id);
    for (;;) {
      const n = nextOf(cur, cur.v1);
      if (!n || used.has(n.id)) break;
      const f = sharedFace(cur, n);
      if (face === null) face = f;
      if (f !== face) { out.push({ edges: chain, face, closed: false }); chain = []; face = f; }
      const o = orient(n, cur.v1);
      chain.push(o); used.add(n.id); cur = o;
    }
    const loop = closed && chain.length >= 3 && chain[chain.length - 1].v1 === chain[0].v0 && sharedFace(chain[chain.length - 1], chain[0]) === face;
    out.push({ edges: chain, face: face ?? chain[0].faces[0], closed: loop });
  }
  return out;
}

/** One continuous skin along a chain of edges: sections at every vertex, mitred, capped at open ends. */
function chainMesh({ edges: chain, face, closed }, kind, amount, segments, eps, all) {
  const k = chain.length;
  // Sections with the chain's shared face as A, so every ring has the same point order.
  const secs = chain.map((e) => section(e.faces[0] === face ? e : { ...e, nA: e.nB, nB: e.nA }, kind, amount, segments, eps));
  const n = secs[0].length;
  const rings = [];
  const stations = closed ? k : k + 1;
  for (let i = 0; i < stations; i++) {
    const ein = chain[(i - 1 + k) % k], eout = chain[i % k];
    const station = i < k ? eout.p0 : ein.p1;
    if (!closed && i === 0) rings.push(ringAt(secs[0], eout.t, station, endPlanes(eout, false, all), false));
    else if (!closed && i === k) rings.push(ringAt(secs[k - 1], ein.t, station, endPlanes(ein, true, all), true));
    else {
      let nb = norm(addv(ein.t, eout.t));
      if (len(nb) < 1e-6 || Math.abs(dot(nb, ein.t)) < 0.05) nb = ein.t;
      rings.push(ringAt(secs[(i - 1 + k) % k], ein.t, station, [nb], true));
    }
  }
  const pos = [];
  for (const ring of rings) for (const p of ring) pos.push(p[0], p[1], p[2]);
  const tris = [];
  for (let i = 0; i < k; i++) {
    const a = i * n, b = ((i + 1) % rings.length) * n;
    for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; tris.push(a + j, a + j2, b + j2, a + j, b + j2, b + j); }
  }
  if (!closed) {
    const cap = (sec, e) => { const e1 = e.faces[0] === face ? e.nA : e.nB, e2 = cross(e.t, e1); return M().triangulate([sec.map((q) => [dot(q, e1), dot(q, e2)])], 1e-9); };
    for (const [i0, i1, i2] of cap(secs[0], chain[0])) tris.push(i0, i2, i1);
    const top = k * n;
    for (const [i0, i1, i2] of cap(secs[k - 1], chain[k - 1])) tris.push(top + i0, top + i1, top + i2);
  }
  return manifoldFromTriangles('fillet', pos, tris);
}

function pass(shape, kind, amount, { want, segments, minAngle, eps }, concavePass) {
  const all = sharpEdges(shape, minAngle);
  const chosen = all.filter((e) => want(e) && (!e.convex) === concavePass);
  if (!chosen.length) return { shape, count: 0 };
  const parts = [];
  const edges = chosen.filter((e) => e.length >= amount * 0.05); // slivers: nothing to round
  for (const c of chains(edges)) {
    try { parts.push(chainMesh(c, kind, amount, segments, eps, edges)); }
    catch (err) { hooks.warn(`${kind}: skipped ${c.edges.length} edge${c.edges.length === 1 ? '' : 's'} (${err.message})`); }
  }
  if (!parts.length) return { shape, count: 0 };
  const MF = M().Manifold;
  const tool = parts.length === 1 ? parts[0] : MF.union(parts);
  const m = concavePass ? MF.union(shape.m, tool) : MF.difference(shape.m, tool);
  return { shape: shape._wrap(m), count: parts.length };
}

/**
 * Round (fillet) or bevel (chamfer) the sharp edges of a solid with planar faces.
 * opts: { edges: 'all' | 'top' | 'bottom' | 'horizontal' | 'vertical' | 'convex' | 'concave' | [...] | (edge) => bool,
 *         segments = 8, minAngle = 30 }
 */
export function filletEdges(kind, shape, amount, { edges = 'all', segments = 8, minAngle = 30 } = {}) {
  if (!(shape instanceof Shape)) throw new TypeError(`${kind}: expected a Shape, got ${describe(shape)}`);
  checkPositive(kind, kind === 'fillet' ? 'radius' : 'distance', amount);
  checkInt(kind, 'segments', segments, 1);
  const want = edgeFilter(kind, edges);
  const opts = { want, segments, minAngle, eps: Math.max(amount * 0.02, 1e-3) };
  let r = pass(shape, kind, amount, opts, true);
  r = pass(r.shape, kind, amount, opts, false);
  return r.shape;
}

export const fillet = (shape, r, opts) => (shape instanceof Shape ? filletEdges('fillet', shape, r, opts) : shape?.fillet?.(r, opts) ?? filletEdges('fillet', shape, r, opts));
export const chamfer = (shape, d, opts) => (shape instanceof Shape ? filletEdges('chamfer', shape, d, opts) : shape?.chamfer?.(d, opts) ?? filletEdges('chamfer', shape, d, opts));

Shape.prototype.fillet = function (r, opts) { return filletEdges('fillet', this, r, opts); };
Shape.prototype.chamfer = function (d, opts) { return filletEdges('chamfer', this, d, opts); };

export const filletApi = { fillet, chamfer, sharpEdges };
export const _internals = { section, chains, chainMesh, endPlanes };
