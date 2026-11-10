/**
 * The core's STL and 3MF writers (core/src/export.c) against the web app's (src/export.js), byte for byte:
 * every test script, the image and SVG projects, the demo and a .temen are built by the native tool and
 * by the JavaScript command line, and the files compared (for 3MF, each file inside the zip).
 *
 * The two builds must also make the same meshes. When they do not (a core parity failure, not a writer
 * one), the native STL is re-encoded with the JavaScript writer to say which it is.
 *
 *   node core/test/export-parity.mjs [path/to/temencore]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { unzipSync } from 'fflate';
import { buildSTL } from '../../src/export.js';
import { DEFAULT_SCRIPT } from '../../src/default-script.js';

const root = resolve(import.meta.dirname, '../..');
const bin = resolve(process.argv[2] ?? join(root, 'build/native/temencore'));
const dir = mkdtempSync(join(tmpdir(), 'temen-export-'));
const demo = join(dir, 'demo.js');
writeFileSync(demo, DEFAULT_SCRIPT);
const inputs = [
  ...readdirSync(join(root, 'test')).filter((f) => f.endsWith('.js')).map((f) => join(root, 'test', f)),
  join(root, 'test/images'), join(root, 'test/svg'), join(root, 'core/test/project.temen'), demo,
];

/** The triangle soup of a binary STL, back in our Y-up frame: (x, y, z)_stl = (x, -z, y). */
function stlPositions(buf) {
  const n = buf.readUInt32LE(80), out = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const o = 84 + t * 50 + 12 + k * 12, i = t * 9 + k * 3;
    out[i] = buf.readFloatLE(o); out[i + 1] = buf.readFloatLE(o + 8); out[i + 2] = -buf.readFloatLE(o + 4);
  }
  return out;
}
function differingTriangles(a, b) {
  let d = 0;
  for (let o = 84; o < Math.min(a.length, b.length); o += 50) if (Buffer.compare(a.subarray(o, o + 50), b.subarray(o, o + 50))) d++;
  return d;
}
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
let failed = 0;
const meshDiffers = new Set();
for (const input of inputs) {
  // the JS command line takes a folder project as its main.js
  const jsInput = input.endsWith('images') || input.endsWith('svg') ? join(input, 'main.js') : input;
  for (const ext of ['stl', '3mf']) {
    const native = join(dir, `n.${ext}`), js = join(dir, `j.${ext}`);
    try {
      execFileSync(bin, [input, '-o', native], { stdio: 'pipe' });
      execFileSync(process.execPath, [join(root, 'bin/temencad.mjs'), jsInput, '-o', js], { stdio: 'pipe' });
    } catch (e) { console.log(`FAIL ${basename(input)} .${ext}: ${String(e.stderr || e.message).trim().split('\n').pop()}`); failed++; continue; }
    const a = readFileSync(native), b = readFileSync(js);
    let diff = null;
    if (ext === 'stl') {
      if (!same(a, b)) {
        const recoded = Buffer.from(buildSTL([{ positions: stlPositions(a) }]).data);
        if (same(recoded, a)) { meshDiffers.add(input); console.log(`FAIL ${basename(input)} .stl: the native and WebAssembly builds made different meshes (${differingTriangles(a, b)} triangles); the writer itself re-encodes the native mesh identically`); failed++; continue; }
        diff = `${a.length} vs ${b.length} bytes, and not a mesh difference`;
      }
    } else if (meshDiffers.has(input)) { console.log(`skip ${basename(input)} .3mf: different meshes`); continue; }
    else {
      const za = unzipSync(a), zb = unzipSync(b);
      const names = [...new Set([...Object.keys(za), ...Object.keys(zb)])];
      const bad = names.filter((n) => !za[n] || !zb[n] || !same(za[n], zb[n]));
      if (bad.length) diff = `differs in ${bad.join(', ')}`;
    }
    if (diff) { console.log(`FAIL ${basename(input)} .${ext}: ${diff}`); failed++; }
    else console.log(`ok   ${basename(input)} .${ext}  ${a.length} bytes`);
  }
}
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} differ` : 'the meshes and the writers are identical');
process.exit(failed ? 1 : 0);
