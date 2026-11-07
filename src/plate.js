/** Printer build-plate presets: [id, label, [width, depth, height] in mm]. */
export const PLATES = [
  ['none', 'None', null],
  ['bambu-a1mini', 'Bambu A1 mini · 180×180×180', [180, 180, 180]],
  ['bambu-a1', 'Bambu A1 / P1 / X1 · 256×256×256', [256, 256, 256]],
  ['prusa-mini', 'Prusa MINI+ · 180×180×180', [180, 180, 180]],
  ['prusa-mk4', 'Prusa MK4S · 250×210×220', [250, 210, 220]],
  ['prusa-core', 'Prusa CORE One · 250×220×270', [250, 220, 270]],
  ['ender3', 'Creality Ender-3 · 220×220×250', [220, 220, 250]],
  ['k1', 'Creality K1 · 220×220×250', [220, 220, 250]],
  ['neptune4', 'Elegoo Neptune 4 · 225×225×265', [225, 225, 265]],
  ['voron350', 'Voron 2.4 350 · 350×350×340', [350, 350, 340]],
  ['custom', 'Custom…', null],
];

/**
 * Compare a bounding box { min: {x,y,z}, max: {x,y,z} } (Y up, plate centred on the origin at y = 0)
 * with a plate { w, d, h }. Returns a list of human-readable problems; empty means it fits.
 */
export function fitProblems(b, plate, eps = 1e-3) {
  const over = [];
  const w = b.max.x - b.min.x, d = b.max.z - b.min.z, h = b.max.y;
  if (b.min.x < -plate.w / 2 - eps || b.max.x > plate.w / 2 + eps) over.push(w > plate.w + eps ? `${(w - plate.w).toFixed(1)} mm too wide (X)` : 'off the plate in X');
  if (b.min.z < -plate.d / 2 - eps || b.max.z > plate.d / 2 + eps) over.push(d > plate.d + eps ? `${(d - plate.d).toFixed(1)} mm too deep (Z)` : 'off the plate in Z');
  if (h > plate.h + eps) over.push(`${(h - plate.h).toFixed(1)} mm too tall (Y)`);
  if (b.min.y < -eps) over.push(`${(-b.min.y).toFixed(1)} mm below the plate`);
  return over;
}
