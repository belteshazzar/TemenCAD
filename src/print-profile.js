import { hooks, describe, checkNumber, checkPositive, checkNonNegative } from './shape.js';

/*
 * A print profile declared once at the top of a script, and helpers that derive dimensions from it:
 *   printer({ nozzle, layer, holeCompensation, material })   declare it (returns the profile)
 *   wall(t)       a wall thickness rounded up to whole extrusion lines (multiples of the nozzle width)
 *   layers(h)     a height rounded up to whole layers
 *   fit(d, kind)  the hole diameter to model so a d mm part fits: 'press' | 'snug' | 'slide' | 'clearance' | 'loose'
 *   peg(d, kind)  the peg diameter to model so it fits a d mm hole the same way
 * When a profile is declared, hole() oversizes by holeCompensation on its own.
 */

export const FITS = { press: -0.1, snug: 0, slide: 0.15, clearance: 0.3, loose: 0.6 }; // added to the hole diameter, after compensation
const DEFAULT = Object.freeze({ nozzle: 0.4, layer: 0.2, holeCompensation: 0.2, material: null, declared: false });

/** The profile in force: the one the script declared, or the defaults. */
export const printProfile = () => hooks.printProfile ?? DEFAULT;

export function printer(opts = {}) {
  if (!opts || typeof opts !== 'object') throw new TypeError(`printer: expected { nozzle, layer, holeCompensation, material }, got ${describe(opts)}`);
  const p = { ...DEFAULT, ...opts, declared: true };
  checkPositive('printer', 'nozzle', p.nozzle); checkPositive('printer', 'layer', p.layer); checkNonNegative('printer', 'holeCompensation', p.holeCompensation);
  if (p.material !== null && typeof p.material !== 'string') throw new TypeError(`printer: material must be a string, got ${describe(p.material)}`);
  for (const k of Object.keys(opts)) if (!(k in DEFAULT)) throw new TypeError(`printer: unknown option "${k}"; use nozzle, layer, holeCompensation, material`);
  hooks.printProfile = Object.freeze(p);
  return hooks.printProfile;
}

const roundUp = (v, step) => { const n = Math.ceil(v / step - 1e-9); return +(n * step).toFixed(6); };

/** Wall thickness rounded up to whole extrusion lines. wall(1) with a 0.4 nozzle is 1.2 (three lines). opts: { lines } for a count instead. */
export function wall(t, { lines } = {}) {
  const { nozzle } = printProfile();
  if (lines !== undefined) { checkPositive('wall', 'lines', lines); return +(Math.round(lines) * nozzle).toFixed(6); }
  checkPositive('wall', 't', t);
  return roundUp(t, nozzle);
}

/** A height rounded up to whole layers. layers(3.1) with 0.2 mm layers is 3.2. opts: { count } for a layer count instead. */
export function layers(h, { count } = {}) {
  const { layer } = printProfile();
  if (count !== undefined) { checkPositive('layers', 'count', count); return +(Math.round(count) * layer).toFixed(6); }
  checkPositive('layers', 'h', h);
  return roundUp(h, layer);
}

function allowance(fn, kind) {
  if (typeof kind === 'number') return checkNumber(fn, 'allowance', kind);
  if (!(kind in FITS)) throw new TypeError(`${fn}: kind must be ${Object.keys(FITS).map((k) => `'${k}'`).join(' | ')} or a number in mm, got ${describe(kind)}`);
  return FITS[kind];
}

/** The hole diameter to model so a part of diameter d fits it: compensation for the printer plus the fit's allowance. */
export function fit(d, kind = 'clearance') {
  checkPositive('fit', 'd', d);
  return +(d + printProfile().holeCompensation + allowance('fit', kind)).toFixed(6);
}

/** The peg diameter to model so it fits an existing hole of diameter d the same way (printed pegs come out slightly large). */
export function peg(d, kind = 'clearance') {
  checkPositive('peg', 'd', d);
  return +(d - printProfile().holeCompensation / 2 - allowance('peg', kind)).toFixed(6);
}

export const printProfileApi = { printer, printProfile, wall, layers, fit, peg, FITS };
