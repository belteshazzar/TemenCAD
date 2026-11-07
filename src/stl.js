/**
 * STL reader (binary or ASCII). Returns { positions: Float32Array, tris: Uint32Array } with
 * coordinates converted from the slicer's Z-up to our Y-up frame: (x, y, z) -> (x, z, -y).
 * Vertices are welded by exact position so the kernel sees a closed mesh.
 */
export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const isAscii = /^\s*solid/i.test(head) && !looksBinary(bytes);
  const raw = isAscii ? parseAscii(new TextDecoder().decode(bytes)) : parseBinary(bytes);
  return weld(raw);
}

function looksBinary(bytes) {
  if (bytes.length < 84) return false;
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
  return bytes.length === 84 + n * 50;
}

function parseBinary(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const n = view.getUint32(80, true);
  if (bytes.length < 84 + n * 50) throw new Error('STL file is truncated');
  const out = new Float32Array(n * 9);
  for (let t = 0, o = 84 + 12; t < n; t++, o += 50) {
    for (let k = 0; k < 9; k++) out[t * 9 + k] = view.getFloat32(o + k * 4, true);
  }
  return out;
}

function parseAscii(text) {
  const out = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  if (out.length % 9 !== 0) throw new Error('ASCII STL has an incomplete facet');
  return Float32Array.from(out);
}

function weld(raw) {
  const n = raw.length / 3;
  const index = new Map();
  const positions = [];
  const tris = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    // Z-up -> Y-up
    const x = raw[i * 3], y = raw[i * 3 + 2], z = -raw[i * 3 + 1];
    const key = `${x},${y},${z}`;
    let id = index.get(key);
    if (id === undefined) { id = positions.length / 3; index.set(key, id); positions.push(x, y, z); }
    tris[i] = id;
  }
  return { positions: Float32Array.from(positions), tris };
}
