// Pack the release tarball and prove it works on its own: install it in an empty project, then build a model with the
// installed command and through the library entry. The built wasm (core/wasm/dist, from `npm run core:wasm`) is not in
// git, so the tarball is the only way it reaches a project that depends on this one.
//   node scripts/pack-check.mjs [--out dir]    --out keeps the tarball there (the release workflow uploads that file)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outAt = process.argv.indexOf('--out');
const out = outAt < 0 ? null : resolve(process.argv[outAt + 1] ?? '.');
const fail = (message) => { console.error(`pack-check: ${message}`); process.exit(1); };
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

if (!existsSync(join(root, 'core/wasm/dist/temencore.wasm'))) fail('core/wasm/dist/temencore.wasm is missing: run `npm run core:wasm` first');

const work = mkdtempSync(join(tmpdir(), 'temencad-pack-'));
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], root));
  const paths = packed.files.map((f) => f.path);
  for (const need of ['bin/temencad.mjs', 'src/headless.js', 'src/core-runner.js', 'core/wasm/index.js', 'core/wasm/dist/temencore.mjs',
    'core/wasm/dist/temencore.wasm', 'api.html', '.claude/skills/temencad/SKILL.md'])
    if (!paths.includes(need)) fail(`${need} is not in the tarball: check "files" in package.json`);
  const stray = paths.filter((p) => /^(third_party|build|dist|ios|editor|test|node_modules|core\/(?!wasm\/))/.test(p));
  if (stray.length) fail(`the tarball holds files that do not belong in it: ${stray.slice(0, 5).join(', ')}`);
  const tarball = join(work, packed.filename);

  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'pack-check', private: true, type: 'module' }));
  run('npm', ['install', tarball, '--no-audit', '--no-fund', '--loglevel=error'], project);

  // the command: a 20 x 10 x 5 box, exported and drawn
  writeFileSync(join(project, 'model.js'), "const b = box(20, 10, 5);\nassert(Math.abs(b.volume() - 1000) < 1e-6, 'box volume');\necho('volume', b.volume());\nreturn { block: b };\n");
  const bin = join(project, 'node_modules/.bin/temencad');
  const built = run(bin, ['model.js', '-o', 'model.stl', '--png', 'model.png'], project);
  if (!/volume/.test(built)) fail(`the installed command did not run the model:\n${built}`);
  for (const f of ['model.stl', 'model.png']) if (!existsSync(join(project, f)) || statSync(join(project, f)).size < 100) fail(`the installed command did not write ${f}`);
  if (!/sketch/.test(run(bin, ['api', '--list'], project))) fail('`temencad api --list` printed no reference');

  // the library entry the other repositories import
  writeFileSync(join(project, 'lib.mjs'), `import { resolve } from 'node:path';
import { buildProject, projectFromDisk } from 'temencad/src/headless.js';
const { meshes, tris } = await buildProject(projectFromDisk(resolve('model.js')));
if (meshes.length !== 1 || tris !== 12) throw new Error('expected one part of 12 triangles, got ' + meshes.length + ' and ' + tris);
`);
  run(process.execPath, ['lib.mjs'], project);

  if (out) { mkdirSync(out, { recursive: true }); copyFileSync(tarball, join(out, packed.filename)); }
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  console.log(`pack-check: ${packed.filename} (version ${version}, ${packed.files.length} files, ${(packed.size / 1e6).toFixed(2)} MB) installs and builds a model`
    + (out ? `; kept in ${out}` : ''));
} finally {
  rmSync(work, { recursive: true, force: true });
}
