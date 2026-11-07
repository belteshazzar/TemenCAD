#!/usr/bin/env node
/**
 * TemenCAD command line: build a model script and write STL or 3MF, no browser needed.
 *
 *   temencad model.js                 -> model.stl
 *   temencad model.js -o out.3mf      -> 3MF with named, colored parts
 *   temencad model.js --parts         -> one STL per part next to the output
 *   temencad model.js --plate prusa-mk4   check the result against a printer's build volume
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../src/engine.js';
import { registerFont, DEFAULT_FONT } from '../src/fonts.js';
import { runScript } from '../src/runner.js';
import { buildSTL, build3MF } from '../src/export.js';
import { PLATES, fitProblems } from '../src/plate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: temencad <script.js> [options]

Builds the script with the same engine as the app and writes the visible, non-ghost parts.

Options:
  -o, --output <file>   Output file; the extension picks the format: .stl or .3mf (default: <script>.stl)
      --parts           Also write one STL per named part into <output dir>/<output name>-parts/
      --plate <preset|WxDxH>
                        Check the model fits a build plate, e.g. --plate prusa-mk4 or --plate 220x220x250
      --list-plates     Print the plate presets and exit
  -q, --quiet           Only print errors
  -h, --help            Show this help
`;

function parseArgs(argv) {
  const o = { script: null, output: null, parts: false, plate: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { process.stdout.write(USAGE); process.exit(0); }
    else if (a === '--list-plates') { for (const [id, label] of PLATES) if (id !== 'none' && id !== 'custom') console.log(`${id.padEnd(14)} ${label}`); process.exit(0); }
    else if (a === '-o' || a === '--output') o.output = argv[++i];
    else if (a === '--parts') o.parts = true;
    else if (a === '--plate') o.plate = argv[++i];
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a.startsWith('-')) fail(`Unknown option ${a}\n\n${USAGE}`);
    else if (!o.script) o.script = a;
    else fail(`Unexpected argument ${a}\n\n${USAGE}`);
  }
  if (!o.script) fail(USAGE);
  return o;
}

function fail(msg, code = 1) { process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n'); process.exit(code); }

function parsePlate(spec) {
  const preset = PLATES.find(([id]) => id === spec)?.[2];
  if (preset) return { id: spec, w: preset[0], d: preset[1], h: preset[2] };
  const m = spec.match(/^(\d+(?:\.\d+)?)\s*[x×,]\s*(\d+(?:\.\d+)?)\s*[x×,]\s*(\d+(?:\.\d+)?)$/i);
  if (!m) fail(`Unknown plate "${spec}". Use a preset (see --list-plates) or WxDxH in mm, e.g. 220x220x250.`);
  return { id: 'custom', w: +m[1], d: +m[2], h: +m[3] };
}

function bounds(parts) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < p.positions.length; k += 3) for (let i = 0; i < 3; i++) {
    const v = p.positions[k + i]; if (v < min[i]) min[i] = v; if (v > max[i]) max[i] = v;
  }
  return { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } };
}

const safeName = (s) => s.replace(/[^\w.-]+/g, '_');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.quiet ? () => {} : (s) => console.log(s);
  const scriptPath = resolve(opts.script);
  let code;
  try { code = readFileSync(scriptPath, 'utf8'); } catch (e) { fail(`Cannot read ${opts.script}: ${e.message}`); }
  const output = resolve(opts.output ?? scriptPath.replace(/\.[^.]*$/, '') + '.stl');
  const format = extname(output).toLowerCase();
  if (format !== '.stl' && format !== '.3mf') fail(`Output must end in .stl or .3mf, got ${basename(output)}`);
  const plate = opts.plate ? parsePlate(opts.plate) : null;

  await init();
  registerFont(DEFAULT_FONT, readFileSync(join(ROOT, 'src/assets/Inter-Regular-subset.ttf')).buffer);

  const where = (m) => (m.trace?.length ? ` (line ${m.trace[0]}${m.trace.length > 1 ? `, called from line ${m.trace.slice(1).join(' ← ')}` : ''})` : m.line ? ` (line ${m.line})` : '');
  let warnings = 0;
  let result;
  try {
    result = runScript(code, (m) => {
      if (m.type === 'log') log(m.text);
      else if (m.type === 'warn') { warnings++; console.error(`Warning${where(m)}: ${m.text}`); }
    });
  } catch (err) {
    fail(`Error${where(err)}: ${err.message}`);
  }

  const all = result.meshes;
  const parts = all.filter((m) => !m.ghost && !m.hidden);
  const skipped = all.length - parts.length;
  log(`Built ${all.length} part${all.length === 1 ? '' : 's'}, ${result.tris} triangles, ${result.ms.toFixed(0)} ms${skipped ? ` (${skipped} ghost/hidden not exported)` : ''}`);
  if (!parts.length) fail('Nothing to export: no visible, non-ghost parts');
  for (const p of parts) log(`  ${p.name}: ${p.indices.length / 3} triangles, ${p.volume.toFixed(1)} mm³`);

  if (plate) {
    const over = fitProblems(bounds(parts), plate);
    if (over.length) console.error(`Does not fit ${plate.w}×${plate.d}×${plate.h} plate: ${over.join(', ')}.`);
    else log(`Fits the ${plate.w}×${plate.d}×${plate.h} plate.`);
  }

  mkdirSync(dirname(output), { recursive: true });
  if (format === '.stl') { const { data, triangles } = buildSTL(parts); writeFileSync(output, Buffer.from(data)); log(`Wrote ${output} (${triangles} triangles)`); }
  else { writeFileSync(output, build3MF(parts)); log(`Wrote ${output} (${parts.length} part${parts.length === 1 ? '' : 's'})`); }

  if (opts.parts) {
    const dir = output.replace(/\.[^.]*$/, '') + '-parts';
    mkdirSync(dir, { recursive: true });
    for (const p of parts) {
      const file = join(dir, `${safeName(p.name)}.stl`);
      writeFileSync(file, Buffer.from(buildSTL([p]).data));
      log(`Wrote ${file}`);
    }
  }
  process.exitCode = plate && fitProblems(bounds(parts), plate).length ? 2 : 0;
}

main().catch((e) => fail(`Error: ${e?.message ?? e}`));
