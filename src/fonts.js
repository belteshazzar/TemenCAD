/**
 * Font registry and glyph outline extraction (opentype.js). Fonts are parsed
 * once (at worker start) so text() can stay synchronous inside scripts.
 */
import opentype from 'opentype.js';

const fonts = new Map();
export const DEFAULT_FONT = 'Inter';

/** Bundled fonts (all SIL Open Font License, Latin subsets in src/assets). `name` is what scripts pass as `font`. */
export const FONTS = [
  { name: 'Inter', file: 'Inter-Regular-subset.ttf', style: 'sans-serif' },
  { name: 'Inter Bold', file: 'Inter-Bold-subset.ttf', style: 'sans-serif, heavy' },
  { name: 'Nunito Bold', file: 'Nunito-Bold-subset.ttf', style: 'rounded, good for raised lettering' },
  { name: 'Source Serif 4', file: 'SourceSerif4-Regular-subset.ttf', style: 'serif' },
  { name: 'JetBrains Mono', file: 'JetBrainsMono-Regular-subset.ttf', style: 'monospace' },
];

/** Names match ignoring case, spaces and hyphens: 'inter-bold' and 'InterBold' both find 'Inter Bold'. */
const key = (name) => String(name).toLowerCase().replace(/[\s_-]+/g, '');

export function registerFont(name, arrayBuffer) {
  fonts.set(key(name), { name, font: opentype.parse(arrayBuffer) });
}
export function fontNames() { return [...fonts.values()].map((f) => f.name); }

export function getFont(name = DEFAULT_FONT) {
  const f = fonts.get(key(name));
  if (!f) throw new Error(`Unknown font "${name}". Available: ${fontNames().join(', ') || '(none loaded yet)'}`);
  return f.font;
}

/** Flatten a bezier into line segments. */
function bezier(points, out, steps) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    let pts = points;
    while (pts.length > 1) {
      const next = [];
      for (let k = 0; k < pts.length - 1; k++) next.push([pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t]);
      pts = next;
    }
    out.push(pts[0]);
  }
}

/**
 * Outline rings for a string, in sketch units (y up, baseline at y = 0).
 * opts: { size=10, font, align='left'|'center'|'right', letterSpacing=0, kerning=true, curveSegments=8 }
 * Returns { rings: [[x,y],...][], width }.
 */
export function textOutlines(str, { size = 10, font = DEFAULT_FONT, align = 'left', letterSpacing = 0, kerning = true, curveSegments = 8 } = {}) {
  const f = getFont(font);
  const options = { kerning, letterSpacing };
  const width = f.getAdvanceWidth(str, size, options);
  const dx = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
  const path = f.getPath(str, dx, 0, size, options);
  const rings = [];
  let ring = null, cur = null;
  const push = (p) => { if (ring) ring.push([p[0], -p[1]]); }; // opentype's y points down
  for (const c of path.commands) {
    switch (c.type) {
      case 'M': ring = []; rings.push(ring); cur = [c.x, c.y]; push(cur); break;
      case 'L': cur = [c.x, c.y]; push(cur); break;
      case 'Q': { const seg = []; bezier([cur, [c.x1, c.y1], [c.x, c.y]], seg, curveSegments); seg.forEach(push); cur = [c.x, c.y]; break; }
      case 'C': { const seg = []; bezier([cur, [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]], seg, curveSegments); seg.forEach(push); cur = [c.x, c.y]; break; }
      case 'Z': ring = null; break;
    }
  }
  // Drop closing duplicates and degenerate rings
  const clean = rings.map((r) => {
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
    return r;
  }).filter((r) => r.length >= 3);
  return { rings: clean, width };
}
