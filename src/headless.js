/**
 * Build projects in Node without a browser: used by the command-line tool and by the catalogue's CI.
 *   const { meshes, tris, ms } = await buildProject(project, { onLog, onWarn });
 * Loads the geometry engine and the bundled fonts once per process.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from './engine.js';
import { registerFont, FONTS } from './fonts.js';
import { runScript } from './runner.js';
import { existsSync as coreBuilt } from 'node:fs';
import { Project, ENTRY, PROJECT_EXT, ACCEPTED_EXT, extOf, findImports, resolveImport, isScript, isTextFile } from './project.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let ready = null;
/** Initialise the engine and fonts (idempotent). */
export function initEngine() {
  if (!ready) {
    ready = init().then(() => {
      for (const { name, file } of FONTS) {
        const b = readFileSync(join(ROOT, 'src/assets', file)); // small files share a pooled buffer, so slice to this file's bytes
        registerFont(name, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      }
    });
  }
  return ready;
}

/** Scripts become data: module URLs, which Node can import without touching the filesystem. */
export const nodeEnv = {
  makeUrl: (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
  async decodeImage(bytes, name) {
    if (!/\.jpe?g$/i.test(name)) throw new Error('only PNG and JPEG images are supported on the command line');
    const { decode } = await import('jpeg-js');
    const { width, height, data } = decode(new Uint8Array(bytes), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
    return { width, height, rgba: data };
  },
};

/**
 * Which runtime builds: the lamassu core (default) or the JavaScript modelling layer
 * (TEMENCAD_RUNTIME=js, or automatically when core/wasm/dist has not been built with `npm run core:wasm`).
 */
let coreRunner = null, runtimeNotice = false;
export function selectedRuntime() {
  if (process.env.TEMENCAD_RUNTIME === 'js') return 'js';
  if (!coreBuilt(join(ROOT, 'core/wasm/dist/temencore.mjs'))) {
    if (!runtimeNotice) { runtimeNotice = true; console.error('note: core/wasm/dist is not built (npm run core:wasm); using the JavaScript runtime'); }
    return 'js';
  }
  return 'core';
}

/** Build a Project. Rejects with a ScriptError ({ message, file, line, trace }) on failure. */
export async function buildProject(project, { onLog = () => {}, onWarn = () => {} } = {}) {
  const post = (m) => { if (m.type === 'log') onLog(m.text); else if (m.type === 'warn') onWarn(m); };
  if (selectedRuntime() === 'core') {
    coreRunner ??= await import('./core-runner.js');
    return coreRunner.runScriptCore(project.toFiles(), post);
  }
  await initEngine();
  return runScript(project.toFiles(), post, nodeEnv);
}

/** A project from a script on disk: the script becomes main.js and its imports are read relative to it, recursively. */
export function projectFromDisk(entryPath) {
  const root = dirname(entryPath);
  const project = new Project();
  const visit = (name, diskPath) => {
    if (project.has(name)) return;
    if (!existsSync(diskPath)) { if (name === ENTRY) throw new Error(`${diskPath}: no such file`); return; } // the module builder reports missing imports with the importing line
    let content = isTextFile(name) ? readFileSync(diskPath, 'utf8') : readFileSync(diskPath);
    if (content instanceof Buffer) content = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    project.set(name, content);
    if (!isScript(name)) return;
    for (const im of findImports(content)) {
      const target = resolveImport(im.spec, name);
      if (target) visit(target, join(root, target));
    }
  };
  visit(ENTRY, entryPath);
  return project;
}

/** Load a .temen archive or a script (with its folder's imports) as a Project. */
export function loadProject(path) {
  const p = resolve(path);
  return p.toLowerCase().endsWith(PROJECT_EXT) ? Project.fromZip(readFileSync(p)) : projectFromDisk(p);
}

/** A project folder as a Project: every accepted file under `dir` (used to package a folder for the catalogue). */
export function projectFromFolder(dir, { readdirSync, statSync } = {}) {
  const fs = { readdirSync, statSync };
  const project = new Project();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(join(dir, rel))) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (fs.statSync(join(dir, relPath)).isDirectory()) { walk(relPath); continue; }
      if (!ACCEPTED_EXT.includes(extOf(relPath))) continue; // manifest.json is accepted
      if (['thumb.png', 'preview.png'].includes(entry)) continue; // renders of the package, not part of it
      try {
        const b = readFileSync(join(dir, relPath));
        project.set(relPath, isTextFile(relPath) ? b.toString('utf8') : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      } catch { /* unsupported extension */ }
    }
  };
  walk('');
  return project;
}
