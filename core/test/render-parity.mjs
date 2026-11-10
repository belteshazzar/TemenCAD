/**
 * The core's render sheet (core/src/render.c) against the web app's (src/render.js), pixel for pixel:
 * every test script, the image and SVG projects and the demo are rendered by the native tool
 * (temencore --png) and by the JavaScript command line (temencad --png) with the same views, size,
 * labels and section, both PNGs decoded and every pixel compared (the two zlib encoders differ, the
 * pixels must not).
 *
 *   node core/test/render-parity.mjs [path/to/temencore]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { unzlibSync } from 'fflate';
import { DEFAULT_SCRIPT } from '../../src/default-script.js';

const root = resolve(import.meta.dirname, '../..');
const bin = resolve(process.argv[2] ?? join(root, 'build/native/temencore'));
const dir = mkdtempSync(join(tmpdir(), 'temen-render-'));
const demo = join(dir, 'demo.js');
writeFileSync(demo, DEFAULT_SCRIPT);

/** RGB pixels of an 8-bit RGB PNG: { width, height, rgb }. */
function decode(buf) {
  let o = 8, width = 0, height = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 2) throw new Error('not 8-bit RGB'); }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = unzlibSync(Buffer.concat(idat)), stride = width * 3, rgb = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 3 ? rgb[y * stride + x - 3] : 0, b = y ? rgb[(y - 1) * stride + x] : 0, c = x >= 3 && y ? rgb[(y - 1) * stride + x - 3] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      rgb[y * stride + x] = (v + pred) & 255;
    }
  }
  return { width, height, rgb };
}

const cases = [
  ...readdirSync(join(root, 'test')).filter((f) => f.endsWith('.js')).map((f) => [join(root, 'test', f), ['--views', 'iso,top,front,right']]),
  [join(root, 'test/images'), ['--views', 'iso']],
  [join(root, 'test/svg'), ['--views', 'iso,top']],
  [demo, ['--views', 'iso,top,front,right,bottom,back']],
  [join(root, 'test/hole.js'), ['--views', 'iso,front', '--section', 'z=0']],
  [join(root, 'test/fillet.js'), ['--views', 'iso,left', '--section', 'y=3', '--no-labels']],
  [demo, ['--views', 'iso', '--section', 'x=10']],
];
let failed = 0;
for (const [input, opts] of cases) {
  const jsInput = input.endsWith('images') || input.endsWith('svg') ? join(input, 'main.js') : input;
  const c = join(dir, 'c.png'), j = join(dir, 'j.png');
  const size = ['--size', '480x360'];
  execFileSync(bin, [input, '--png', c, ...size, ...opts], { stdio: 'pipe' });
  execFileSync(process.execPath, [join(root, 'bin/temencad.mjs'), jsInput, '-o', join(dir, 'j.stl'), '--png', j, ...size, ...opts], { stdio: 'pipe' });
  const a = decode(readFileSync(c)), b = decode(readFileSync(j));
  let diff = 0, first = -1;
  if (a.width !== b.width || a.height !== b.height) diff = -1;
  else for (let i = 0; i < a.rgb.length; i++) if (a.rgb[i] !== b.rgb[i]) { diff++; if (first < 0) first = i; }
  const what = `${basename(input)} ${opts.join(' ')}`;
  if (diff) {
    failed++;
    const at = first >= 0 ? ` (first at x ${(first / 3) % a.width | 0}, y ${(first / 3 / a.width) | 0})` : '';
    console.log(`FAIL ${what}: ${diff < 0 ? `${a.width}x${a.height} vs ${b.width}x${b.height}` : `${diff} channel values differ${at}`}`);
  } else console.log(`ok   ${what}  ${a.width}x${a.height}`);
}
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} differ` : 'all pixels identical');
process.exit(failed ? 1 : 0);
