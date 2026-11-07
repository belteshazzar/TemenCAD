#!/usr/bin/env node
/**
 * TemenCAD command line: build a model script and write STL or 3MF, no browser needed.
 *
 *   temencad model.js                 -> model.stl   (imports resolved from the script's folder)
 *   temencad project.temen            -> project.stl (a .temen project archive)
 *   temencad model.js -o out.3mf      -> 3MF with named, colored parts
 *   temencad model.js --parts         -> one STL per part next to the output
 *   temencad model.js --plate prusa-mk4   check the result against a printer's build volume
 *   temencad model.js --png out.png   also render a picture of the result (no browser needed)
 *   temencad model.js --png out.png --views all --section y=5   a contact sheet of views, cut open at y = 5
 *   temencad model.js --check --report report.json   printability warnings, and everything as JSON for tools and agents
 *   temencad api                      print the API reference as plain text (for people and agents)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { buildSTL, build3MF } from '../src/export.js';
import { PLATES, fitProblems } from '../src/plate.js';
import { Project, ENTRY, PROJECT_EXT } from '../src/project.js';
import { whereText } from '../src/trace.js';
import { buildProject, loadProject } from '../src/headless.js';
import { readPackage, vendorPackage, addImportLine } from '../src/package.js';
import { CATALOG_URL } from '../src/config.js';
import { renderViews, sectionMeshes, VIEW_NAMES } from '../src/render.js';
import { meshStats, printability } from '../src/print.js';
import { polyhedronFromMesh } from '../src/cad.js';
import { colorHex } from '../src/export.js';
import { referenceFromHtml } from '../src/api-text.js';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: temencad <main.js | project.temen> [options]
       temencad add <package> [--into <main.js | project.temen>]
       temencad api

Builds the script or project with the same engine as the app and writes the visible, non-ghost parts.
A plain script may import sibling files (./lib.js, ./Logo.ttf, ./part.stl); they are read from its folder.
"add" copies a package from the shared catalogue into the project (catalog/<name>/) and adds its import.
"api" prints the complete API reference as plain text: read it before writing a script.

Options:
  -o, --output <file>   Output file; the extension picks the format: .stl or .3mf (default: <script>.stl)
      --parts           Also write one STL per named part into <output dir>/<output name>-parts/
      --plate <preset|WxDxH>
                        Check the model fits a build plate, e.g. --plate prusa-mk4 or --plate 220x220x250
      --list-plates     Print the plate presets and exit
      --png <file>      Also render the result to a PNG, with part labels, sizes, a scale bar and axes
      --views <list>    Views in that picture: iso (default), top, bottom, front, back, left, right, or all;
                        comma-separated views are tiled into one sheet, e.g. --views iso,top,front,right
      --section <axis=value>
                        Cut the model open for the picture, e.g. --section y=5 removes everything above y = 5
                        (x and z remove the positive side); cut faces are drawn red
      --size <WxH>      Size of one view in pixels (default 960x720)
      --no-labels       Plain render without labels
      --check           Check each part for printing: overhangs past 45°, unsupported islands and bridges,
                        walls under 0.8 mm, parts below the plate. Problems are printed as warnings; exit code 3
      --report <file>   Write a JSON report: parts (bounds, volume, surface area, centre of mass), warnings with
                        file and line, echo lines, the plate check and the --check results
      --into <file>     For "add": the project to add to (default ./main.js)
  -q, --quiet           Only print errors
  -h, --help            Show this help
`;

function parseArgs(argv) {
  const o = { script: null, output: null, parts: false, plate: null, quiet: false, add: null, into: null, png: null, size: [960, 720], views: ['iso'], section: null, labels: true, check: false, report: null };
  if (argv[0] === 'api') { process.stdout.write(referenceFromHtml(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'api.html'), 'utf8')) + '\n'); process.exit(0); }
  if (argv[0] === 'add') { o.add = argv[1] ?? fail(USAGE); argv = argv.slice(2); }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { process.stdout.write(USAGE); process.exit(0); }
    else if (a === '--list-plates') { for (const [id, label] of PLATES) if (id !== 'none' && id !== 'custom') console.log(`${id.padEnd(14)} ${label}`); process.exit(0); }
    else if (a === '-o' || a === '--output') o.output = argv[++i];
    else if (a === '--parts') o.parts = true;
    else if (a === '--plate') o.plate = argv[++i];
    else if (a === '--into') o.into = argv[++i];
    else if (a === '--png') o.png = argv[++i];
    else if (a === '--views') { const v = (argv[++i] ?? '').toLowerCase(); o.views = v === 'all' ? ['iso', 'top', 'front', 'right', 'bottom', 'back'] : v.split(',').map((s) => s.trim()).filter(Boolean); for (const n of o.views) if (!VIEW_NAMES.includes(n)) fail(`Unknown view "${n}". Use ${VIEW_NAMES.join(', ')} or all.`); }
    else if (a === '--section') { const m = (argv[++i] ?? '').match(/^([xyz])\s*=\s*(-?\d+(?:\.\d+)?)$/i); if (!m) fail('--section needs axis=value, e.g. --section y=5'); o.section = { axis: m[1].toLowerCase(), value: +m[2] }; }
    else if (a === '--no-labels') o.labels = false;
    else if (a === '--check') o.check = true;
    else if (a === '--report') o.report = argv[++i];
    else if (a === '--size') { const m = (argv[++i] ?? '').match(/^(\d+)x(\d+)$/i); if (!m) fail('--size needs WxH in pixels, e.g. 960x720'); o.size = [+m[1], +m[2]]; }
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a.startsWith('-')) fail(`Unknown option ${a}\n\n${USAGE}`);
    else if (!o.script) o.script = a;
    else fail(`Unexpected argument ${a}\n\n${USAGE}`);
  }
  if (!o.script && !o.add) fail(USAGE);
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
  if (opts.add) return addPackage(opts.add, opts.into ?? 'main.js', log);
  const scriptPath = resolve(opts.script);
  let project;
  try { project = loadProject(scriptPath); }
  catch (e) { fail(`Cannot load ${opts.script}: ${e.message}`); }
  const output = resolve(opts.output ?? scriptPath.replace(/\.[^.]*$/, '') + '.stl');
  const format = extname(output).toLowerCase();
  if (format !== '.stl' && format !== '.3mf') fail(`Output must end in .stl or .3mf, got ${basename(output)}`);
  const plate = opts.plate ? parsePlate(opts.plate) : null;

  const where = (m) => whereText(m.trace);
  const logs = [], warnings = [];
  const report = { ok: false, script: scriptPath, output: null, parts: [], warnings, logs, plate: null, check: null, triangles: 0, ms: 0 };
  const writeReport = () => { if (opts.report) { mkdirSync(dirname(resolve(opts.report)), { recursive: true }); writeFileSync(resolve(opts.report), JSON.stringify(report, null, 2) + '\n'); log(`Wrote ${resolve(opts.report)}`); } };
  let result;
  try {
    result = await buildProject(project, {
      onLog: (t) => { logs.push(t); log(t); },
      onWarn: (m) => { warnings.push({ text: m.text, file: m.file ?? null, line: m.line ?? null }); console.error(`Warning${where(m)}: ${m.text}`); },
    });
  } catch (err) {
    report.error = { message: err.message, file: err.file ?? null, line: err.line ?? null, trace: err.trace ?? [] };
    writeReport();
    fail(`Error${where(err)}: ${err.message}`);
  }

  const all = result.meshes;
  const parts = all.filter((m) => !m.ghost && !m.hidden);
  const skipped = all.length - parts.length;
  log(`Built ${all.length} part${all.length === 1 ? '' : 's'}, ${result.tris} triangles, ${result.ms.toFixed(0)} ms${skipped ? ` (${skipped} ghost/hidden not exported)` : ''}`);
  report.ok = true; report.triangles = result.tris; report.ms = +result.ms.toFixed(1);
  report.parts = all.map((p) => { const st = meshStats(p.positions, p.indices); return { name: p.name, color: p.color, ghost: p.ghost, hidden: p.hidden, triangles: p.indices.length / 3, volume: +st.volume.toFixed(3), surfaceArea: +st.surfaceArea.toFixed(3), centerOfMass: st.centerOfMass.map((v) => +v.toFixed(3)), bounds: { min: st.bounds.min, max: st.bounds.max, size: st.bounds.size } }; });
  if (!parts.length) { writeReport(); fail('Nothing to export: no visible, non-ghost parts'); }
  for (const p of parts) log(`  ${p.name}: ${p.indices.length / 3} triangles, ${p.volume.toFixed(1)} mm³`);

  let checkFailed = false;
  if (opts.check) {
    report.check = [];
    for (const p of parts) {
      const r = printability(polyhedronFromMesh(p.name, p.positions, p.indices));
      report.check.push({ name: p.name, ok: r.ok, problems: r.problems, overhangArea: +r.overhangs.area.toFixed(2), unsupportedArea: +r.unsupported.area.toFixed(2), minWall: Number.isFinite(r.minWall.thickness) ? +r.minWall.thickness.toFixed(3) : null });
      for (const pr of r.problems) { console.error(`Check: ${p.name}: ${pr}`); checkFailed = true; }
      if (r.ok) log(`  ${p.name}: prints without supports (walls ≥ ${Number.isFinite(r.minWall.thickness) ? r.minWall.thickness.toFixed(2) : '∞'} mm)`);
    }
  }

  if (plate) {
    const over = fitProblems(bounds(parts), plate);
    report.plate = { id: plate.id, size: [plate.w, plate.d, plate.h], fits: !over.length, problems: over };
    if (over.length) console.error(`Does not fit ${plate.w}×${plate.d}×${plate.h} plate: ${over.join(', ')}.`);
    else log(`Fits the ${plate.w}×${plate.d}×${plate.h} plate.`);
  }

  mkdirSync(dirname(output), { recursive: true });
  report.output = output;
  if (format === '.stl') { const { data, triangles } = buildSTL(parts); writeFileSync(output, Buffer.from(data)); log(`Wrote ${output} (${triangles} triangles)`); }
  else { writeFileSync(output, build3MF(parts)); log(`Wrote ${output} (${parts.length} part${parts.length === 1 ? '' : 's'})`); }

  if (opts.png) {
    const png = resolve(opts.png);
    mkdirSync(dirname(png), { recursive: true });
    let meshes = all;
    if (opts.section) meshes = sectionMeshes(all, opts.section);
    writeFileSync(png, renderViews(meshes, { views: opts.views, width: opts.size[0], height: opts.size[1], colorHex, labels: opts.labels, section: opts.section }));
    log(`Rendered ${png}${opts.views.length > 1 ? ` (${opts.views.join(', ')})` : ''}${opts.section ? `, cut at ${opts.section.axis} = ${opts.section.value}` : ''}`);
  }

  if (opts.parts) {
    const dir = output.replace(/\.[^.]*$/, '') + '-parts';
    mkdirSync(dir, { recursive: true });
    for (const p of parts) {
      const file = join(dir, `${safeName(p.name)}.stl`);
      writeFileSync(file, Buffer.from(buildSTL([p]).data));
      log(`Wrote ${file}`);
    }
  }
  writeReport();
  process.exitCode = plate && fitProblems(bounds(parts), plate).length ? 2 : checkFailed ? 3 : 0;
}

/** temencad add <name>: fetch the package from the catalogue and vendor it into a folder project or a .temen file. */
async function addPackage(name, into, log) {
  const target = resolve(into);
  const isArchive = target.toLowerCase().endsWith(PROJECT_EXT);
  const res = await fetch(`${CATALOG_URL}packages/${encodeURIComponent(name)}.temen`);
  if (!res.ok) fail(`Package "${name}" not found in the catalogue (${res.status}). See ${CATALOG_URL}`);
  const { manifest, project: pkg } = readPackage(new Uint8Array(await res.arrayBuffer()));
  let project;
  try { project = isArchive ? Project.fromZip(readFileSync(target)) : loadProject(target); }
  catch (e) { fail(`Cannot load ${into}: ${e.message}`); }
  const { dir, importLine, added } = vendorPackage(project, pkg, manifest);
  project.set(ENTRY, addImportLine(project.get(ENTRY), importLine));
  if (isArchive) {
    writeFileSync(target, project.toZip());
    log(`Added ${manifest.name}@${manifest.version} to ${target}`);
  } else {
    const root = dirname(target);
    for (const file of added) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      const c = project.get(file);
      writeFileSync(join(root, file), typeof c === 'string' ? c : Buffer.from(c));
    }
    writeFileSync(target, project.get(ENTRY));
    log(`Added ${manifest.name}@${manifest.version} to ${dir}/ and imported it in ${basename(target)}`);
  }
  log(`  ${importLine}`);
}

main().catch((e) => fail(`Error: ${e?.message ?? e}`));
