import { M, track } from './engine.js';
import { Shape, Z_TO_Y, deg, rad, describe, checkNumber, checkPositive, checkNonNegative, checkInt, checkShape, checkVec } from './shape.js';
import { Sketch, sketchApi, circle, roundedRect, regularPolygon, polygon2d, extrude, revolve } from './sketch.js';

export { Shape, Sketch, deg, rad };

const MF = () => M().Manifold;

// ---------- 3D primitives ----------

export function box(w = 1, h, d) {
  let center = true;
  if (typeof w === 'object') { ({ center = true } = w); [w, h, d] = w.size ?? [1, 1, 1]; }
  h ??= w; d ??= w;
  checkPositive('box', 'width', w); checkPositive('box', 'height', h); checkPositive('box', 'depth', d);
  return new Shape(MF().cube([w, h, d], center));
}
export const cube = box;

/**
 * Box with rounded edges.
 * opts: { edges: 'all' | 'vertical', segments, center }
 * 'vertical' rounds only the four vertical edges (a rounded-rectangle footprint), which prints flat.
 */
export function roundedBox(w = 1, h = w, d = w, r = 0.1, { edges = 'all', segments, center = true } = {}) {
  if (typeof w === 'object') { const o = w; [w, h, d] = o.size ?? [1, 1, 1]; r = o.r ?? o.radius ?? 0.1; edges = o.edges ?? 'all'; segments = o.segments; center = o.center ?? true; }
  checkPositive('roundedBox', 'width', w); checkPositive('roundedBox', 'height', h); checkPositive('roundedBox', 'depth', d);
  checkNonNegative('roundedBox', 'radius', r);
  if (!['all', 'vertical'].includes(edges)) throw new TypeError(`roundedBox: edges must be 'all' or 'vertical', got ${describe(edges)}`);
  r = Math.min(r, w / 2, h / 2, d / 2);
  let s;
  if (r <= 0) s = box(w, h, d);
  else if (edges === 'vertical') s = extrude(roundedRect(w, d, r, { segments: segments ?? 8 }), h, { center: true });
  else {
    // Convex hull of eight corner spheres gives exact rounded edges and corners.
    const seg = segments ?? 24;
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      corners.push(track(track(MF().sphere(r, seg)).translate([sx * (w / 2 - r), sy * (h / 2 - r), sz * (d / 2 - r)])));
    }
    s = new Shape(MF().hull(corners));
  }
  return center ? s : s.translate(w / 2, h / 2, d / 2);
}

export function sphere(r = 1, { segments = 32 } = {}) {
  if (typeof r === 'object') { ({ r = 1, segments = 32 } = r); }
  checkPositive('sphere', 'radius', r); checkInt('sphere', 'segments', segments, 3);
  return new Shape(MF().sphere(r, segments));
}

export function cylinder(r = 1, h = 1, opts = {}) {
  let r1 = r, r2 = r, segments = 32, center = true;
  if (typeof r === 'object') ({ r = 1, r1 = r, r2 = r, h = 1, segments = 32, center = true } = r);
  else ({ segments = 32, center = true } = opts);
  checkNonNegative('cylinder', 'r1', r1); checkNonNegative('cylinder', 'r2', r2); checkPositive('cylinder', 'height', h); checkInt('cylinder', 'segments', segments, 3);
  if (r1 === 0 && r2 === 0) throw new RangeError('cylinder: at least one radius must be greater than 0');
  const zUp = track(MF().cylinder(h, r1, r2, segments, true));
  const s = new Shape(zUp.rotate(Z_TO_Y));
  return center ? s : s.translate(0, h / 2, 0);
}

export function cone(r = 1, h = 1, opts = {}) {
  return cylinder({ r1: r, r2: 0, h, ...opts });
}

export function torus(r = 1, tube = 0.3, { segments = 48, tubeSegments = 24 } = {}) {
  checkPositive('torus', 'radius', r); checkPositive('torus', 'tube', tube);
  return revolve(circle(tube, { segments: tubeSegments }).translate(r, 0), { segments });
}

/** Extrude a 2D polygon (array of [x,y]) up along Y by `h`. */
export function polygon(points, h = 1, opts = {}) {
  return extrude(polygon2d(points), h, opts);
}

/** Regular n-sided prism with circumradius r and height h, centered. */
export function prism(sides = 6, r = 1, h = 1, { center = true } = {}) {
  checkInt('prism', 'sides', sides, 3); checkPositive('prism', 'radius', r); checkPositive('prism', 'height', h);
  return extrude(regularPolygon(sides, r), h, { center });
}

/** resize(shape, [w, h, d], { auto }) — scale a shape (or sketch) to a target bounding-box size. */
export function resize(shape, size, opts) {
  if (!(shape instanceof Shape) && !(shape instanceof Sketch)) throw new TypeError(`resize: first argument must be a Shape or sketch, got ${describe(shape)}`);
  return shape.resize(size, opts);
}

// ---------- Booleans ----------

function flatShapes(fn, list) {
  const out = list.flat(Infinity).map((s) => checkShape(fn, 'argument', s));
  if (out.length === 0) throw new TypeError(`${fn}: needs at least one Shape`);
  return out;
}
const allSketches = (list) => list.length > 0 && list.every((s) => s instanceof Sketch);

/** A boolean over Shapes (or, when every argument is a sketch, the 2D equivalent). Keeps the first shape's color. */
function boolean(fn, kernelOp, sketchOp) {
  return (...shapes) => {
    const list = shapes.flat(Infinity);
    if (allSketches(list)) return sketchOp(...list);
    const l = flatShapes(fn, list);
    return l.length === 1 ? l[0] : new Shape(MF()[kernelOp](l.map((s) => s.m)), l[0].colorValue);
  };
}
export const union = boolean('union', 'union', sketchApi.union2d);
export const difference = boolean('difference', 'difference', sketchApi.difference2d);
export const intersect = boolean('intersect', 'intersection', sketchApi.intersect2d);

/** Convex hull of any number of shapes (or raw [x,y,z] points, or arrays of either). 2D sketches hull in 2D. */
export function hull(...items) {
  if (allSketches(items.flat(Infinity).filter((v) => typeof v !== 'number'))) return sketchApi.hull2d(...items);
  const pts = [];
  let color;
  const collect = (it) => {
    if (it instanceof Shape) { color ??= it.colorValue; pts.push(it.m); }
    else if (Array.isArray(it) && it.length === 3 && typeof it[0] === 'number') { checkVec('hull', 'point', it); pts.push(it); }
    else if (Array.isArray(it)) it.forEach(collect);
    else throw new TypeError(`hull: arguments must be Shapes or [x,y,z] points, got ${describe(it)}`);
  };
  items.forEach(collect);
  if (!pts.length) throw new TypeError('hull: needs at least one Shape or point');
  return new Shape(MF().hull(pts), color);
}

Shape.prototype.add = function (...o) { return union(this, ...o); };
Shape.prototype.union = function (...o) { return union(this, ...o); };
Shape.prototype.subtract = function (...o) { return difference(this, ...o); };
Shape.prototype.intersect = function (...o) { return intersect(this, ...o); };
Shape.prototype.hull = function (...o) { return hull(this, ...o); };

// ---------- Mesh-level constructions ----------

/** Flip triangles as needed so every shared edge is traversed in opposite directions (consistent winding). */
function orientConsistently(tris) {
  const n = tris.length / 3;
  const faces = Array.from({ length: n }, (_, i) => [tris[i * 3], tris[i * 3 + 1], tris[i * 3 + 2]]);
  const byEdge = new Map(); // undirected edge key -> face indices
  const key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  faces.forEach((f, i) => { for (let k = 0; k < 3; k++) { const e = key(f[k], f[(k + 1) % 3]); (byEdge.get(e) ?? byEdge.set(e, []).get(e)).push(i); } });
  const hasDirected = (f, a, b) => (f[0] === a && f[1] === b) || (f[1] === a && f[2] === b) || (f[2] === a && f[0] === b);
  const visited = new Uint8Array(n);
  for (let seed = 0; seed < n; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const stack = [seed];
    while (stack.length) {
      const i = stack.pop(), f = faces[i];
      for (let k = 0; k < 3; k++) {
        const a = f[k], b = f[(k + 1) % 3];
        for (const j of byEdge.get(key(a, b))) {
          if (j === i || visited[j]) continue;
          // Neighbour must traverse this edge as b -> a; if it also goes a -> b, flip it.
          if (hasDirected(faces[j], a, b)) faces[j] = [faces[j][0], faces[j][2], faces[j][1]];
          visited[j] = 1; stack.push(j);
        }
      }
    }
  }
  return faces.flat();
}

function manifoldFromTriangles(fn, positions, tris) {
  const { Mesh, Manifold } = M();
  const build = (triList) => {
    const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(positions), triVerts: Uint32Array.from(triList) });
    mesh.merge();
    return new Manifold(mesh);
  };
  let oriented = orientConsistently(tris);
  let m;
  try { m = build(oriented); }
  catch (err) {
    const code = err?.code ?? err?.message ?? 'invalid mesh';
    throw new Error(`${fn}: mesh is not a closed, manifold solid (${code}). Check that every edge is shared by exactly two faces.`);
  }
  if (m.status() !== 'NoError') { const st = m.status(); m.delete(); throw new Error(`${fn}: invalid mesh (${st})`); }
  if (m.volume() < 0) {
    const flipped = [];
    for (let i = 0; i < oriented.length; i += 3) flipped.push(oriented[i], oriented[i + 2], oriented[i + 1]);
    m.delete(); m = build(flipped);
  }
  return m;
}

/** Solid from an indexed triangle mesh (positions flat [x,y,z,...], tris flat indices), e.g. an imported STL. */
export function polyhedronFromMesh(name, positions, tris) {
  if (!tris.length) throw new Error(`${name}: the mesh has no triangles`);
  return new Shape(manifoldFromTriangles(name, positions, tris));
}

/**
 * Solid from raw vertices and faces, like OpenSCAD's polyhedron.
 * `points`: [[x,y,z], ...]; `faces`: arrays of point indices (triangles or planar polygons).
 * Winding is detected automatically.
 */
export function polyhedron(points, faces) {
  if (!Array.isArray(points) || points.length < 4) throw new TypeError(`polyhedron: points must be an array of at least 4 [x,y,z], got ${describe(points)}`);
  if (!Array.isArray(faces) || faces.length < 4) throw new TypeError(`polyhedron: faces must be an array of at least 4 index lists, got ${describe(faces)}`);
  points.forEach((p, i) => checkVec('polyhedron', `points[${i}]`, p));
  const tris = [];
  faces.forEach((f, i) => {
    if (!Array.isArray(f) || f.length < 3) throw new TypeError(`polyhedron: faces[${i}] must list at least 3 point indices, got ${describe(f)}`);
    f.forEach((k) => { checkInt('polyhedron', `faces[${i}] index`, k, 0); if (k >= points.length) throw new RangeError(`polyhedron: faces[${i}] refers to point ${k} but there are only ${points.length} points`); });
    for (let k = 1; k < f.length - 1; k++) tris.push(f[0], f[k], f[k + 1]);
  });
  return new Shape(manifoldFromTriangles('polyhedron', points.flat(), tris));
}

/** Resample a closed ring to n points spaced evenly by arc length. */
function resampleRing(ring, n) {
  const len = []; let total = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); len.push(l); total += l; }
  const out = []; let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (seg < ring.length - 1 && acc + len[seg] < target) { acc += len[seg]; seg++; }
    const a = ring[seg], b = ring[(seg + 1) % ring.length];
    const t = len[seg] > 0 ? (target - acc) / len[seg] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/**
 * Loft (skin) between 2D profiles stacked along Y.
 * loft([a, b, c], 30)          — profiles evenly spaced from y = 0 to 30
 * loft([a, b], [0, 12])        — explicit heights
 * opts: { segments=64 } points per profile. Profiles must be single outlines without holes.
 */
export function loft(profiles, heights = 1, { segments = 64 } = {}) {
  if (!Array.isArray(profiles) || profiles.length < 2) throw new TypeError(`loft: need an array of at least 2 sketches, got ${describe(profiles)}`);
  profiles.forEach((p, i) => { if (!(p instanceof Sketch)) throw new TypeError(`loft: profiles[${i}] must be a 2D sketch, got ${describe(p)}`); });
  checkInt('loft', 'segments', segments, 3);
  let ys;
  if (typeof heights === 'number') { checkPositive('loft', 'height', heights); ys = profiles.map((_, i) => (i / (profiles.length - 1)) * heights); }
  else {
    if (!Array.isArray(heights) || heights.length !== profiles.length) throw new TypeError(`loft: heights must be a number or one height per profile`);
    heights.forEach((h, i) => checkNumber('loft', `heights[${i}]`, h));
    for (let i = 1; i < heights.length; i++) if (heights[i] <= heights[i - 1]) throw new RangeError('loft: heights must increase');
    ys = heights;
  }
  const rings = profiles.map((p, i) => {
    const polys = p.toPolygons();
    if (polys.length !== 1) throw new Error(`loft: profiles[${i}] must be a single outline without holes (it has ${polys.length} contours)`);
    return resampleRing(polys[0], segments);
  });
  // Align each ring's start to the previous ring to avoid twisting.
  for (let i = 1; i < rings.length; i++) {
    const prev = rings[i - 1], cur = rings[i];
    let best = 0, bestD = Infinity;
    for (let off = 0; off < segments; off++) {
      let d = 0;
      for (let k = 0; k < segments; k++) { const a = prev[k], b = cur[(k + off) % segments]; d += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
      if (d < bestD) { bestD = d; best = off; }
    }
    rings[i] = cur.map((_, k) => cur[(k + best) % segments]);
  }
  const pos = [];
  rings.forEach((ring, i) => ring.forEach(([x, y]) => pos.push(x, ys[i], -y)));
  const tris = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = i * segments, b = (i + 1) * segments;
    for (let k = 0; k < segments; k++) {
      const k2 = (k + 1) % segments;
      tris.push(a + k, a + k2, b + k2, a + k, b + k2, b + k);
    }
  }
  const cap = M().triangulate([rings[0]], 1e-9);
  const top = (rings.length - 1) * segments;
  for (const [i0, i1, i2] of cap) { tris.push(i0, i2, i1); tris.push(top + i0, top + i1, top + i2); }
  return new Shape(manifoldFromTriangles('loft', pos, tris));
}

// ---------- Roof ----------

/**
 * Solid over a sketch whose height at each point is the distance to the nearest outline edge
 * (times tan(angle)), like OpenSCAD's roof(): a pyramid from a square, a hip roof from a rectangle,
 * a cone from a circle; holes and concave corners form valleys. The base sits on y = 0.
 * opts: { angle=45 (slope in degrees, 0 < angle < 90), segments=16, tolerance=0.01 }
 *
 * Built exactly: a point lies above the roof when some outline point is closer than its height, so
 * the part to remove from the straight extrusion is, per edge, hull(cone at a, cone at b). Those are
 * subtracted in small sequential batches with staggered cone heights, which the kernel handles far
 * faster than one union of hundreds of overlapping, coplanar-topped cutters. `tolerance` simplifies
 * the outline first (text outlines carry many sub-0.01 mm edges that cost time and add nothing).
 */
export function roof(sketch, { angle = 45, segments = 16, tolerance = 0.01 } = {}) {
  if (!(sketch instanceof Sketch)) throw new TypeError(`roof: first argument must be a 2D sketch, got ${describe(sketch)}`);
  checkNumber('roof', 'angle', angle); checkInt('roof', 'segments', segments, 3); checkNonNegative('roof', 'tolerance', tolerance);
  if (!(angle > 0 && angle < 90)) throw new RangeError(`roof: angle must be between 0 and 90 degrees, got ${angle}`);
  if (sketch.isEmpty()) throw new RangeError('roof: the sketch is empty');
  const cs = tolerance > 0 ? track(sketch.cs.simplify(tolerance)) : sketch.cs;
  const slope = Math.tan((angle * Math.PI) / 180);
  // No point is farther from the outline than half the smaller bounding-box side.
  const R = Math.min(...sketch.bounds().size) / 2 * 1.01 + 1e-6;
  const H = R * slope;
  // A few cone sizes so neighbouring cutters never share a top plane (coplanar faces are the slow path).
  const cones = Array.from({ length: 7 }, (_, k) => { const r = R * (1.05 + 0.03 * k); return track(MF().cylinder(r * slope, 0, r, segments, false)); });
  const cutters = [];
  let k = 0;
  for (const ring of cs.toPolygons()) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], cone = cones[k++ % cones.length];
      cutters.push(track(MF().hull([track(cone.translate([a[0], a[1], 0])), track(cone.translate([b[0], b[1], 0]))])));
    }
  }
  let zUp = track(cs.extrude(H));
  const CHUNK = 32;
  for (let i = 0; i < cutters.length; i += CHUNK) {
    zUp = track(MF().difference([zUp, ...cutters.slice(i, i + CHUNK)]));
    zUp.numTri(); // evaluate now; one lazy tree over every cutter is the slow path again
  }
  return new Shape(zUp.rotate(Z_TO_Y));
}
Sketch.prototype.roof = function (opts) { return roof(this, opts); };

// ---------- Minkowski, rounding, shell ----------

/** Minkowski sum: sweep `b` over every point of `a`. Rounds `a` when `b` is a sphere. */
export function minkowski(a, b) {
  checkShape('minkowski', 'a', a); checkShape('minkowski', 'b', b);
  return new Shape(a.m.minkowskiSum(b.m), a.colorValue);
}
Shape.prototype.minkowski = function (b) { return minkowski(this, b); };
/** Round all convex edges and corners with radius r (grows the shape by r). */
Shape.prototype.round = function (r = 1, { segments = 16 } = {}) {
  checkPositive('round', 'radius', r);
  return minkowski(this, sphere(r, { segments }));
};
/** Unique face planes [nx, ny, nz, d] of a mesh (n·p = d). */
function facePlanes(shape, limit = Infinity) {
  const { positions: P, indices: I } = shape.toMesh();
  const planes = new Map();
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    nx /= l; ny /= l; nz /= l;
    const d = nx * P[a] + ny * P[a + 1] + nz * P[a + 2];
    const key = `${nx.toFixed(5)},${ny.toFixed(5)},${nz.toFixed(5)},${d.toFixed(4)}`;
    if (!planes.has(key)) { planes.set(key, [nx, ny, nz, d]); if (planes.size > limit) return null; }
  }
  return [...planes.values()];
}

const isConvex = (shape) => Math.abs(hull(shape).volume() - shape.volume()) < 1e-6 * Math.max(1, shape.volume());

/**
 * Shrink the solid inward by `t` on every face.
 * Convex solids with few faces are eroded exactly by pushing each face plane inward (fast);
 * everything else uses a Minkowski difference with a sphere.
 */
Shape.prototype.erode = function (t = 1, { segments = 16 } = {}) {
  checkPositive('erode', 'thickness', t);
  const planes = isConvex(this) ? facePlanes(this, 128) : null;
  if (planes) {
    let m = this.m;
    for (const [nx, ny, nz, d] of planes) m = track(m.trimByPlane([-nx, -ny, -nz], -(d - t)));
    return new Shape(m, this.colorValue);
  }
  const ball = sphere(t, { segments });
  return new Shape(this.m.minkowskiDifference(ball.m), this.colorValue);
};

const SIDES = { top: [0, 1, 0], bottom: [0, -1, 0], left: [-1, 0, 0], right: [1, 0, 0], front: [0, 0, 1], back: [0, 0, -1] };

/**
 * Hollow a solid to a wall thickness `t`.
 * opts: { open: 'top' | ['top', 'front'] … removes those walls, segments }
 */
export function shell(shape, t = 1, { open = [], segments = 12 } = {}) {
  checkShape('shell', 'shape', shape); checkPositive('shell', 'thickness', t);
  const opens = [open].flat().filter(Boolean);
  for (const o of opens) if (!SIDES[o]) throw new TypeError(`shell: open must be one of ${Object.keys(SIDES).join(', ')}, got ${describe(o)}`);
  const inner = shape.erode(t, { segments });
  if (inner.isEmpty()) throw new RangeError(`shell: thickness ${t} leaves no interior; use a smaller value`);
  const cutters = [inner];
  const size = shape.bounds().size;
  // A convex cavity sweeps exactly as a hull, which is much cheaper than a Minkowski sum.
  const convex = isConvex(inner);
  for (const o of opens) {
    const d = SIDES[o];
    const L = Math.max(...size) + 2 * t;
    const moved = inner.translate(d[0] * L, d[1] * L, d[2] * L);
    if (convex) cutters.push(hull(inner, moved));
    else {
      const rod = box(1e-3 + Math.abs(d[0]) * L, 1e-3 + Math.abs(d[1]) * L, 1e-3 + Math.abs(d[2]) * L).translate(d[0] * L / 2, d[1] * L / 2, d[2] * L / 2);
      cutters.push(minkowski(inner, rod));
    }
  }
  return difference(shape, ...cutters);
}
Shape.prototype.shell = function (t, opts) { return shell(this, t, opts); };

// ---------- Arrays (return arrays of shapes; pass to union() to merge) ----------

/** `count` copies stepped by `step` ([dx,dy,dz], or a number along X). */
export function linearArray(shape, count = 2, step = 1) {
  checkShape('linearArray', 'shape', shape); checkInt('linearArray', 'count', count);
  const [dx, dy, dz] = typeof step === 'number' ? [checkNumber('linearArray', 'step', step), 0, 0] : checkVec('linearArray', 'step', step);
  return Array.from({ length: count }, (_, i) => shape.translate(dx * i, dy * i, dz * i));
}

/**
 * `count` copies around an axis.
 * opts: { radius=0, axis='y', start=0, sweep=360, rotateCopies=true }
 */
export function polarArray(shape, count = 6, { radius = 0, axis = 'y', start = 0, sweep = 360, rotateCopies = true } = {}) {
  checkShape('polarArray', 'shape', shape); checkInt('polarArray', 'count', count);
  checkNumber('polarArray', 'radius', radius); checkNumber('polarArray', 'start', start); checkNumber('polarArray', 'sweep', sweep);
  const full = Math.abs(sweep) >= 360 - 1e-9;
  const stepA = full ? sweep / count : sweep / Math.max(1, count - 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = start + stepA * i;
    let s = shape;
    if (radius) s = s.translate(axis === 'x' ? [0, radius, 0] : [radius, 0, 0]);
    const rot = { x: [a, 0, 0], y: [0, a, 0], z: [0, 0, a] }[axis];
    if (!rot) throw new Error(`polarArray: axis must be 'x', 'y' or 'z'`);
    if (rotateCopies || radius) s = s.rotate(...rot);
    out.push(s);
  }
  return out;
}

/** nx × nz grid on the ground plane. opts: { center=true } */
export function grid(shape, [nx = 2, nz = 2] = [], [dx = 1, dz = dx] = [], { center = true } = {}) {
  checkShape('grid', 'shape', shape); checkInt('grid', 'nx', nx); checkInt('grid', 'nz', nz); checkNumber('grid', 'dx', dx); checkNumber('grid', 'dz', dz);
  const ox = center ? -((nx - 1) * dx) / 2 : 0, oz = center ? -((nz - 1) * dz) / 2 : 0;
  const out = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push(shape.translate(ox + i * dx, 0, oz + j * dz));
  return out;
}

// ---------- Screw helpers (millimetres, ISO metric) ----------
// clearance: ISO 273 medium fit. head: ISO 4762 socket cap (dia, height).
// csk: ISO 10642 countersunk head dia (90°). nut: ISO 4032 across-flats, thickness.
// insert: typical heat-set insert hole dia. tap: tap drill dia.
export const SCREWS = {
  M2:   { d: 2,   clearance: 2.4, head: [3.8, 2.0],  csk: 3.8,  nut: [4.0, 1.6],  insert: 3.2,  tap: 1.6 },
  M2_5: { d: 2.5, clearance: 2.9, head: [4.5, 2.5],  csk: 4.7,  nut: [5.0, 2.0],  insert: 3.5,  tap: 2.05 },
  M3:   { d: 3,   clearance: 3.4, head: [5.5, 3.0],  csk: 6.7,  nut: [5.5, 2.4],  insert: 4.0,  tap: 2.5 },
  M4:   { d: 4,   clearance: 4.5, head: [7.0, 4.0],  csk: 9.0,  nut: [7.0, 3.2],  insert: 5.6,  tap: 3.3 },
  M5:   { d: 5,   clearance: 5.5, head: [8.5, 5.0],  csk: 11.2, nut: [8.0, 4.7],  insert: 6.4,  tap: 4.2 },
  M6:   { d: 6,   clearance: 6.6, head: [10.0, 6.0], csk: 13.4, nut: [10.0, 5.2], insert: 8.0,  tap: 5.0 },
  M8:   { d: 8,   clearance: 9.0, head: [13.0, 8.0], csk: 17.9, nut: [13.0, 6.8], insert: 10.0, tap: 6.8 },
};
export function screw(size) {
  const key = String(size).toUpperCase().replace('.', '_');
  const s = SCREWS[key] ?? SCREWS['M' + key];
  if (!s) throw new Error(`Unknown screw size "${size}". Known: ${Object.keys(SCREWS).join(', ').replace(/_/g, '.')}`);
  return s;
}

const OVERSHOOT = 1; // cutters poke this far above y=0 so subtractions cut cleanly through the top face

/**
 * A cutter to subtract for a screw hole. Axis is Y, the top surface is y = 0, the shank goes down `length`.
 * opts: { type: 'clearance' | 'tap' | 'countersunk' | 'counterbore', headDepth, tolerance=0.2, segments=32 }
 */
export function screwHole(size, length = 10, { type = 'clearance', headDepth, tolerance = 0.2, segments = 32 } = {}) {
  const s = screw(size);
  checkPositive('screwHole', 'length', length); checkNonNegative('screwHole', 'tolerance', tolerance); checkInt('screwHole', 'segments', segments, 3);
  const shank = ((type === 'tap' ? s.tap : s.clearance) + tolerance) / 2;
  const L = length, O = OVERSHOOT;
  let profile;
  if (type === 'clearance' || type === 'tap') {
    profile = [[0, -L], [shank, -L], [shank, O], [0, O]];
  } else if (type === 'counterbore') {
    const [hd, hh] = s.head;
    const head = (hd + tolerance) / 2, depth = headDepth ?? hh;
    profile = [[0, -L], [shank, -L], [shank, -depth], [head, -depth], [head, O], [0, O]];
  } else if (type === 'countersunk') {
    const top = (s.csk + tolerance) / 2;
    const depth = top - shank; // 90° countersink
    profile = [[0, -L], [shank, -L], [shank, -depth], [top, 0], [top, O], [0, O]];
  } else {
    throw new Error(`screwHole: unknown type "${type}"`);
  }
  return revolve(polygon2d(profile), { segments });
}

/** Hexagonal nut pocket cutter: axis Y, top at y = 0. opts: { depth, tolerance=0.2 } */
export function nutPocket(size, { depth, tolerance = 0.2 } = {}) {
  const [af, t] = screw(size).nut;
  const d = depth ?? t;
  const r = (af + tolerance) / Math.sqrt(3);
  return prism(6, r, d + OVERSHOOT).rotate(0, 30, 0).translate(0, OVERSHOOT / 2 - d / 2, 0);
}

/** Heat-set insert hole cutter: axis Y, top at y = 0. opts: { depth, tolerance=0, segments } */
export function heatInsert(size, { depth, tolerance = 0, segments = 32 } = {}) {
  const s = screw(size);
  const d = depth ?? s.d * 2;
  return cylinder((s.insert + tolerance) / 2, d + OVERSHOOT, { segments }).translate(0, OVERSHOOT / 2 - d / 2, 0);
}

export const api = {
  ...sketchApi,
  Shape, box, cube, roundedBox, sphere, cylinder, cone, torus, polygon, prism,
  union, difference, intersect, hull, minkowski, shell, polyhedron, loft, resize, roof,
  linearArray, polarArray, grid,
  SCREWS, screw, screwHole, nutPocket, heatInsert,
  deg, rad,
};
