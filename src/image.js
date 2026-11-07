import { unzlibSync } from 'fflate';
import { Shape, describe, checkNumber, checkPositive, checkNonNegative, checkInt } from './shape.js';
import { manifoldFromTriangles } from './mesh.js';

/*
 * Images in a project (`import photo from './photo.png'`) become GrayImage values: a width, a height
 * and one brightness per pixel (0 black .. 1 white, transparency composited onto white).
 * heightmap() turns one into a relief, lithophane() into a thin plate whose thickness follows the image.
 */

/** A grayscale image. Immutable; every op returns a new image. */
export class GrayImage {
  constructor(width, height, gray) { this.width = width; this.height = height; this.gray = gray; Object.freeze(this); }

  /** From RGBA bytes (as a canvas gives them). */
  static fromRGBA(width, height, rgba) {
    const gray = new Float32Array(width * height);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      const a = rgba[j + 3] / 255;
      const lum = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
      gray[i] = lum * a + (1 - a);
    }
    return new GrayImage(width, height, gray);
  }
  /** From a function (x, y) -> 0..1 over a width × height grid. */
  static fromFunction(width, height, fn) {
    const gray = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray[y * width + x] = fn(x, y);
    return new GrayImage(width, height, gray);
  }

  /** Brightness at pixel (x, y), clamped to the edges. */
  at(x, y) {
    x = Math.min(this.width - 1, Math.max(0, x)); y = Math.min(this.height - 1, Math.max(0, y));
    return this.gray[y * this.width + x];
  }
  /** Bilinear brightness at fractional pixel coordinates. */
  sample(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const a = this.at(x0, y0), b = this.at(x0 + 1, y0), c = this.at(x0, y0 + 1), d = this.at(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  invert() { return new GrayImage(this.width, this.height, this.gray.map((v) => 1 - v)); }
  /** Raise brightness to a power: < 1 lightens the mid-tones, > 1 darkens them. */
  gamma(g = 1) { checkPositive('gamma', 'gamma', g); return new GrayImage(this.width, this.height, this.gray.map((v) => Math.pow(v, g))); }
  /** Stretch the brightness so the darkest pixel is 0 and the lightest 1. */
  normalize() {
    let lo = Infinity, hi = -Infinity;
    for (const v of this.gray) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const r = hi - lo || 1;
    return new GrayImage(this.width, this.height, this.gray.map((v) => (v - lo) / r));
  }
  /** Box blur with the given radius in pixels (applied twice, which is close to a Gaussian). */
  blur(radius = 1) {
    checkInt('blur', 'radius', radius, 0);
    if (radius === 0) return this;
    let g = this.gray;
    const { width: w, height: h } = this;
    const pass = (src) => {
      const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
      const n = 2 * radius + 1;
      for (let y = 0; y < h; y++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) acc += src[y * w + Math.min(w - 1, Math.max(0, k))];
        for (let x = 0; x < w; x++) {
          tmp[y * w + x] = acc / n;
          acc += src[y * w + Math.min(w - 1, x + radius + 1)] - src[y * w + Math.max(0, x - radius)];
        }
      }
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
        for (let y = 0; y < h; y++) {
          out[y * w + x] = acc / n;
          acc += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
        }
      }
      return out;
    };
    g = pass(pass(g));
    return new GrayImage(w, h, g);
  }
  /** Cut out a rectangle (pixels). */
  crop(x, y, w, h) {
    checkInt('crop', 'x', x, 0); checkInt('crop', 'y', y, 0); checkInt('crop', 'width', w, 1); checkInt('crop', 'height', h, 1);
    if (x + w > this.width || y + h > this.height) throw new RangeError(`crop: the rectangle leaves the image (${this.width}×${this.height})`);
    const gray = new Float32Array(w * h);
    for (let j = 0; j < h; j++) gray.set(this.gray.subarray((y + j) * this.width + x, (y + j) * this.width + x + w), j * w);
    return new GrayImage(w, h, gray);
  }
  /** Resample to a new size in pixels (height follows the aspect ratio when omitted). */
  resize(width, height = Math.max(1, Math.round((width * this.height) / this.width))) {
    checkInt('resize', 'width', width, 1); checkInt('resize', 'height', height, 1);
    const gray = new Float32Array(width * height);
    const sx = this.width / width, sy = this.height / height;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray[y * width + x] = this.sample((x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
    return new GrayImage(width, height, gray);
  }
  flip(axis = 'x') {
    const { width: w, height: h } = this;
    const gray = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = axis === 'x' ? this.gray[y * w + (w - 1 - x)] : this.gray[(h - 1 - y) * w + x];
    return new GrayImage(w, h, gray);
  }
}

// ---------- PNG decoding (8/16-bit, all colour types, non-interlaced) ----------

export function decodePNG(bytes) {
  const b = new Uint8Array(bytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (b.length < 8 || sig.some((v, i) => b[i] !== v)) throw new Error('not a PNG file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8, width = 0, height = 0, depth = 8, ctype = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= b.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12); depth = b[pos + 16]; ctype = b[pos + 17]; interlace = b[pos + 20]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (interlace) throw new Error('interlaced PNGs are not supported; save it without interlacing');
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`PNG bit depth ${depth} is not supported`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`PNG colour type ${ctype} is not supported`);
  const total = idat.reduce((n, d) => n + d.length, 0);
  const z = new Uint8Array(total); let o = 0; for (const d of idat) { z.set(d, o); o += d.length; }
  const raw = unzlibSync(z);
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per complete pixel (for filtering)
  const stride = Math.ceil((width * channels * depth) / 8);
  const px = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const get = (row, i) => { // sample i (in channel units) of a row, scaled to 0..255
    if (depth === 8) return px[row * stride + i];
    if (depth === 16) return px[row * stride + i * 2];
    const perByte = 8 / depth, byte = px[row * stride + (i / perByte | 0)], shift = 8 - depth * ((i % perByte) + 1);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const k = (y * width + x) * 4;
    if (ctype === 0) { const g = get(y, x); rgba[k] = rgba[k + 1] = rgba[k + 2] = g; rgba[k + 3] = trns && depth <= 8 && g === trns[1] ? 0 : 255; }
    else if (ctype === 2) { rgba[k] = get(y, x * 3); rgba[k + 1] = get(y, x * 3 + 1); rgba[k + 2] = get(y, x * 3 + 2); rgba[k + 3] = 255; }
    else if (ctype === 3) { const i = get(y, x); rgba[k] = palette[i * 3]; rgba[k + 1] = palette[i * 3 + 1]; rgba[k + 2] = palette[i * 3 + 2]; rgba[k + 3] = trns && i < trns.length ? trns[i] : 255; }
    else if (ctype === 4) { const g = get(y, x * 2); rgba[k] = rgba[k + 1] = rgba[k + 2] = g; rgba[k + 3] = get(y, x * 2 + 1); }
    else { rgba[k] = get(y, x * 4); rgba[k + 1] = get(y, x * 4 + 1); rgba[k + 2] = get(y, x * 4 + 2); rgba[k + 3] = get(y, x * 4 + 3); }
  }
  return { width, height, rgba };
}

// ---------- relief solids ----------

function checkImage(fn, img) {
  if (typeof img === 'function') return img;
  if (!(img instanceof GrayImage)) throw new TypeError(`${fn}: expected an imported image (import photo from './photo.png') or a function (x, z) => 0..1, got ${describe(img)}`);
  return img;
}

/**
 * A relief: a plate `width` × `depth` mm whose top surface rises with the brightness of the image,
 * from `base` mm (black) to `base + height` mm (white). The image is seen from above, as a drawing.
 * opts: { width = 50, depth (from the aspect ratio), height = 5, base = 1, invert = false, smooth = 0,
 *         gamma = 1, resolution = 200 (samples across the width), center = true }
 * The first argument may also be a function (x, z) => 0..1 of position in mm, sampled on the grid.
 */
export function heightmap(img, { width = 50, depth, height = 5, base = 1, invert = false, smooth = 0, gamma = 1, resolution = 200, center = true } = {}) {
  const src = checkImage('heightmap', img);
  checkPositive('heightmap', 'width', width); checkNonNegative('heightmap', 'height', height); checkPositive('heightmap', 'base', base);
  checkInt('heightmap', 'resolution', resolution, 2); checkInt('heightmap', 'smooth', smooth, 0); checkPositive('heightmap', 'gamma', gamma);
  const isFn = typeof src === 'function';
  if (depth === undefined) depth = isFn ? width : (width * src.height) / src.width;
  checkPositive('heightmap', 'depth', depth);
  const nx = Math.min(resolution, isFn ? resolution : Math.max(2, src.width)) ;
  const nz = Math.max(2, Math.round((nx * depth) / width));
  let image = isFn ? GrayImage.fromFunction(nx, nz, (i, j) => {
    const v = src((i / (nx - 1) - (center ? 0.5 : 0)) * width, (j / (nz - 1) - (center ? 0.5 : 0)) * depth);
    return checkNumber('heightmap', 'function value', v);
  }) : src.resize(nx, nz);
  if (smooth) image = image.blur(smooth);
  if (gamma !== 1) image = image.gamma(gamma);
  if (invert) image = image.invert();
  const x0 = center ? -width / 2 : 0, z0 = center ? -depth / 2 : 0;
  const pos = [];
  const top = (i, j) => j * nx + i, bottom = (i, j) => nx * nz + j * nx + i;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const v = Math.min(1, Math.max(0, image.gray[j * nx + i]));
    pos.push(x0 + (i / (nx - 1)) * width, base + v * height, z0 + (j / (nz - 1)) * depth);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) pos.push(x0 + (i / (nx - 1)) * width, 0, z0 + (j / (nz - 1)) * depth);
  const tris = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    tris.push(top(i, j), top(i, j + 1), top(i + 1, j + 1), top(i, j), top(i + 1, j + 1), top(i + 1, j));
    tris.push(bottom(i, j), bottom(i + 1, j + 1), bottom(i, j + 1), bottom(i, j), bottom(i + 1, j), bottom(i + 1, j + 1));
  }
  for (let i = 0; i < nx - 1; i++) {
    tris.push(top(i, 0), top(i + 1, 0), bottom(i + 1, 0), top(i, 0), bottom(i + 1, 0), bottom(i, 0));
    tris.push(top(i, nz - 1), bottom(i + 1, nz - 1), top(i + 1, nz - 1), top(i, nz - 1), bottom(i, nz - 1), bottom(i + 1, nz - 1));
  }
  for (let j = 0; j < nz - 1; j++) {
    tris.push(top(0, j), bottom(0, j + 1), top(0, j + 1), top(0, j), bottom(0, j), bottom(0, j + 1));
    tris.push(top(nx - 1, j), top(nx - 1, j + 1), bottom(nx - 1, j + 1), top(nx - 1, j), bottom(nx - 1, j + 1), bottom(nx - 1, j));
  }
  return new Shape(manifoldFromTriangles('heightmap', pos, tris));
}

/**
 * A lithophane: a plate whose thickness follows the image, so it shows the picture when lit from behind.
 * Dark pixels are thick (`maxThickness`), light pixels thin (`minThickness`).
 * opts: { width = 80, depth, minThickness = 0.8, maxThickness = 3, border = 0 (a rim at full thickness),
 *         smooth = 1, gamma = 1, resolution = 300, upright = false (stand it on its edge facing the front) }
 */
export function lithophane(img, { width = 80, depth, minThickness = 0.8, maxThickness = 3, border = 0, smooth = 1, gamma = 1, resolution = 300, upright = false } = {}) {
  const src = checkImage('lithophane', img);
  checkPositive('lithophane', 'width', width); checkPositive('lithophane', 'minThickness', minThickness); checkPositive('lithophane', 'maxThickness', maxThickness);
  checkNonNegative('lithophane', 'border', border);
  if (maxThickness <= minThickness) throw new RangeError('lithophane: maxThickness must be greater than minThickness');
  const d = depth ?? (typeof src === 'function' ? width : (width * src.height) / src.width);
  let s = heightmap(src, { width, depth: d, height: maxThickness - minThickness, base: minThickness, invert: true, smooth, gamma, resolution });
  if (border > 0) {
    const frame = new Shape(manifoldFromTriangles('lithophane', ...boxMesh(width + 2 * border, maxThickness, d + 2 * border)))
      .subtract(new Shape(manifoldFromTriangles('lithophane', ...boxMesh(width, maxThickness + 2, d))));
    s = s.add(frame);
  }
  return upright ? s.rotate(90, 0, 0).translate(0, d / 2 + border, 0) : s;
}

/** Positions and triangles of a box centred in X and Z with its base at y = 0. */
function boxMesh(w, h, dd) {
  const pos = [];
  for (const y of [0, h]) for (const [x, z] of [[-w / 2, -dd / 2], [w / 2, -dd / 2], [w / 2, dd / 2], [-w / 2, dd / 2]]) pos.push(x, y, z);
  const tris = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return [pos, tris];
}

export const imageApi = { GrayImage, heightmap, lithophane };
