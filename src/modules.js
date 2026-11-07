/**
 * Turns a project's files into real ES modules the engine can import():
 *   - main.js is wrapped so its top-level `return` works: imports are hoisted onto line 1 together
 *     with the API prelude and `export default async function main() {`, so user line L is module line L + 1
 *   - other scripts keep their exports; only the import specifiers are rewritten in place
 *   - a font file becomes `export default "<its path>"` (a name text() accepts)
 *   - a mesh file becomes `export default __temen.loadMesh("<its path>")`
 *   - an image file becomes `export default __temen.loadImage("<its path>")` (decoded before the run)
 * `makeUrl(code)` turns module source into an importable URL (blob: in a browser worker, data: in Node).
 * Returns { entryUrl, locate(url) -> { file, offset } } for mapping stack traces back to files.
 */
import { ENTRY, findImports, resolveImport, isScript, isFontFile, isMeshFile, isImageFile } from './project.js';

export class ModuleError extends Error {
  constructor(message, file, line) { super(message); this.name = 'ModuleError'; this.file = file; this.line = line; }
}

export function buildModules(files, apiNames, makeUrl) {
  if (!(ENTRY in files)) throw new ModuleError(`The project has no ${ENTRY}`, null, null);
  // Scripts get the API as module-scope bindings. Network and nested-worker globals are shadowed so shared
  // catalogue code cannot phone home from inside the geometry worker (the kernel has no need for them).
  const prelude = `const { ${apiNames.join(', ')} } = globalThis.__temen.api; const fetch = undefined, XMLHttpRequest = undefined, WebSocket = undefined, importScripts = undefined, EventSource = undefined;`;
  const urls = new Map();     // file -> url
  const byUrl = new Map();    // url -> { file, offset }
  const visiting = new Set();

  const build = (file, chain) => {
    if (urls.has(file)) return urls.get(file);
    if (visiting.has(file)) throw new ModuleError(`Circular import: ${[...chain, file].join(' → ')}`, chain[chain.length - 1], null);
    visiting.add(file);
    let source, offset = 0;
    if (isScript(file)) {
      const code = files[file];
      const imports = findImports(code);
      const deps = imports.map((im) => {
        const target = resolveImport(im.spec, file);
        if (!target || !(target in files)) throw new ModuleError(`Cannot find '${im.spec}' imported from ${file}`, file, im.line);
        if (!isScript(target) && !isFontFile(target) && !isMeshFile(target) && !isImageFile(target)) throw new ModuleError(`'${im.spec}' is not a script, font, mesh or image file`, file, im.line);
        return { ...im, url: build(target, [...chain, file]) };
      });
      if (file === ENTRY) {
        // Blank the import statements (keeping line breaks) and put one-line versions on line 1.
        let body = code;
        for (const d of [...deps].reverse()) {
          const stmtStart = code.lastIndexOf('import', d.start);
          const stmtEnd = code.indexOf('\n', d.end) === -1 ? code.length : code.indexOf('\n', d.end);
          const stmt = code.slice(stmtStart, d.end).replace(/\s+/g, ' ').replace(/(['"])[^'"]+\1$/, JSON.stringify(d.url));
          d.oneLine = stmt;
          body = body.slice(0, stmtStart) + body.slice(stmtStart, stmtEnd).replace(/[^\n]/g, '') + body.slice(stmtEnd);
        }
        const hoisted = deps.map((d) => d.oneLine + ';').join(' ');
        source = `${prelude} ${hoisted} export default async function main() {\n${body}\n}`;
        offset = 1;
      } else {
        let out = code;
        for (const d of [...deps].reverse()) out = out.slice(0, d.start) + JSON.stringify(d.url) + out.slice(d.end);
        source = `${prelude}\n${out}`;
        offset = 1;
      }
    } else if (isFontFile(file)) {
      source = `export default ${JSON.stringify(file)};`;
    } else if (isMeshFile(file)) {
      source = `export default globalThis.__temen.loadMesh(${JSON.stringify(file)});`;
    } else if (isImageFile(file)) {
      source = `export default globalThis.__temen.loadImage(${JSON.stringify(file)});`;
    } else {
      throw new ModuleError(`Cannot import ${file}`, chain[chain.length - 1] ?? null, null);
    }
    const url = makeUrl(source);
    urls.set(file, url);
    byUrl.set(url, { file, offset });
    visiting.delete(file);
    return url;
  };

  const entryUrl = build(ENTRY, []);
  return { entryUrl, urls: [...urls.values()], locate: (url) => byUrl.get(url) ?? null };
}
