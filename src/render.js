/**
* Renderer with no browser (used by the command line and the catalogue): a small z-buffer rasteriser over the meshes a build produces,
 * same camera direction and lighting feel as the app's viewer, written out as PNG.
 *   renderThumbnail(meshes, { width, height, colorHex }) -> Buffer (PNG)
 */
import { zlibSync } from 'fflate';

const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const BG = [247, 246, 242];
const GRID = [214, 211, 203];

export function renderThumbnail(meshes, { width = 480, height = 360, colorHex = () => '#8fb3ff', supersample = 2 } = {}) {
  const W = width * supersample, H = height * supersample;
  const visible = meshes.filter((m) => !m.hidden && !m.ghost);
  // Camera basis: orthographic, looking from the app's default isometric direction.
  const eye = norm([8, 7, 10]);
  const right = norm(cross([0, 1, 0], eye));
  const up = cross(eye, right);
  const project = (x, y, z) => [x * right[0] + y * right[1] + z * right[2], x * up[0] + y * up[1] + z * up[2], x * eye[0] + y * eye[1] + z * eye[2]];

  // Fit: bounds of all visible vertices in view space, plus the ground footprint for the grid.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, gx0 = Infinity, gx1 = -Infinity, gz0 = Infinity, gz1 = -Infinity;
  for (const m of visible) {
    const P = m.positions;
    for (let i = 0; i < P.length; i += 3) {
      const [vx, vy] = project(P[i], P[i + 1], P[i + 2]);
      if (vx < minX) minX = vx; if (vx > maxX) maxX = vx; if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
      if (P[i] < gx0) gx0 = P[i]; if (P[i] > gx1) gx1 = P[i]; if (P[i + 2] < gz0) gz0 = P[i + 2]; if (P[i + 2] > gz1) gz1 = P[i + 2];
    }
  }
  if (!Number.isFinite(minX)) { minX = -10; maxX = 10; minY = -10; maxY = 10; gx0 = gz0 = -10; gx1 = gz1 = 10; }
  // Include a ground grid slightly larger than the footprint in the framing.
  const pad = Math.max(gx1 - gx0, gz1 - gz0) * 0.25 + 5;
  for (const [x, z] of [[gx0 - pad, gz0 - pad], [gx1 + pad, gz0 - pad], [gx0 - pad, gz1 + pad], [gx1 + pad, gz1 + pad]]) {
    const [vx, vy] = project(x, 0, z);
    if (vx < minX) minX = vx; if (vx > maxX) maxX = vx; if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
  }
  const scale = Math.min(W / (maxX - minX || 1), H / (maxY - minY || 1)) * 0.92;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const toScreen = (v) => [(v[0] - cx) * scale + W / 2, H / 2 - (v[1] - cy) * scale];

  const rgb = new Float32Array(W * H * 3);
  const depth = new Float32Array(W * H).fill(-Infinity);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = BG[0]; rgb[i * 3 + 1] = BG[1]; rgb[i * 3 + 2] = BG[2]; }

  // Ground grid (10 mm, heavier every 50 mm) drawn first; the model overdraws it.
  const step = 10;
  const line = (a, b, col, alpha) => {
    const [x0, y0] = toScreen(project(...a)), [x1, y1] = toScreen(project(...b));
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x0 + (x1 - x0) * (k / n)), y = Math.round(y0 + (y1 - y0) * (k / n));
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) rgb[i + c] = rgb[i + c] * (1 - alpha) + col[c] * alpha;
    }
  };
  const fx0 = Math.floor((gx0 - pad) / step) * step, fx1 = Math.ceil((gx1 + pad) / step) * step;
  const fz0 = Math.floor((gz0 - pad) / step) * step, fz1 = Math.ceil((gz1 + pad) / step) * step;
  for (let x = fx0; x <= fx1; x += step) line([x, 0, fz0], [x, 0, fz1], GRID, x % 50 === 0 ? 0.9 : 0.5);
  for (let z = fz0; z <= fz1; z += step) line([fx0, 0, z], [fx1, 0, z], GRID, z % 50 === 0 ? 0.9 : 0.5);

  const key = norm([5, 10, 7]), fill = norm([-6, -3, -4]);
  for (const m of visible) {
    const hex = colorHex(m.color);
    const base = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const P = m.positions, I = m.indices;
    const n = I ? I.length / 3 : P.length / 9;
    for (let t = 0; t < n; t++) {
      const ia = (I ? I[t * 3] : t * 3) * 3, ib = (I ? I[t * 3 + 1] : t * 3 + 1) * 3, ic = (I ? I[t * 3 + 2] : t * 3 + 2) * 3;
      const a = [P[ia], P[ia + 1], P[ia + 2]], b = [P[ib], P[ib + 1], P[ib + 2]], c = [P[ic], P[ic + 1], P[ic + 2]];
      let nrm = norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
      if (dot(nrm, eye) < 0) nrm = nrm.map((x) => -x); // double-sided, lit from the visible side
      const light = Math.min(1, 0.42 + 0.5 * Math.max(0, dot(nrm, key)) + 0.18 * Math.max(0, dot(nrm, fill)));
      const col = base.map((v) => v * light);
      const pa = project(...a), pb = project(...b), pc = project(...c);
      const [ax, ay] = toScreen(pa), [bx, by] = toScreen(pb), [cxs, cys] = toScreen(pc);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cxs))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cxs)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cys))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cys)));
      const area = (bx - ax) * (cys - ay) - (cxs - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((bx - px) * (cys - py) - (cxs - px) * (by - py)) / area;
        const w1 = ((cxs - px) * (ay - py) - (ax - px) * (cys - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
        const i = y * W + x;
        if (d <= depth[i]) continue;
        depth[i] = d;
        rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];
      }
    }
  }

  // Downsample to the output size and encode.
  const out = Buffer.alloc(height * (width * 3 + 1));
  const s = supersample, s2 = s * s;
  for (let y = 0; y < height; y++) {
    out[y * (width * 3 + 1)] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) { const i = ((y * s + dy) * W + (x * s + dx)) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; }
      const o = y * (width * 3 + 1) + 1 + x * 3;
      out[o] = Math.round(r / s2); out[o + 1] = Math.round(g / s2); out[o + 2] = Math.round(b / s2);
    }
  }
  return encodePNG(width, height, out);
}

// ---- Minimal PNG encoder (8-bit RGB, no alpha) ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(width, height, filteredRows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(filteredRows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
