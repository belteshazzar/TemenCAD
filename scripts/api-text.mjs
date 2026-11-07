// Write public/api.txt (the plain-text API reference) and public/llms.txt before a build, so agents can fetch them.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { referenceFromHtml } from '../src/api-text.js';
mkdirSync('public', { recursive: true });
writeFileSync('public/api.txt', referenceFromHtml(readFileSync('api.html', 'utf8')) + '\n');
writeFileSync('public/llms.txt', `# TemenCAD

> Free, browser-based, code-driven CAD for 3D printing: a short JavaScript script is the model, built on the Manifold kernel. Exports watertight STL and 3MF.

- App: https://belteshazzar.github.io/TemenCAD/
- API reference (plain text, complete): https://belteshazzar.github.io/TemenCAD/api.txt
- API reference (HTML): https://belteshazzar.github.io/TemenCAD/api.html
- Source and README: https://github.com/belteshazzar/TemenCAD
- Shared-shape catalogue: https://belteshazzar.github.io/TemenCAD-catalog/ (index.json lists packages; packages/<name>.temen downloads one)
- Product site: https://belteshazzar.github.io/TemenCAD-web/

## Working with it from a terminal or an agent

- \`npx temencad api\` prints the API reference. Read it before writing a script.
- \`npx temencad model.js -o model.stl --png model.png --views all\` builds a script (imports resolved from its folder), writes STL or 3MF, and renders labelled views to check; \`--section y=5\` cuts it open.
- \`npx temencad model.js --plate prusa-mk4\` checks the model fits a build plate (exit code 2 if not).
- \`npx temencad add <package>\` vendors a catalogue shape into a project.
- Scripts are plain JavaScript: units are millimetres, Y is up, the build plate is y = 0, +Z is the front. Return a shape, an array, or an object of named parts.
- The repository's AGENTS.md and .claude/skills/temencad/SKILL.md describe the conventions and the build-check loop.
`);
console.log('wrote public/api.txt and public/llms.txt');
