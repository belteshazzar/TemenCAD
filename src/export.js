/**
 * STL and 3MF writers. The builders are pure (they take mesh buffers and return bytes) so the
 * command-line tool and the browser share them; the export* functions wrap them for the viewer.
 *
 * A part is { positions: Float32Array, indices?: Uint32Array, name?, color? } in our Y-up frame.
 * Slicers expect Z-up, so output coordinates are (x, -z, y): the build plate (y = 0) becomes z = 0.
 */
import { Color } from 'three';
import { zipSync, strToU8 } from 'fflate';

const DEFAULT_COLOR = '#8fb3ff';

/** Any CSS color (name, #hex, rgb(), hsl()) or number as '#RRGGBB'. */
export function colorHex(c) {
  const col = new Color();
  try { if (typeof c === 'number') col.setHex(c); else col.setStyle(String(c ?? DEFAULT_COLOR)); } catch { col.setStyle(DEFAULT_COLOR); }
  return '#' + col.getHexString().toUpperCase();
}

const triangleCount = (p) => (p.indices ? p.indices.length : p.positions.length / 3) / 3;
const vertexIndex = (p, k) => (p.indices ? p.indices[k] : k);

/** Binary STL of all parts as one solid. Returns { data: ArrayBuffer, triangles }. */
export function buildSTL(parts) {
  const triangles = parts.reduce((n, p) => n + triangleCount(p), 0);
  const data = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(data);
  new Uint8Array(data).set(new TextEncoder().encode('TemenCAD binary STL'.padEnd(80, ' ')).subarray(0, 80));
  view.setUint32(80, triangles, true);
  let o = 84;
  for (const p of parts) {
    const P = p.positions, n = triangleCount(p);
    for (let t = 0; t < n; t++) {
      const a = vertexIndex(p, t * 3) * 3, b = vertexIndex(p, t * 3 + 1) * 3, c = vertexIndex(p, t * 3 + 2) * 3;
      // Z-up: (x, y, z) -> (x, -z, y)
      const ax = P[a], ay = -P[a + 2], az = P[a + 1];
      const bx = P[b], by = -P[b + 2], bz = P[b + 1];
      const cx = P[c], cy = -P[c + 2], cz = P[c + 1];
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const f of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) { view.setFloat32(o, f, true); o += 4; }
      view.setUint16(o, 0, true); o += 2;
    }
  }
  return { data, triangles };
}

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const fmt = (n) => (Math.abs(n) < 1e-9 ? '0' : +n.toFixed(5)).toString();

/**
 * 3MF archive (Uint8Array): each part becomes a named object with its own color via the
 * core-spec <basematerials>, which is what Prusa, Bambu, Orca and Cura read.
 */
export function build3MF(parts) {
  const objects = [], items = [], materials = [];
  parts.forEach((p, i) => {
    const id = i + 2; // 1 is the materials group
    const name = p.name ?? `Part ${i + 1}`;
    materials.push(`<base name="${xmlEscape(name)}" displaycolor="${colorHex(p.color)}" />`);
    const P = p.positions, verts = [], tris = [];
    for (let k = 0; k < P.length; k += 3) verts.push(`<vertex x="${fmt(P[k])}" y="${fmt(-P[k + 2])}" z="${fmt(P[k + 1])}" />`);
    const n = triangleCount(p);
    for (let t = 0; t < n; t++) tris.push(`<triangle v1="${vertexIndex(p, t * 3)}" v2="${vertexIndex(p, t * 3 + 1)}" v3="${vertexIndex(p, t * 3 + 2)}" />`);
    objects.push(`<object id="${id}" name="${xmlEscape(name)}" type="model" pid="1" pindex="${i}">
<mesh><vertices>
${verts.join('\n')}
</vertices><triangles>
${tris.join('\n')}
</triangles></mesh></object>`);
    items.push(`<item objectid="${id}" />`);
  });

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">TemenCAD</metadata>
<resources>
<basematerials id="1">
${materials.join('\n')}
</basematerials>
${objects.join('\n')}
</resources>
<build>
${items.join('\n')}
</build>
</model>
`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  }, { level: 6 });
}

// ---- Browser side: collect parts from the viewer's Three.js group and trigger a download ----

function download(data, filename, type) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Visible, non-ghost meshes in `group` (optionally restricted to `only` part indices) as parts in world space. */
function partsFromGroup(group, only) {
  const parts = [];
  group.traverse((o) => {
    if (!o.isMesh || !o.visible || o.userData.ghost || (only && !only.includes(o.userData.index))) return;
    o.updateWorldMatrix(true, false);
    const src = o.geometry.attributes.position;
    const positions = new Float32Array(src.count * 3);
    const v = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < src.count; k++) {
      v.x = src.getX(k); v.y = src.getY(k); v.z = src.getZ(k);
      const e = o.matrixWorld.elements;
      positions[k * 3] = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
      positions[k * 3 + 1] = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
      positions[k * 3 + 2] = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
    }
    parts.push({ positions, indices: o.geometry.index ? o.geometry.index.array : null, name: o.userData.name, color: o.material.color.getHex() });
  });
  if (parts.length === 0) throw new Error(only ? 'That part is hidden or a ghost; nothing to export' : 'Nothing to export: no visible, non-ghost parts');
  return parts;
}

/** Download the group as one binary STL (Z-up). Returns the number of triangles written. */
export function exportSTL(group, filename = 'model.stl', { only } = {}) {
  const { data, triangles } = buildSTL(partsFromGroup(group, only));
  download(data, filename, 'model/stl');
  return triangles;
}

/** Download visible, non-ghost parts as one 3MF with named, colored objects. Returns the part count. */
export function export3MF(group, filename = 'model.3mf', { only } = {}) {
  const parts = partsFromGroup(group, only);
  download(build3MF(parts), filename, 'model/3mf');
  return parts.length;
}
