import { M } from './engine.js';

/** Flip triangles as needed so every shared edge is traversed in opposite directions (consistent winding). */
export function orientConsistently(tris) {
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

export function manifoldFromTriangles(fn, positions, tris) {
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
