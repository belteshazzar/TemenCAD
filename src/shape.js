import { M, track } from './engine.js';

export const DEFAULT_COLOR = '#8fb3ff';
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

/** Overridable hooks; the worker routes warnings to the UI. */
export const hooks = { warn: (msg) => console.warn(msg) };

// ---- Argument checking: fail at the call site with a readable message ----
export function describe(v) {
  if (v instanceof Shape) return 'a Shape';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `an array [${v.slice(0, 4).map(describe).join(', ')}${v.length > 4 ? ', …' : ''}]`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
  if (typeof v === 'object') return v.constructor?.name ? `a ${v.constructor.name}` : 'an object';
  return `${typeof v} ${String(v)}`;
}
export function checkNumber(fn, name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${fn}: ${name} must be a finite number, got ${describe(v)}`);
  return v;
}
export function checkPositive(fn, name, v) {
  checkNumber(fn, name, v);
  if (v <= 0) throw new RangeError(`${fn}: ${name} must be greater than 0, got ${v}`);
  return v;
}
export function checkNonNegative(fn, name, v) {
  checkNumber(fn, name, v);
  if (v < 0) throw new RangeError(`${fn}: ${name} must not be negative, got ${v}`);
  return v;
}
export function checkInt(fn, name, v, min = 1) {
  checkNumber(fn, name, v);
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${fn}: ${name} must be an integer ≥ ${min}, got ${v}`);
  return v;
}
export function checkShape(fn, name, v) {
  if (!(v instanceof Shape)) throw new TypeError(`${fn}: ${name} must be a Shape, got ${describe(v)}`);
  return v;
}
export function checkVec(fn, name, v, n = 3) {
  if (!Array.isArray(v) || v.length !== n) throw new TypeError(`${fn}: ${name} must be an array of ${n} numbers, got ${describe(v)}`);
  v.forEach((x, i) => checkNumber(fn, `${name}[${i}]`, x));
  return v;
}

// CSS color keywords, kept inline because this runs in the worker, which does not load Three.js (THREE.Color.NAMES).
const COLOR_NAMES = new Set(["aliceblue","antiquewhite","aqua","aquamarine","azure","beige","bisque","black","blanchedalmond","blue","blueviolet","brown","burlywood","cadetblue","chartreuse","chocolate","coral","cornflowerblue","cornsilk","crimson","cyan","darkblue","darkcyan","darkgoldenrod","darkgray","darkgreen","darkgrey","darkkhaki","darkmagenta","darkolivegreen","darkorange","darkorchid","darkred","darksalmon","darkseagreen","darkslateblue","darkslategray","darkslategrey","darkturquoise","darkviolet","deeppink","deepskyblue","dimgray","dimgrey","dodgerblue","firebrick","floralwhite","forestgreen","fuchsia","gainsboro","ghostwhite","gold","goldenrod","gray","green","greenyellow","grey","honeydew","hotpink","indianred","indigo","ivory","khaki","lavender","lavenderblush","lawngreen","lemonchiffon","lightblue","lightcoral","lightcyan","lightgoldenrodyellow","lightgray","lightgreen","lightgrey","lightpink","lightsalmon","lightseagreen","lightskyblue","lightslategray","lightslategrey","lightsteelblue","lightyellow","lime","limegreen","linen","magenta","maroon","mediumaquamarine","mediumblue","mediumorchid","mediumpurple","mediumseagreen","mediumslateblue","mediumspringgreen","mediumturquoise","mediumvioletred","midnightblue","mintcream","mistyrose","moccasin","navajowhite","navy","oldlace","olive","olivedrab","orange","orangered","orchid","palegoldenrod","palegreen","paleturquoise","palevioletred","papayawhip","peachpuff","peru","pink","plum","powderblue","purple","rebeccapurple","red","rosybrown","royalblue","saddlebrown","salmon","sandybrown","seagreen","seashell","sienna","silver","skyblue","slateblue","slategray","slategrey","snow","springgreen","steelblue","tan","teal","thistle","tomato","turquoise","violet","wheat","white","whitesmoke","yellow","yellowgreen"]);
/** True if Three.js will accept this color without complaint. */
export function isValidColor(c) {
  if (typeof c === 'number') return Number.isFinite(c) && c >= 0 && c <= 0xffffff;
  if (typeof c !== 'string') return false;
  const v = c.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return true;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.%]+\s*[, ]\s*[\d.%]+\s*[, ]\s*[\d.%]+\s*([,/]\s*[\d.%]+\s*)?\)$/.test(v)) return true;
  return COLOR_NAMES.has(v);
}

/**
 * Scale factors that take a bounding-box `size` to `target`. A target of 0 (or undefined) leaves
 * that axis alone, or, with `auto`, scales it by the same factor as the specified axes.
 */
export function resizeFactors(fn, size, target, auto) {
  const n = size.length;
  if (!Array.isArray(target) || target.length !== n) throw new TypeError(`${fn}: size must be an array of ${n} numbers (0 keeps an axis unchanged), got ${describe(target)}`);
  target.forEach((t, i) => checkNonNegative(fn, `size[${i}]`, t));
  const specified = target.map((t, i) => (t > 0 ? t / size[i] : null));
  if (specified.every((f) => f === null)) throw new RangeError(`${fn}: at least one size must be greater than 0`);
  if (specified.some((f) => f !== null && !Number.isFinite(f))) throw new RangeError(`${fn}: the shape has zero extent on an axis being resized`);
  const autoFactor = specified.find((f) => f !== null);
  return specified.map((f) => f ?? (auto ? autoFactor : 1));
}

/** Rotation that turns Manifold's native Z-up constructions into our Y-up world. */
export const Z_TO_Y = [-90, 0, 0];

/** A solid: an immutable wrapper around a Manifold object (world space, Y up). */
export class Shape {
  constructor(manifold, color = DEFAULT_COLOR, meta = {}) {
    this.m = track(manifold);
    this.colorValue = color;
    this.meta = meta; // { name, ghost, hidden }
  }

  _wrap(m) { return new Shape(m, this.colorValue, this.meta); }
  _meta(patch) { return new Shape(this.m, this.colorValue, { ...this.meta, ...patch }); }

  /** Give the part a name (shown in the Parts panel and used for export file names). */
  name(n) {
    if (typeof n !== 'string' || !n.trim()) throw new TypeError(`name: expected a non-empty string, got ${describe(n)}`);
    return this._meta({ name: n.trim() });
  }
  /** Render semi-transparent as a reference; ghosts are not exported. */
  ghost(on = true) { return this._meta({ ghost: !!on }); }
  /** Keep the part in the list but don't render it (can be switched on in the Parts panel). */
  hide(on = true) { return this._meta({ hidden: !!on }); }

  translate(x = 0, y = 0, z = 0) {
    if (Array.isArray(x)) [x, y = 0, z = 0] = x;
    checkNumber('translate', 'x', x); checkNumber('translate', 'y', y); checkNumber('translate', 'z', z);
    return this._wrap(this.m.translate([x, y, z]));
  }

  /** Rotation in degrees around X, Y, Z (applied in that order). */
  rotate(x = 0, y = 0, z = 0) {
    if (Array.isArray(x)) [x, y = 0, z = 0] = x;
    checkNumber('rotate', 'x', x); checkNumber('rotate', 'y', y); checkNumber('rotate', 'z', z);
    return this._wrap(this.m.rotate([x, y, z]));
  }

  scale(x = 1, y, z) {
    if (Array.isArray(x)) [x, y, z] = x;
    if (y === undefined) { y = x; z = x; }
    checkNumber('scale', 'x', x); checkNumber('scale', 'y', y); checkNumber('scale', 'z', z);
    if (x === 0 || y === 0 || z === 0) throw new RangeError('scale: factors must not be 0');
    return this._wrap(this.m.scale([x, y, z]));
  }

  mirror(axis = 'x') {
    const n = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
    if (!n) throw new Error(`mirror: axis must be 'x', 'y' or 'z'`);
    return this._wrap(this.m.mirror(n));
  }

  /**
   * Scale so the bounding box becomes `size` ([w, h, d] or w, h, d). A 0 leaves that axis unchanged,
   * or scales it proportionally when `auto` is true. resize([50, 0, 0], { auto: true }) keeps the aspect ratio.
   */
  resize(x, y = 0, z = 0, opts = {}) {
    if (Array.isArray(x)) { opts = (y && typeof y === 'object') ? y : {}; [x, y = 0, z = 0] = x; }
    const f = resizeFactors('resize', this.bounds().size, [x, y, z], !!opts.auto);
    return this.scale(...f);
  }

  color(c) {
    if (c === undefined) throw new TypeError('color: missing color argument');
    if (!isValidColor(c)) {
      hooks.warn(`Unknown color ${JSON.stringify(c)}; keeping ${this.colorValue}. Use '#rgb', '#rrggbb', a CSS name, rgb() or hsl().`);
      return this;
    }
    return new Shape(this.m, typeof c === 'string' ? c.trim() : c, this.meta);
  }

  /** Axis-aligned bounding box as { min, max, size, center } (arrays of [x,y,z]). */
  bounds() {
    const { min, max } = this.m.boundingBox();
    const size = [0, 1, 2].map((i) => max[i] - min[i]);
    const center = [0, 1, 2].map((i) => (max[i] + min[i]) / 2);
    return { min: [...min], max: [...max], size, center };
  }

  /**
   * Align the bounding box. `spec` maps axes to 'min' | 'center' | 'max',
   * e.g. align({ y: 'min' }) puts the bottom on y = 0. Unlisted axes are untouched.
   */
  align(spec = {}, to = [0, 0, 0]) {
    if (typeof spec !== 'object' || spec === null) throw new TypeError(`align: first argument must be like { x: 'min' | 'center' | 'max', y, z }, got ${describe(spec)}`);
    for (const [k, v] of Object.entries(spec)) {
      if (!['x', 'y', 'z'].includes(k)) throw new TypeError(`align: unknown axis "${k}" (use x, y, z)`);
      if (!['min', 'center', 'max'].includes(v)) throw new TypeError(`align: ${k} must be 'min', 'center' or 'max', got ${describe(v)}`);
    }
    checkVec('align', 'to', to);
    const b = this.bounds();
    const d = [0, 0, 0];
    ['x', 'y', 'z'].forEach((axis, i) => {
      const mode = spec[axis];
      if (!mode) return;
      const from = mode === 'min' ? b.min[i] : mode === 'max' ? b.max[i] : b.center[i];
      d[i] = to[i] - from;
    });
    return this.translate(...d);
  }

  center() { return this.align({ x: 'center', y: 'center', z: 'center' }); }
  centerXZ() { return this.align({ x: 'center', z: 'center' }); }
  /** Put the bottom on the build plate (y = 0 by default). */
  onPlate(y = 0) { return this.align({ y: 'min' }, [0, y, 0]); }

  volume() { return this.m.volume(); }
  surfaceArea() { return this.m.surfaceArea(); }
  isEmpty() { return this.m.isEmpty(); }

  /** Indexed triangle mesh: { positions: Float32Array, indices: Uint32Array }. */
  toMesh() {
    const mesh = this.m.getMesh();
    let positions = mesh.vertProperties;
    if (mesh.numProp !== 3) {
      const n = positions.length / mesh.numProp;
      const p = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) p[i * 3 + k] = positions[i * mesh.numProp + k];
      positions = p;
    }
    return { positions, indices: mesh.triVerts };
  }
}
