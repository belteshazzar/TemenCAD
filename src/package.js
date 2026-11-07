/**
 * Shared-shape packages: a .temen project plus manifest.json (and a thumb.png rendered by the
 * catalogue's CI). Pure module shared by the app, the CLI and the catalogue repo's build scripts.
 *
 * A package's main.js is a demo of the shape; `manifest.module` names the script that exports the
 * reusable functions. Adding a package to a project copies its files into catalog/<name>/ and imports
 * the module from there, so projects stay self-contained and pinned.
 */
import { strToU8, strFromU8 } from 'fflate';
import { Project, ENTRY, isScript } from './project.js';

export const MANIFEST = 'manifest.json';
export const THUMB = 'thumb.png';
export const VENDOR_DIR = 'catalog';
export const API_VERSION = 1;

export const LICENSES = [
  ['CC0-1.0', 'CC0 — public domain, no attribution needed'],
  ['MIT', 'MIT — attribution in copies'],
  ['CC-BY-4.0', 'CC BY 4.0 — attribution required'],
];

export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Problems with a manifest, as readable strings; empty means valid. */
export function validateManifest(m, project) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['manifest must be an object'];
  if (!NAME_RE.test(m.name ?? '')) errors.push('name must be 2–48 lowercase letters, digits and hyphens');
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) errors.push('version must be semver like 1.0.0');
  if (!m.title || String(m.title).trim().length < 3 || String(m.title).length > 80) errors.push('title must be 3–80 characters');
  if (!m.description || String(m.description).trim().length < 10 || String(m.description).length > 500) errors.push('description must be 10–500 characters');
  if (!m.author || String(m.author).trim().length < 1 || String(m.author).length > 80) errors.push('author is required');
  if (!LICENSES.some(([id]) => id === m.license)) errors.push(`license must be one of ${LICENSES.map(([id]) => id).join(', ')}`);
  if (!Array.isArray(m.tags) || m.tags.length > 10 || m.tags.some((t) => !/^[a-z0-9-]{1,24}$/.test(t))) errors.push('tags must be up to 10 short lowercase words');
  if (!m.module || !isScript(m.module)) errors.push('module must name the .js file that exports the shape functions');
  else if (project && !project.has(m.module)) errors.push(`module "${m.module}" is not in the package`);
  else if (m.module === ENTRY) errors.push(`module cannot be ${ENTRY} (that file is the demo and uses a top-level return)`);
  if (!Array.isArray(m.exports) || !m.exports.length || m.exports.some((e) => !/^[A-Za-z_$][\w$]*$/.test(e))) errors.push('exports must list the exported function names');
  if (m.apiVersion !== API_VERSION) errors.push(`apiVersion must be ${API_VERSION}`);
  return errors;
}

/** Names of `export` bindings in a script (functions, consts, classes), for the exports field. */
export function findExports(code) {
  const out = new Set();
  for (const m of code.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of code.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) out.add(n); }
  return [...out];
}

/** Package bytes: the project's files plus manifest.json (and thumb.png when given). */
export function buildPackage(project, manifest, thumbPng = null) {
  const p = new Project();
  for (const name of project.names()) p.set(name, project.get(name));
  p.files.set(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  if (thumbPng) p.files.set(THUMB, thumbPng);
  return p.toZip();
}

/** Parse a package: { manifest, project (without manifest/thumb), thumb } — throws on an invalid manifest. */
export function readPackage(bytes) {
  const all = Project.fromZip(bytes);
  if (!all.has(MANIFEST)) throw new Error(`package has no ${MANIFEST}`);
  const manifest = JSON.parse(typeof all.get(MANIFEST) === 'string' ? all.get(MANIFEST) : strFromU8(new Uint8Array(all.get(MANIFEST))));
  const thumb = all.has(THUMB) ? all.get(THUMB) : null;
  const project = new Project();
  for (const name of all.names()) if (name !== MANIFEST && name !== THUMB) project.set(name, all.get(name));
  const errors = validateManifest(manifest, project);
  if (errors.length) throw new Error(`invalid package: ${errors.join('; ')}`);
  return { manifest, project, thumb };
}

/** The header written into each vendored script so its origin and license are visible. */
const vendorHeader = (m, file) => `// ${file} — from the TemenCAD catalogue: ${m.name}@${m.version} (${m.title}) by ${m.author}, ${m.license}\n`;

/**
 * Copy a package into `project` under catalog/<name>/ (the demo main.js becomes demo.js) and return
 * { dir, importLine, added }. Existing files under that folder are replaced (an update).
 */
export function vendorPackage(project, pkgProject, manifest) {
  const dir = `${VENDOR_DIR}/${manifest.name}`;
  for (const name of project.names()) if (name.startsWith(dir + '/')) project.remove(name);
  const added = [];
  for (const name of pkgProject.names()) {
    const target = `${dir}/${name === ENTRY ? 'demo.js' : name}`;
    let content = pkgProject.get(name);
    if (isScript(name) && typeof content === 'string') content = vendorHeader(manifest, name) + content;
    project.set(target, content);
    added.push(target);
  }
  const importLine = `import { ${manifest.exports.join(', ')} } from './${dir}/${manifest.module}';`;
  return { dir, importLine, added };
}

/** Insert an import line after any existing imports at the top of a script (no-op if already present). */
export function addImportLine(code, importLine) {
  if (code.includes(importLine)) return code;
  const lines = code.split('\n');
  let i = 0;
  while (i < lines.length && (/^\s*import\b/.test(lines[i]) || (/^\s*$/.test(lines[i]) && i > 0 && /^\s*import\b/.test(lines[i - 1])))) i++;
  lines.splice(i, 0, importLine);
  return lines.join('\n');
}

export const manifestBytes = (m) => strToU8(JSON.stringify(m, null, 2) + '\n');
