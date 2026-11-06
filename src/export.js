import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { zipSync, strToU8 } from 'fflate';

/**
 * Our world is Y-up; slicers expect Z-up. This rotation (+90° about X) maps
 * y -> z and z -> -y, so the build plate (y = 0) becomes z = 0.
 */
const Y_UP_TO_Z_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2);

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

/** Visible, non-ghost solid meshes in `group` (optionally restricted to `only` part indices). */
function exportableMeshes(group, only) {
  const meshes = [];
  group.traverse((o) => { if (o.isMesh && o.visible && !o.userData.ghost && (!only || only.includes(o.userData.index))) meshes.push(o); });
  if (meshes.length === 0) throw new Error(only ? 'That part is hidden or a ghost; nothing to export' : 'Nothing to export: no visible, non-ghost parts');
  return meshes;
}

/**
 * Export as a single binary STL (Z-up). Returns the number of triangles written.
 */
export function exportSTL(group, filename = 'model.stl', { only } = {}) {
  const meshes = exportableMeshes(group, only);
  const exportGroup = new THREE.Group();
  for (const m of meshes) {
    const clone = new THREE.Mesh(m.geometry, m.material);
    m.updateWorldMatrix(true, false);
    clone.applyMatrix4(m.matrixWorld);
    exportGroup.add(clone);
  }
  exportGroup.applyMatrix4(Y_UP_TO_Z_UP);
  exportGroup.updateMatrixWorld(true);
  const data = new STLExporter().parse(exportGroup, { binary: true });
  download(data, filename, 'model/stl');
  return meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
}

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const fmt = (n) => (Math.abs(n) < 1e-9 ? '0' : +n.toFixed(5)).toString();

/**
 * Build a 3MF archive (Uint8Array) from meshes: each becomes a named object with its
 * own color via the core-spec <basematerials>. Coordinates are converted to Z-up.
 */
export function build3MF(meshes) {
  const objects = [], items = [], materials = [];
  const v = new THREE.Vector3();
  meshes.forEach((m, i) => {
    const id = i + 2; // 1 is the materials group
    const name = m.userData?.name ?? `Part ${i + 1}`;
    const color = '#' + new THREE.Color(m.material?.color ?? 0x8fb3ff).getHexString().toUpperCase();
    materials.push(`<base name="${xmlEscape(name)}" displaycolor="${color}" />`);
    m.updateWorldMatrix?.(true, false);
    const xf = new THREE.Matrix4().multiplyMatrices(Y_UP_TO_Z_UP, m.matrixWorld ?? new THREE.Matrix4());
    const pos = m.geometry.attributes.position;
    const verts = [];
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(xf);
      verts.push(`<vertex x="${fmt(v.x)}" y="${fmt(v.y)}" z="${fmt(v.z)}" />`);
    }
    const idx = m.geometry.index;
    const tris = [];
    if (idx) for (let k = 0; k < idx.count; k += 3) tris.push(`<triangle v1="${idx.getX(k)}" v2="${idx.getX(k + 1)}" v3="${idx.getX(k + 2)}" />`);
    else for (let k = 0; k < pos.count; k += 3) tris.push(`<triangle v1="${k}" v2="${k + 1}" v3="${k + 2}" />`);
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
<metadata name="Application">TextCAD</metadata>
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

/** Export visible, non-ghost parts as one 3MF with named, colored objects. Returns the part count. */
export function export3MF(group, filename = 'model.3mf', { only } = {}) {
  const meshes = exportableMeshes(group, only);
  download(build3MF(meshes), filename, 'model/3mf');
  return meshes.length;
}
