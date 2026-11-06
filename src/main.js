import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { keymap } from '@codemirror/view';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { Viewer } from './viewer.js';
import { exportSTL, export3MF } from './export.js';
import { FileManager } from './files.js';
import { VariablesPanel } from './variables.js';
import { PLATES, fitProblems } from './plate.js';

const DEFAULT_SCRIPT = `// TextCAD kitchen-sink demo — write JavaScript, see the model.
// Units are mm, Y is up, the build plate is y = 0. Click "API" for the full list.
// Each block below shows one capability; they are spread out on the plate.
// Top-level constants like these show up as sliders in the Variables panel:
const T = 10;          // Mounting block thickness [4, 20, 1]
const CUP_WALL = 1.6;  // Cup wall [0.8, 4, 0.1]
const TEXT_SIZE = 7;   // Tag text size [4, 10, 0.5]
const SHOW_TEXT = true; // Show text demos

const parts = [];
// place(shape, x, z, color, name?) — names show up in the Parts panel (top right of the viewport)
const place = (shape, x, z, color, name) => {
  let s = shape.onPlate().translate(x, 0, z).color(color);
  if (name) s = s.name(name);
  parts.push(s);
};

// 1. Primitives: box, sphere, cylinder, cone, torus, prism
place(box(12, 8, 10), -60, -60, '#8fb3ff');
place(sphere(6), -40, -60, '#ff8f8f');
place(cylinder(5, 10), -20, -60, '#8fe3a8');
place(cone(6, 10), 0, -60, '#ffd27f');
place(torus(6, 2), 20, -60, '#d3a6ff');
place(prism(6, 6, 8), 40, -60, '#7fe0e0');

// 2. Rounded boxes: all edges vs. vertical edges only (prints flat)
place(roundedBox(14, 10, 14, 3), -60, -35, '#8fb3ff');
place(roundedBox(14, 10, 14, 4, { edges: 'vertical' }), -40, -35, '#8fb3ff');

// 3. Booleans: union, difference, intersect, plus the method forms
const u = union(box(10), sphere(6.5));
const d = box(10).subtract(sphere(6.5));
const i = intersect(box(10), sphere(6.5));
place(u, -15, -35, '#ffb366');
place(d, 5, -35, '#ffb366');
place(i, 25, -35, '#ffb366');

// 4. Hull: a rounded "pill" bracket from two cylinders, and a hull of raw points
place(hull(cylinder(4, 6), cylinder(4, 6).translate(14, 0, 0)), 45, -35, '#c2e86b');
place(hull([0, 0, 0], [12, 0, 0], [6, 0, 10], [6, 12, 4]), 65, -35, '#c2e86b');

// 5. 2D sketches -> extrude. Sketch x = world X, sketch y = world -Z, extrude goes up Y.
const plate2d = roundedRect(20, 14, 3)
  .subtract(circle(3))
  .subtract(slot(8, 1.2).translate(0, 4))
  .subtract(regularPolygon(6, 2).translate(-6, -3));
place(extrude(plate2d, 3), -60, -5, '#8fe3a8');

// twist + scale extrusion
place(extrude(rect(10, 10), 18, { twist: 90, scale: 0.4 }), -35, -5, '#8fe3a8');

// star outline from polygon2d, extruded
const star = polygon2d(Array.from({ length: 10 }, (_, k) => {
  const a = (k / 10) * Math.PI * 2, r = k % 2 ? 4 : 9;
  return [Math.cos(a) * r, Math.sin(a) * r];
}));
place(extrude(star, 4), -10, -5, '#8fe3a8');

// 6. Revolve: a vase profile (sketch x = radius, sketch y = height), and a partial revolve
const vase = polygon2d([[0, 0], [7, 0], [8, 2], [5, 9], [6, 16], [4.6, 16], [3.8, 9], [6.8, 2], [6.2, 1.2], [0, 1.2]]);
place(revolve(vase, { segments: 72 }), 15, -5, '#d3a6ff');
place(revolve(rect(4, 10, { center: false }).translate(4, 0), { angle: 270 }), 40, -5, '#d3a6ff');

// 7. Arrays: linear, polar (bolt circle) and grid, merged with union()
place(union(linearArray(box(3, 6, 3), 5, [5, 0, 0])), -60, 25, '#ffd27f');
const ring = cylinder(10, 2).subtract(polarArray(cylinder(1.5, 4), 8, { radius: 7 }));
place(ring, -30, 25, '#ffd27f');
place(union(grid(cylinder(1.2, 5), [4, 3], [4, 4])), 0, 25, '#ffd27f');

// 8. Alignment helpers: stack parts with align()
const base = box(16, 3, 16);
const post = cylinder(2, 10).align({ y: 'min' }, [0, base.bounds().max[1], 0]);
const cap = sphere(4).align({ y: 'min' }, [0, post.bounds().max[1], 0]);
place(union(base, post, cap), 30, 25, '#7fe0e0');

// 9. Screw helpers (cutters, axis Y, top at y = 0): clearance, countersunk, counterbore,
//    nut pocket and heat-set insert, all in one mounting block
const block = roundedBox(44, T, 16, 3, { edges: 'vertical' }).onPlate();
const top = (s) => s.translate(0, T, 0);
const cutters = [
  top(screwHole('M3', T)).translate(-16, 0, 0),
  top(screwHole('M3', T, { type: 'countersunk' })).translate(-8, 0, 0),
  top(screwHole('M4', T, { type: 'counterbore' })).translate(0, 0, 0),
  top(screwHole('M3', T)).translate(8, 0, 0),
  nutPocket('M3').rotate(180, 0, 0).translate(8, 0, 0),              // nut trap underneath
  top(heatInsert('M3', { depth: 6 })).translate(16, 0, 0),
];
place(block.subtract(cutters), 55, 25, '#ff8f8f', 'mounting block');

// 15. Named parts, ghosts and hidden parts. Ghosts render transparent and are never exported.
show(box(180, 30, 180).onPlate().translate(0, 0, 5), { name: 'print envelope', ghost: true });
show(sphere(4).translate(0, 4, 75), { name: 'hidden marble', hidden: true, color: '#ff4d4d' });

// 10. Colors, mirror, and log() to the console
const wing = polygon([[0, 0], [12, 0], [0, 8]], 3).translate(2, 0, 0);
place(union(wing, wing.mirror('x')), -70, 50, '#c2e86b');

// 11. 2D corner treatments: fillet and chamfer a sketch before extruding
place(extrude(rect(14, 10).fillet(3), 4), -45, 50, '#8fe3a8');
place(extrude(rect(14, 10).chamfer(3).subtract(circle(2)), 4), -25, 50, '#8fe3a8');

// 12. Text: 2D text() for engraving, text3d() for raised letters
if (SHOW_TEXT) {
  const tag = roundedBox(34, 3, 12, 2, { edges: 'vertical' })
    .subtract(text3d('TextCAD', { size: TEXT_SIZE, height: 1.2, align: 'center' }).translate(0, 1.5 - 0.6, -2.5));
  place(tag, 5, 50, '#ffd27f', 'name tag');
  place(text3d('3D', { size: 12, height: 3, align: 'center' }), 35, 50, '#ff8f8f');
}

// 13. Loft between profiles, and a shelled cup (hollow with an open top)
place(loft([circle(6), rect(8, 8).fillet(2), regularPolygon(6, 4)], [0, 8, 16]), 60, 50, '#d3a6ff');
place(cylinder(7, 14).shell(CUP_WALL, { open: 'top' }), -70, 75, '#7fe0e0', 'cup');

// 14. Minkowski rounding and a hand-built polyhedron (a wedge)
place(box(10, 6, 8).round(1.5), -45, 75, '#8fb3ff');
const wedge = polyhedron(
  [[0, 0, 0], [12, 0, 0], [12, 0, 8], [0, 0, 8], [0, 6, 0], [0, 6, 8]],
  [[0, 1, 2, 3], [4, 5, 2, 1], [0, 4, 1], [3, 2, 5], [0, 3, 5, 4]],
);
place(wedge, -22, 75, '#ffb366', 'wedge');
log('parts:', parts.length, '· block volume:', Math.round(parts[parts.length - 2].volume()), 'mm³');

return parts;
`;

const STORAGE_KEY = 'textcad.script';
const viewer = new Viewer(document.getElementById('viewport'));
const consoleEl = document.getElementById('console');
let autorun = (() => { try { return localStorage.getItem('textcad.autorun') !== '0'; } catch { return true; } })();

let timer = null;
function scheduleRun(delay = 400) {
  if (!autorun) return;
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

const editor = new EditorView({
  doc: localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SCRIPT,
  extensions: [
    basicSetup,
    lintGutter(),
    javascript(),
    keymap.of([
      { key: 'Mod-Enter', run: () => (run(), true) },
      { key: 'Mod-o', run: () => (files.open().catch(reportErr), true) },
      { key: 'Mod-s', run: () => (files.save().catch(reportErr), true) },
      { key: 'Shift-Mod-s', run: () => (files.saveAs().catch(reportErr), true) },
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        localStorage.setItem(STORAGE_KEY, u.state.doc.toString());
        files?.markChanged();
        variables?.refresh();
        scheduleRun();
      }
    }),
  ],
  parent: document.getElementById('editor'),
});

const files = new FileManager({
  getText: () => editor.state.doc.toString(),
  setText: (text) => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    clearTimeout(timer);
    run();
  },
  fileInput: document.getElementById('file-input'),
  onChange: (f) => { document.title = `${f.dirty ? '• ' : ''}${f.name} — TextCAD`; },
});
const reportErr = (err) => logLine(String(err.message ?? err), 'err');
// Sliders rewrite the source; rebuild quickly since the kernel is fast.
const variables = new VariablesPanel(document.getElementById('variables'), editor, () => scheduleRun(60));
variables.refresh();
window.addEventListener('beforeunload', (e) => { if (files.dirty) e.preventDefault(); });

function logLine(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

const busyEl = document.getElementById('busy');
const busyTimeEl = document.getElementById('busy-time');

// ---- Worker lifecycle ----
let worker = null, runId = 0, current = null, pending = false, timerHandle = null;

function spawnWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => finish({ type: 'error', id: current?.id, message: `Worker error: ${e.message}` });
}
spawnWorker();

function setBusy(on) {
  busyEl.classList.toggle('show', on);
  clearInterval(timerHandle);
  if (on) {
    const t0 = performance.now();
    busyTimeEl.textContent = '';
    timerHandle = setInterval(() => { busyTimeEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
  }
}

let diagnostics = [];
function clearDiagnostics() { diagnostics = []; editor.dispatch(setDiagnostics(editor.state, [])); }
/** Mark a source line in the editor (squiggle + gutter icon + hover message). */
function addDiagnostic(line, message, severity) {
  if (!line) return;
  const doc = editor.state.doc;
  const l = doc.line(Math.min(Math.max(1, line), doc.lines));
  const from = l.from + (l.text.match(/^\s*/)?.[0].length ?? 0);
  diagnostics.push({ from, to: Math.max(from + 1, l.to), severity, message });
  editor.dispatch(setDiagnostics(editor.state, diagnostics));
}

/** " (line 6, called from line 32)" */
function where(msg) {
  const t = msg.trace?.length ? msg.trace : msg.line ? [msg.line] : [];
  if (!t.length) return '';
  return ` (line ${t[0]}${t.length > 1 ? `, called from line ${t.slice(1).join(' ← ')}` : ''})`;
}
/** Mark the innermost line with the message and each caller with a pointer to it. */
function markTrace(msg, severity, message) {
  const t = msg.trace?.length ? msg.trace : msg.line ? [msg.line] : [];
  if (!t.length) return;
  addDiagnostic(t[0], message, severity);
  t.slice(1).forEach((l, i) => addDiagnostic(l, `Called from here → ${severity} at line ${t[i]}: ${message}`, 'info'));
}

function run() {
  if (current) { pending = true; return; }
  consoleEl.textContent = '';
  clearDiagnostics();
  current = { id: ++runId };
  setBusy(true);
  worker.postMessage({ type: 'run', id: current.id, code: editor.state.doc.toString() });
}

function cancel() {
  if (!current) return;
  worker.terminate();
  current = null;
  pending = false;
  setBusy(false);
  logLine('Build cancelled.', 'err');
  spawnWorker();
}

function onWorkerMessage(e) {
  const msg = e.data;
  if (msg.type === 'ready') return;
  if (msg.id !== current?.id) return; // stale message from a superseded run
  if (msg.type === 'log') { logLine(msg.text); return; }
  if (msg.type === 'warn') {
    logLine(`Warning${where(msg)}: ${msg.text}`, 'warn');
    markTrace(msg, 'warning', msg.text);
    return;
  }
  finish(msg);
}

// ---- Parts panel ----
const partsEl = document.getElementById('parts-menu');
const partsBody = partsEl.querySelector('.parts-body');
const partState = new Map(); // name -> { visible, ghost } overrides that survive rebuilds
let parts = [];
// Keep the dropdown open while interacting with the list.
partsEl.querySelector('.parts-items').addEventListener('click', (e) => e.stopPropagation());
partsEl.querySelector('.parts-all').addEventListener('click', () => { partState.clear(); renderParts(); checkFit(); });
partsEl.querySelector('.parts-none').addEventListener('click', () => {
  parts.forEach((p) => partState.set(p.name, { ...partFlags(p), visible: false }));
  renderParts(); checkFit();
});

function partFlags(p) {
  const o = partState.get(p.name) ?? {};
  return { visible: o.visible ?? !p.hidden, ghost: o.ghost ?? p.ghost };
}
function setPart(p, patch) {
  partState.set(p.name, { ...partFlags(p), ...patch });
  renderParts();
  checkFit();
}
function renderParts() {
  partsBody.textContent = '';
  if (!parts.length) { partsBody.appendChild(Object.assign(document.createElement('div'), { className: 'parts-empty', textContent: 'No parts yet' })); }
  parts.forEach((p, i) => {
    const f = partFlags(p);
    viewer.updatePart(i, f);
    const row = document.createElement('div');
    row.className = `part-row${f.visible ? '' : ' off'}${f.ghost ? ' ghost' : ''}`;
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: f.visible, title: 'Show / hide' });
    cb.addEventListener('change', () => setPart(p, { visible: cb.checked }));
    const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = p.color;
    const name = document.createElement('span'); name.className = 'pname'; name.textContent = p.name;
    name.title = `${p.name}\n${p.tris} triangles · ${p.volume.toFixed(1)} mm³\nClick to show/hide · double-click to solo`;
    // Single click toggles like the checkbox; a double-click solos (and undoes the two single-click toggles).
    let clickTimer = null;
    name.addEventListener('click', () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => setPart(p, { visible: !partFlags(p).visible }), 220);
    });
    name.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      const soloed = parts.every((q, j) => (j === i) === partFlags(q).visible);
      parts.forEach((q, j) => partState.set(q.name, { ...partFlags(q), visible: soloed ? true : j === i }));
      renderParts();
    });
    const ghost = document.createElement('button'); ghost.textContent = 'ghost'; ghost.title = 'Show as transparent reference (not exported)';
    ghost.className = f.ghost ? 'on' : ''; ghost.addEventListener('click', () => setPart(p, { ghost: !f.ghost }));
    const stl = document.createElement('button'); stl.textContent = 'stl'; stl.title = 'Export this part as STL';
    stl.addEventListener('click', () => {
      try {
        const n = exportSTL(viewer.modelGroup, `${p.name.replace(/[^\w.-]+/g, '_')}.stl`, { only: [i] });
        logLine(`Exported ${n} triangles: ${p.name}`);
      } catch (err) { reportErr(err); }
    });
    row.append(cb, sw, name, ghost, stl);
    partsBody.appendChild(row);
  });
  if (document.querySelector('#menu-root > .menu-items.drilled')) fitMenuHeight();
}

renderParts();

let framedOnce = false;
function finish(msg) {
  if (msg.type === 'result') {
    // Catch anything Three.js complains about while building the display meshes.
    const origWarn = console.warn;
    console.warn = (...a) => { logLine(`Warning: ${a.join(' ')}`, 'warn'); origWarn(...a); };
    try { viewer.setMeshes(msg.meshes); } finally { console.warn = origWarn; }
    parts = msg.meshes.map((m) => ({ name: m.name, color: m.color, ghost: m.ghost, hidden: m.hidden, volume: m.volume, tris: m.indices.length / 3 }));
    if (!framedOnce) { framedOnce = true; if (!plate) viewer.resetView(); }
    for (const k of [...partState.keys()]) if (!parts.some((p) => p.name === k)) partState.delete(k);
    renderParts();
    const n = msg.meshes.length;
    const fit = checkFit();
    logLine(`Built ${n} part${n === 1 ? '' : 's'}, ${msg.tris} triangles, ${msg.ms.toFixed(0)} ms${fit}`, 'info');
  } else {
    logLine(`Error${where(msg)}: ${msg.message}`, 'err');
    markTrace(msg, 'error', msg.message.split('\n')[0]);
  }
  current = null;
  setBusy(false);
  if (pending) { pending = false; run(); }
}

// ---- Build plate presets and fit check ----
const plateMenu = document.getElementById('plate-menu');
const plateItems = plateMenu.querySelector('.plate-items');
let plate = null;
const loadCustom = () => { try { return JSON.parse(localStorage.getItem('textcad.plate.custom')); } catch { return null; } };

function renderPlateMenu() {
  plateItems.textContent = '';
  document.querySelector('[data-sub="plate"] .check').textContent = plate ? '✓' : '';
  const custom = loadCustom();
  PLATES.forEach(([id, label, dims], i) => {
    if (id === 'custom' || id === 'none') { if (i > 0) plateItems.appendChild(document.createElement('hr')); }
    const b = document.createElement('button');
    b.type = 'button';
    const name = label.split(' · ')[0];
    const size = id === 'custom' ? (custom ? custom.join('×') : '') : dims ? dims.join('×') : '';
    b.innerHTML = `<span class="check">${plate?.id === id || (!plate && id === 'none') ? '✓' : ''}</span>${name}<span class="dims">${size}</span>`;
    b.addEventListener('click', () => applyPlate(id, id === 'custom'));
    plateItems.appendChild(b);
  });
}

/** Ask for a custom plate size with a dialog; resolves to [w, d, h] or null if cancelled. */
function askPlateSize(initial = [200, 200, 200]) {
  const dialog = document.getElementById('plate-dialog');
  const form = document.getElementById('plate-form');
  ['w', 'd', 'h'].forEach((k, i) => { form.elements[k].value = initial[i]; });
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done);
      if (dialog.returnValue !== 'ok') return resolve(null);
      const dims = ['w', 'd', 'h'].map((k) => parseFloat(form.elements[k].value));
      resolve(dims.every((n) => Number.isFinite(n) && n > 0) ? dims : null);
    };
    dialog.addEventListener('close', done);
    form.querySelector('[data-cancel]').onclick = () => dialog.close('cancel');
    dialog.showModal();
    form.elements.w.select();
  });
}

async function applyPlate(id, ask = false) {
  let dims = PLATES.find((p) => p[0] === id)?.[2];
  if (id === 'custom') {
    dims = loadCustom();
    if (ask || !dims) {
      const entered = await askPlateSize(dims ?? undefined);
      if (!entered) { renderPlateMenu(); return; }
      dims = entered;
      try { localStorage.setItem('textcad.plate.custom', JSON.stringify(dims)); } catch {}
    }
  }
  plate = dims ? { id, w: dims[0], d: dims[1], h: dims[2] } : null;
  try { localStorage.setItem('textcad.plate', id); } catch {}
  renderPlateMenu();
  viewer.setPlate(plate);
  checkFit();
  viewer.resetView();
}

/** Compare visible parts with the plate; report in the status bar, console and plate outline. */
function checkFit() {
  if (!plate) return '';
  const b = viewer.visibleBounds();
  if (!b) { viewer.setPlateFit(true); return ''; }
  const over = fitProblems(b, plate);
  viewer.setPlateFit(over.length === 0);
  if (over.length) logLine(`Does not fit ${plate.w}×${plate.d}×${plate.h} plate: ${over.join(', ')}.`, 'warn');
  return over.length ? ', does not fit the plate' : ', fits the plate';
}
applyPlate((() => { try { return localStorage.getItem('textcad.plate') || 'none'; } catch { return 'none'; } })());
// Choosing a plate closes the menu like any other menu action.

// Toolbar
document.getElementById('run').addEventListener('click', run);
document.getElementById('cancel').addEventListener('click', cancel);
// Show platform-appropriate shortcut hints (⌘ on Mac, Ctrl elsewhere)
if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
  for (const k of document.querySelectorAll('.menu-items kbd')) k.textContent = k.textContent.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+').replace('↩', 'Enter');
}

// View menu
const viewMenu = document.getElementById('view-menu');
const wireframeItem = viewMenu.querySelector('[data-action="wireframe"]');
const autorunItem = viewMenu.querySelector('[data-action="autorun"]');
const runButton = document.getElementById('run');
const reflectAutorun = () => {
  autorunItem.querySelector('.check').textContent = autorun ? '✓' : '';
  runButton.hidden = autorun; // manual Run only matters when auto-run is off
};
reflectAutorun();
let wireframe = false;
viewMenu.addEventListener('click', (e) => {
  const view = e.target.closest('[data-view]')?.dataset.view;
  if (view) { viewer.setView(view); closeMenus(); return; }
  const action = e.target.closest('button')?.dataset.action;
  if (!action) return;
  if (action === 'run') run();
  if (action === 'reset-view') viewer.resetView();
  if (action === 'wireframe') {
    wireframe = !wireframe;
    viewer.setWireframe(wireframe);
    wireframeItem.querySelector('.check').textContent = wireframe ? '✓' : '';
  }
  if (action === 'autorun') {
    autorun = !autorun;
    try { localStorage.setItem('textcad.autorun', autorun ? '1' : '0'); } catch {}
    reflectAutorun();
    if (autorun) scheduleRun(0);
  }
  closeMenus();
});
// Dropdown menus (File, Parts): one open at a time; outside click or Escape closes.
const menus = [...document.querySelectorAll('.menu')];
const closeMenus = () => menus.forEach((m) => m.classList.remove('open'));
for (const m of menus) {
  m.querySelector('.menu-button').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = m.classList.contains('open');
    closeMenus();
    if (!open) {
      m.classList.add('open');
      if (m.id === 'menu-root') { mainMenu.style.transition = 'none'; closeSub(); requestAnimationFrame(() => { mainMenu.style.transition = ''; }); }
    }
  });
}
document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

// Drill-down submenus (Plate, Parts): slide between the main panel and the sub panel.
const mainMenu = document.querySelector('#menu-root > .menu-items');
const panelMain = mainMenu.querySelector('.panel-main');
const panelSub = mainMenu.querySelector('.panel-sub');
const subTitle = mainMenu.querySelector('.sub-title');
const SUB_TITLES = { plate: 'Plate', parts: 'Parts' };
function fitMenuHeight() {
  const drilled = mainMenu.classList.contains('drilled');
  const cs = getComputedStyle(mainMenu);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  // The sub panel's header stays fixed; only its content area scrolls.
  const content = drilled ? panelSub.querySelector('.sub-head').offsetHeight + panelSub.querySelector('.sub-scroll').scrollHeight : panelMain.scrollHeight;
  mainMenu.style.height = `${Math.min(content + pad, window.innerHeight * 0.7)}px`;
}
function openSub(name) {
  for (const c of panelSub.querySelectorAll('.sub-content')) c.hidden = c.dataset.subContent !== name;
  subTitle.textContent = SUB_TITLES[name] ?? 'Back';
  panelSub.querySelector('.sub-scroll').scrollTop = 0;
  mainMenu.classList.add('drilled');
  fitMenuHeight();
}
function closeSub() { mainMenu.classList.remove('drilled'); fitMenuHeight(); }
mainMenu.addEventListener('click', (e) => {
  const subBtn = e.target.closest('[data-sub]');
  if (subBtn) { e.stopPropagation(); openSub(subBtn.dataset.sub); return; }
  if (e.target.closest('.menu-back')) { e.stopPropagation(); closeSub(); }
});

// File menu
const menu = document.getElementById('file-menu');
menu.addEventListener('click', async (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (!action) return;
  closeMenus();
  try {
    switch (action) {
      case 'new': if (files.newFile(DEFAULT_SCRIPT)) run(); break;
      case 'open': await files.open(); break;
      case 'save': await files.save(); break;
      case 'save-as': await files.saveAs(); break;
      case 'export-stl': {
        const stlName = files.name.replace(/\.[^.]*$/, '') + '.stl';
        const n = exportSTL(viewer.modelGroup, stlName);
        logLine(`Exported ${n} triangles to ${stlName}`);
        break;
      }
      case 'export-3mf': {
        const name3mf = files.name.replace(/\.[^.]*$/, '') + '.3mf';
        const n = export3MF(viewer.modelGroup, name3mf);
        logLine(`Exported ${n} part${n === 1 ? '' : 's'} with names and colors to ${name3mf}`);
        break;
      }
    }
  } catch (err) { reportErr(err); }
});

// Draggable divider
const divider = document.getElementById('divider');
const editorPane = document.getElementById('editor-pane');
divider.addEventListener('pointerdown', (e) => {
  divider.setPointerCapture(e.pointerId);
  const move = (ev) => { editorPane.style.width = `${Math.max(200, ev.clientX)}px`; };
  const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
});

run();
