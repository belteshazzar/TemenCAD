/**
 * Renderer with no browser (used by the command line and the catalogue): a small z-buffer rasteriser
 * over the meshes a build produces, written out as PNG.
 *   renderThumbnail(meshes, { width, height, colorHex })            -> Buffer (PNG), one isometric view, no labels
 *   renderViews(meshes, { views, width, height, colorHex, labels, section, ghosts }) -> Buffer (PNG), a contact sheet
 * views: any of 'iso' 'top' 'bottom' 'front' 'back' 'left' 'right' (width × height is the size of ONE view).
 * Ghost meshes are drawn translucent; `section: { axis, value }` tints faces lying on that plane as cut faces.
 * Labels (part names, view title with the size, a scale bar, an axis triad) need a registered font; without one they are skipped.
 */
import { zlibSync } from 'fflate';
import { textOutlines } from './fonts.js';

const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const BG = [247, 246, 242];
const GRID = [214, 211, 203];
const INK = [60, 60, 60];
const CUT = [224, 96, 74];
const AXIS = { x: [220, 70, 60], y: [60, 170, 90], z: [50, 110, 220] };

/** Camera basis per view: eye direction (toward the viewer) and the screen-up hint. */
const VIEWS = {
  iso: { eye: norm([8, 7, 10]), up: [0, 1, 0], grid: 'plane', title: 'isometric' },
  top: { eye: [0, 1, 0], up: [0, 0, -1], grid: 'plane', title: 'top (X across, Z down)' },
  bottom: { eye: [0, -1, 0], up: [0, 0, 1], grid: 'none', title: 'bottom (X across, Z up)' },
  front: { eye: [0, 0, 1], up: [0, 1, 0], grid: 'line', title: 'front (X across, Y up)' },
  back: { eye: [0, 0, -1], up: [0, 1, 0], grid: 'line', title: 'back' },
  right: { eye: [1, 0, 0], up: [0, 1, 0], grid: 'line', title: 'right (Z across, Y up)' },
  left: { eye: [-1, 0, 0], up: [0, 1, 0], grid: 'line', title: 'left' },
};
export const VIEW_NAMES = Object.keys(VIEWS);

const hexToRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

function meshBounds(meshes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) { const P = m.positions; for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < min[k]) min[k] = P[i + k]; if (P[i + k] > max[k]) max[k] = P[i + k]; } }
  if (!Number.isFinite(min[0])) return { min: [-10, 0, -10], max: [10, 10, 10] };
  return { min, max };
}

/** A canvas: supersampled float RGB with a depth buffer, plus drawing helpers. */
class Canvas {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.rgb = new Float32Array(W * H * 3);
    this.depth = new Float32Array(W * H).fill(-Infinity);
    for (let i = 0; i < W * H; i++) { this.rgb[i * 3] = BG[0]; this.rgb[i * 3 + 1] = BG[1]; this.rgb[i * 3 + 2] = BG[2]; }
  }
  blend(x, y, col, alpha) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = (y * this.W + x) * 3;
    for (let c = 0; c < 3; c++) this.rgb[i + c] = this.rgb[i + c] * (1 - alpha) + col[c] * alpha;
  }
  line2d(x0, y0, x1, y1, col, alpha = 1, thick = 1) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let k = 0; k <= n; k++) {
      const x = x0 + (x1 - x0) * (k / n), y = y0 + (y1 - y0) * (k / n);
      for (let dy = 0; dy < thick; dy++) for (let dx = 0; dx < thick; dx++) this.blend(Math.round(x + dx - (thick - 1) / 2), Math.round(y + dy - (thick - 1) / 2), col, alpha);
    }
  }
  /** Fill 2D rings (even-odd) with a colour; coordinates in canvas pixels. */
  fillRings(rings, col, alpha = 1) {
    let y0 = Infinity, y1 = -Infinity;
    for (const r of rings) for (const [, y] of r) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.H - 1, Math.ceil(y1)); y++) {
      const sy = y + 0.5, xs = [];
      for (const r of rings) for (let i = 0; i < r.length; i++) {
        const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
        if ((ay <= sy) !== (by <= sy)) xs.push(ax + ((sy - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.round(xs[k])); x < Math.min(this.W, Math.round(xs[k + 1])); x++) this.blend(x, y, col, alpha);
    }
  }
  /** Text at (x, y) = baseline start; size in pixels. Silently skipped when no font is registered. */
  text(str, x, y, size, col = INK, { align = 'left', weight = 'Inter' } = {}) {
    let out;
    try { out = textOutlines(str, { size, font: weight, align, curveSegments: 4 }); } catch { return 0; }
    this.fillRings(out.rings.map((r) => r.map(([px, py]) => [x + px, y - py])), col);
    return out.width;
  }
  textWidth(str, size, weight = 'Inter') { try { return textOutlines(str, { size, font: weight }).width; } catch { return 0; } }
}

/** Draw one view into a region of the canvas. */
function drawView(cv, region, meshes, viewName, { colorHex, labels, section, ghosts, supersample }) {
  const view = VIEWS[viewName];
  const { eye } = view;
  const right = norm(cross(view.up, eye)), up = cross(eye, right);
  const project = (x, y, z) => [x * right[0] + y * right[1] + z * right[2], x * up[0] + y * up[1] + z * up[2], x * eye[0] + y * eye[1] + z * eye[2]];
  const solid = meshes.filter((m) => !m.hidden && !m.ghost);
  const ghostMeshes = ghosts ? meshes.filter((m) => !m.hidden && m.ghost) : [];
  const framed = [...solid, ...ghostMeshes];
  const { min: bmin, max: bmax } = meshBounds(solid.length ? solid : framed);
  const fb = meshBounds(framed.length ? framed : solid);

  // Fit the framed meshes plus (for plane grids) a ground pad around the footprint.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (x, y, z) => { const [vx, vy] = project(x, y, z); if (vx < minX) minX = vx; if (vx > maxX) maxX = vx; if (vy < minY) minY = vy; if (vy > maxY) maxY = vy; };
  for (const x of [fb.min[0], fb.max[0]]) for (const y of [fb.min[1], fb.max[1]]) for (const z of [fb.min[2], fb.max[2]]) take(x, y, z);
  const pad = Math.max(fb.max[0] - fb.min[0], fb.max[2] - fb.min[2]) * 0.2 + 4;
  const gx0 = fb.min[0] - pad, gx1 = fb.max[0] + pad, gz0 = fb.min[2] - pad, gz1 = fb.max[2] + pad;
  if (view.grid === 'plane') for (const [x, z] of [[gx0, gz0], [gx1, gz0], [gx0, gz1], [gx1, gz1]]) take(x, 0, z);
  const { x: rx, y: ry, w: rw, h: rh } = region;
  const margin = labels ? 0.8 : 0.92;
  const scale = Math.min(rw / (maxX - minX || 1), rh / (maxY - minY || 1)) * margin;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const toScreen = (v) => [rx + (v[0] - cx) * scale + rw / 2, ry + rh / 2 - (v[1] - cy) * scale];
  const line3 = (a, b, col, alpha, thick = 1) => { const [x0, y0] = toScreen(project(...a)), [x1, y1] = toScreen(project(...b)); cv.line2d(x0, y0, x1, y1, col, alpha, thick); };

  // Ground grid (10 mm, heavier every 50 mm) first; the model overdraws it.
  const step = 10;
  if (view.grid === 'plane') {
    const fx0 = Math.floor(gx0 / step) * step, fx1 = Math.ceil(gx1 / step) * step, fz0 = Math.floor(gz0 / step) * step, fz1 = Math.ceil(gz1 / step) * step;
    for (let x = fx0; x <= fx1; x += step) line3([x, 0, fz0], [x, 0, fz1], GRID, x % 50 === 0 ? 0.9 : 0.5);
    for (let z = fz0; z <= fz1; z += step) line3([fx0, 0, z], [fx1, 0, z], GRID, z % 50 === 0 ? 0.9 : 0.5);
  } else if (view.grid === 'line') { // the ground plane seen edge-on
    const [, gy] = toScreen(project(0, 0, 0));
    cv.line2d(rx, gy, rx + rw, gy, GRID, 0.9, supersample);
  }

  // Lights follow the camera so every view reads the same: key from the upper left front, soft fill from the other side.
  const key = norm([0.45 * right[0] + 0.6 * up[0] + 0.65 * eye[0], 0.45 * right[1] + 0.6 * up[1] + 0.65 * eye[1], 0.45 * right[2] + 0.6 * up[2] + 0.65 * eye[2]]);
  const fill = norm([-0.5 * right[0] - 0.3 * up[0] - 0.4 * eye[0], -0.5 * right[1] - 0.3 * up[1] - 0.4 * eye[1], -0.5 * right[2] - 0.3 * up[2] - 0.4 * eye[2]]);
  const raster = (m, alpha, writeDepth) => {
    const base = hexToRgb(colorHex(m.color));
    const P = m.positions, I = m.indices;
    const n = I ? I.length / 3 : P.length / 9;
    for (let t = 0; t < n; t++) {
      const ia = (I ? I[t * 3] : t * 3) * 3, ib = (I ? I[t * 3 + 1] : t * 3 + 1) * 3, ic = (I ? I[t * 3 + 2] : t * 3 + 2) * 3;
      const a = [P[ia], P[ia + 1], P[ia + 2]], b = [P[ib], P[ib + 1], P[ib + 2]], c = [P[ic], P[ic + 1], P[ic + 2]];
      let nrm = norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
      if (dot(nrm, eye) < 0) nrm = nrm.map((x) => -x);
      const light = Math.min(1, 0.42 + 0.5 * Math.max(0, dot(nrm, key)) + 0.18 * Math.max(0, dot(nrm, fill)));
      let col = base.map((v) => v * light);
      if (section) { // faces lying on the section plane are cut faces
        const k = 'xyz'.indexOf(section.axis);
        if (Math.abs(a[k] - section.value) < 1e-4 && Math.abs(b[k] - section.value) < 1e-4 && Math.abs(c[k] - section.value) < 1e-4) col = CUT;
      }
      const pa = project(...a), pb = project(...b), pc = project(...c);
      const [ax, ay] = toScreen(pa), [bx, by] = toScreen(pb), [cxs, cys] = toScreen(pc);
      const x0 = Math.max(rx, Math.floor(Math.min(ax, bx, cxs))), x1 = Math.min(rx + rw - 1, Math.ceil(Math.max(ax, bx, cxs)));
      const y0 = Math.max(ry, Math.floor(Math.min(ay, by, cys))), y1 = Math.min(ry + rh - 1, Math.ceil(Math.max(ay, by, cys)));
      const area = (bx - ax) * (cys - ay) - (cxs - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((bx - px) * (cys - py) - (cxs - px) * (by - py)) / area;
        const w1 = ((cxs - px) * (ay - py) - (ax - px) * (cys - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
        const i = y * cv.W + x;
        if (d <= cv.depth[i]) continue;
        if (writeDepth) { cv.depth[i] = d; cv.rgb[i * 3] = col[0]; cv.rgb[i * 3 + 1] = col[1]; cv.rgb[i * 3 + 2] = col[2]; }
        else cv.blend(x, y, col, alpha);
      }
    }
  };
  for (const m of solid) raster(m, 1, true);
  // Ghosts: translucent over everything in front of them, and their outline stays faint behind solids.
  for (const m of ghostMeshes) raster(m, 0.35, false);

  if (!labels) return;
  const S = supersample, fs = 13 * S, small = 11 * S;
  // Title with the visible size in this view's axes.
  const size = [0, 1, 2].map((k) => bmax[k] - bmin[k]);
  const fmt = (v) => (Math.abs(v - Math.round(v)) < 0.005 ? String(Math.round(v)) : v.toFixed(1));
  const dims = viewName === 'iso' ? `${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm (X × Y × Z)`
    : viewName === 'top' || viewName === 'bottom' ? `${fmt(size[0])} × ${fmt(size[2])} mm`
    : viewName === 'front' || viewName === 'back' ? `${fmt(size[0])} × ${fmt(size[1])} mm`
    : `${fmt(size[2])} × ${fmt(size[1])} mm`;
  cv.text(view.title, rx + 12 * S, ry + 20 * S, fs, INK, { weight: 'Inter Bold' });
  cv.text(dims, rx + 12 * S, ry + 36 * S, small, [110, 110, 110]);
  if (section) cv.text(`section at ${section.axis} = ${fmt(section.value)}`, rx + 12 * S, ry + 52 * S, small, CUT);
  // Scale bar: a round length that is about a sixth of the view.
  const target = rw / 6 / scale;
  const len = [1, 2, 5, 10, 20, 50, 100, 200, 500].reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), 10);
  const bx = rx + 12 * S, by = ry + rh - 14 * S, bw = len * scale;
  cv.line2d(bx, by, bx + bw, by, INK, 1, 2 * S);
  cv.line2d(bx, by - 4 * S, bx, by + 4 * S, INK, 1, S); cv.line2d(bx + bw, by - 4 * S, bx + bw, by + 4 * S, INK, 1, S);
  cv.text(`${len} mm`, bx + bw + 8 * S, by + 4 * S, small);
  // Axis triad in the lower right.
  const ox = rx + rw - 40 * S, oy = ry + rh - 30 * S, al = 22 * S;
  for (const [name, dir] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
    const [vx, vy] = project(...dir);
    if (Math.hypot(vx, vy) < 0.05) continue; // pointing at the viewer
    const ex = ox + vx * al, ey = oy - vy * al;
    cv.line2d(ox, oy, ex, ey, AXIS[name], 1, 2 * S);
    cv.text(name.toUpperCase(), ex + (vx >= 0 ? 3 * S : -9 * S), ey + (vy >= 0 ? -2 * S : 10 * S), small, AXIS[name], { weight: 'Inter Bold' });
  }
  // Part labels at the top of each part's bounding box, with a short leader.
  if (solid.length > 1 || (solid.length === 1 && solid[0].name)) {
    const used = [];
    for (const m of solid) {
      if (!m.name) continue;
      const b = meshBounds([m]);
      const c = [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2];
      let [lx, ly] = toScreen(project(...c));
      let ty = ly - 14 * S;
      for (const u of used) if (Math.abs(u[0] - lx) < 60 * S && Math.abs(u[1] - ty) < 14 * S) ty = u[1] - 14 * S;
      used.push([lx, ty]);
      cv.line2d(lx, ly, lx, ty + 3 * S, INK, 0.8, S);
      const w = cv.textWidth(m.name, small, 'Inter Bold');
      const tx = Math.min(rx + rw - w - 4 * S, Math.max(rx + 4 * S, lx - w / 2));
      cv.fillRings([[[tx - 3 * S, ty - small], [tx + w + 3 * S, ty - small], [tx + w + 3 * S, ty + 3 * S], [tx - 3 * S, ty + 3 * S]]], BG, 0.75);
      cv.text(m.name, tx, ty, small, INK, { weight: 'Inter Bold' });
    }
  }
}

/** Several views tiled into one picture; width × height is the size of one view. */
export function renderViews(meshes, { views = ['iso'], width = 480, height = 360, colorHex = () => '#8fb3ff', supersample = 2, labels = true, section = null, ghosts = true } = {}) {
  const names = views.filter((v) => VIEWS[v]);
  if (!names.length) throw new Error(`renderViews: views must be some of ${VIEW_NAMES.join(', ')}`);
  const cols = names.length === 1 ? 1 : names.length <= 4 ? 2 : 3, rows = Math.ceil(names.length / cols);
  const S = supersample, W = width * S * cols, H = height * S * rows;
  const cv = new Canvas(W, H);
  names.forEach((name, i) => {
    const region = { x: (i % cols) * width * S, y: Math.floor(i / cols) * height * S, w: width * S, h: height * S };
    drawView(cv, region, meshes, name, { colorHex, labels, section, ghosts, supersample: S });
    if (names.length > 1) { // tile borders
      cv.line2d(region.x, region.y, region.x + region.w, region.y, GRID, 1, S);
      cv.line2d(region.x, region.y, region.x, region.y + region.h, GRID, 1, S);
    }
  });
  return downsample(cv, width * cols, height * rows, S);
}

/** One isometric view without labels (catalogue thumbnails). */
export function renderThumbnail(meshes, { width = 480, height = 360, colorHex = () => '#8fb3ff', supersample = 2 } = {}) {
  return renderViews(meshes, { views: ['iso'], width, height, colorHex, supersample, labels: false, ghosts: false });
}

function downsample(cv, width, height, s) {
  const out = Buffer.alloc(height * (width * 3 + 1));
  const s2 = s * s;
  for (let y = 0; y < height; y++) {
    out[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) { const i = ((y * s + dy) * cv.W + (x * s + dx)) * 3; r += cv.rgb[i]; g += cv.rgb[i + 1]; b += cv.rgb[i + 2]; }
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
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(filteredRows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
