import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { keymap } from '@codemirror/view';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { Viewer } from './viewer.js';
import { exportSTL, export3MF } from './export.js';
import { FileManager } from './files.js';
import { VariablesPanel } from './variables.js';
import { PLATES, fitProblems } from './plate.js';
import { Builder } from './build.js';
import { PartsPanel } from './parts-panel.js';
import { initMenus } from './menu.js';
import { initChat } from './chat.js';
import { DEFAULT_SCRIPT } from './default-script.js';

const STORAGE_KEY = 'temencad.script';
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

const viewer = new Viewer(document.getElementById('viewport'));
const consoleEl = document.getElementById('console');
const busyEl = document.getElementById('busy');
const busyTimeEl = document.getElementById('busy-time');
let autorun = store.get('temencad.autorun') !== '0';

function logLine(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}
const reportErr = (err) => logLine(String(err.message ?? err), 'err');

let timer = null;
function scheduleRun(delay = 400) {
  if (!autorun) return;
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}
function run() { builder.run(); }

// ---- Editor, file manager, variables ----
const editor = new EditorView({
  doc: store.get(STORAGE_KEY) ?? DEFAULT_SCRIPT,
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
        store.set(STORAGE_KEY, u.state.doc.toString());
        files?.markChanged();
        variables?.refresh();
        scheduleRun();
      }
    }),
  ],
  parent: document.getElementById('editor'),
});
const getScript = () => editor.state.doc.toString();
const setScript = (text) => {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  clearTimeout(timer);
};

const files = new FileManager({
  getText: getScript,
  setText: (text) => { setScript(text); run(); },
  fileInput: document.getElementById('file-input'),
  onChange: (f) => { document.title = `${f.dirty ? '• ' : ''}${f.name} — TemenCAD`; },
});
// Sliders rewrite the source; rebuild quickly since the kernel is fast.
const variables = new VariablesPanel(document.getElementById('variables'), editor, () => scheduleRun(60));
variables.refresh();
window.addEventListener('beforeunload', (e) => { if (files.dirty) e.preventDefault(); });

// ---- Diagnostics (editor squiggles) ----
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
const traceOf = (msg) => (msg.trace?.length ? msg.trace : msg.line ? [msg.line] : []);
/** " (line 6, called from line 32)" */
function where(msg) {
  const t = traceOf(msg);
  if (!t.length) return '';
  return ` (line ${t[0]}${t.length > 1 ? `, called from line ${t.slice(1).join(' ← ')}` : ''})`;
}
/** Mark the innermost line with the message and each caller with a pointer to it. */
function markTrace(msg, severity, message) {
  const t = traceOf(msg);
  if (!t.length) return;
  addDiagnostic(t[0], message, severity);
  t.slice(1).forEach((l, i) => addDiagnostic(l, `Called from here → ${severity} at line ${t[i]}: ${message}`, 'info'));
}

// ---- Build pipeline ----
let timerHandle = null;
function setBusy(on) {
  busyEl.classList.toggle('show', on);
  clearInterval(timerHandle);
  if (on) {
    const t0 = performance.now();
    busyTimeEl.textContent = '';
    timerHandle = setInterval(() => { busyTimeEl.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
  }
}

let lastReport = null;      // structured result of the last build, for the assistant
let runDiagnostics = [];    // warnings collected during the current build
let framedOnce = false;

const builder = new Builder({
  getCode: getScript,
  onStart: () => {
    consoleEl.textContent = '';
    clearDiagnostics();
    runDiagnostics = [];
    setBusy(true);
  },
  onLog: (text) => logLine(text),
  onWarn: (msg) => {
    logLine(`Warning${where(msg)}: ${msg.text}`, 'warn');
    markTrace(msg, 'warning', msg.text);
    runDiagnostics.push({ severity: 'warning', line: msg.line, calledFrom: msg.trace?.slice(1), message: msg.text });
  },
  onCancel: () => { setBusy(false); logLine('Build cancelled.', 'err'); },
  onFinish: (msg) => {
    setBusy(false);
    if (msg.type !== 'result') {
      logLine(`Error${where(msg)}: ${msg.message}`, 'err');
      markTrace(msg, 'error', msg.message.split('\n')[0]);
      lastReport = { ok: false, error: { line: msg.line, calledFrom: msg.trace?.slice(1), message: msg.message }, warnings: runDiagnostics };
      return lastReport;
    }
    // Catch anything Three.js complains about while building the display meshes.
    const origWarn = console.warn;
    console.warn = (...a) => { logLine(`Warning: ${a.join(' ')}`, 'warn'); origWarn(...a); };
    try { viewer.setMeshes(msg.meshes); } finally { console.warn = origWarn; }
    parts.setParts(msg.meshes.map((m) => ({ name: m.name, color: m.color, ghost: m.ghost, hidden: m.hidden, volume: m.volume, tris: m.indices.length / 3 })));
    if (!framedOnce) { framedOnce = true; if (!plate) viewer.resetView(); }
    const n = msg.meshes.length;
    const fit = checkFit();
    logLine(`Built ${n} part${n === 1 ? '' : 's'}, ${msg.tris} triangles, ${msg.ms.toFixed(0)} ms${fit.text}`, 'info');
    const r3 = (v) => +v.toFixed(2);
    lastReport = {
      ok: true,
      parts: msg.meshes.map((m, i) => {
        const b = viewer.partBounds(i);
        return { name: m.name, color: m.color, ghost: m.ghost, hidden: m.hidden, triangles: m.indices.length / 3, volume_mm3: r3(m.volume),
          min: b ? b.min.toArray().map(r3) : null, max: b ? b.max.toArray().map(r3) : null };
      }),
      plate: plate ? { size: [plate.w, plate.d, plate.h], fits: fit.fits } : null,
      warnings: runDiagnostics,
      build_ms: Math.round(msg.ms),
    };
    return lastReport;
  },
});

// ---- Menus, parts panel ----
const menus = initMenus();
const parts = new PartsPanel(document.getElementById('parts-menu'), {
  viewer,
  onChange: () => checkFit(),
  onLayout: () => menus.refit(),
  onExport: (p, i) => {
    try {
      const n = exportSTL(viewer.modelGroup, `${p.name.replace(/[^\w.-]+/g, '_')}.stl`, { only: [i] });
      logLine(`Exported ${n} triangles: ${p.name}`);
    } catch (err) { reportErr(err); }
  },
});
parts.render();

// ---- Build plate presets and fit check ----
const plateItems = document.querySelector('#plate-menu .plate-items');
let plate = null;
const loadCustom = () => { try { return JSON.parse(store.get('temencad.plate.custom')); } catch { return null; } };

function renderPlateMenu() {
  plateItems.textContent = '';
  document.querySelector('[data-sub="plate"] .check').textContent = plate ? '✓' : '';
  const custom = loadCustom();
  PLATES.forEach(([id, label, dims], i) => {
    if ((id === 'custom' || id === 'none') && i > 0) plateItems.appendChild(document.createElement('hr'));
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
      store.set('temencad.plate.custom', JSON.stringify(dims));
    }
  }
  plate = dims ? { id, w: dims[0], d: dims[1], h: dims[2] } : null;
  store.set('temencad.plate', id);
  renderPlateMenu();
  viewer.setPlate(plate);
  checkFit();
  viewer.resetView();
}

/**
 * Compare visible parts with the plate; colour the plate outline and log problems.
 * Returns { fits, problems, text } where text is a status-line suffix ('' without a plate).
 */
function checkFit() {
  if (!plate) return { fits: true, problems: [], text: '' };
  const b = viewer.visibleBounds();
  const problems = b ? fitProblems(b, plate) : [];
  const fits = problems.length === 0;
  viewer.setPlateFit(fits);
  if (!fits) logLine(`Does not fit ${plate.w}×${plate.d}×${plate.h} plate: ${problems.join(', ')}.`, 'warn');
  return { fits, problems, text: fits ? ', fits the plate' : ', does not fit the plate' };
}
applyPlate(store.get('temencad.plate') || 'none');

// ---- Toolbar and View menu ----
const runButton = document.getElementById('run');
runButton.addEventListener('click', run);
document.getElementById('cancel').addEventListener('click', () => builder.cancel());
// Show platform-appropriate shortcut hints (⌘ on Mac, Ctrl elsewhere)
if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
  for (const k of document.querySelectorAll('.menu-items kbd')) k.textContent = k.textContent.replace('⇧⌘', 'Ctrl+Shift+').replace('⌘', 'Ctrl+').replace('↩', 'Enter');
}

const viewMenu = document.getElementById('view-menu');
const autorunItem = viewMenu.querySelector('[data-action="autorun"]');
const reflectAutorun = () => {
  autorunItem.querySelector('.check').textContent = autorun ? '✓' : '';
  runButton.hidden = autorun; // manual Run only matters when auto-run is off
};
reflectAutorun();
let wireframe = false;
viewMenu.addEventListener('click', (e) => {
  const view = e.target.closest('[data-view]')?.dataset.view;
  if (view) { viewer.setView(view); menus.closeMenus(); return; }
  const action = e.target.closest('button')?.dataset.action;
  if (!action) return;
  if (action === 'run') run();
  if (action === 'reset-view') viewer.resetView();
  if (action === 'wireframe') {
    wireframe = !wireframe;
    viewer.setWireframe(wireframe);
    viewMenu.querySelector('[data-action="wireframe"] .check').textContent = wireframe ? '✓' : '';
  }
  if (action === 'autorun') {
    autorun = !autorun;
    store.set('temencad.autorun', autorun ? '1' : '0');
    reflectAutorun();
    if (autorun) scheduleRun(0);
  }
  menus.closeMenus();
});

// ---- Assistant ----
const chatEl = document.getElementById('chat');
const divider2 = document.getElementById('divider2');
const chat = initChat({
  root: chatEl,
  divider: divider2,
  menuItem: document.querySelector('[data-action="assistant"]'),
  host: {
    getScript,
    setScript, // the assistant builds explicitly via run_model, so no auto-run
    runAndWait: () => builder.runAndWait(),
    lastReport: () => lastReport,
    screenshot: async (view) => {
      if (view && view !== 'iso') viewer.setView(view); else viewer.resetView();
      await new Promise((r) => requestAnimationFrame(r));
      return viewer.snapshot(1024);
    },
  },
});
document.querySelector('#menu-root > .menu-items').addEventListener('click', (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (action === 'assistant') { chat.toggle(); menus.closeMenus(); }
  if (action === 'assistant-settings') { chat.openSettings(); menus.closeMenus(); }
});

// ---- File menu ----
document.getElementById('file-menu').addEventListener('click', async (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (!action) return;
  menus.closeMenus();
  const base = files.name.replace(/\.[^.]*$/, '');
  try {
    switch (action) {
      case 'new': if (files.newFile(DEFAULT_SCRIPT)) run(); break;
      case 'open': await files.open(); break;
      case 'save': await files.save(); break;
      case 'save-as': await files.saveAs(); break;
      case 'export-stl': {
        const n = exportSTL(viewer.modelGroup, `${base}.stl`);
        logLine(`Exported ${n} triangles to ${base}.stl`);
        break;
      }
      case 'export-3mf': {
        const n = export3MF(viewer.modelGroup, `${base}.3mf`);
        logLine(`Exported ${n} part${n === 1 ? '' : 's'} with names and colors to ${base}.3mf`);
        break;
      }
    }
  } catch (err) { reportErr(err); }
});

// ---- Draggable dividers: editor | viewer | chat ----
function makeDivider(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev.clientX);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}
const editorPane = document.getElementById('editor-pane');
makeDivider(document.getElementById('divider'), (x) => { editorPane.style.width = `${Math.max(200, x)}px`; });
makeDivider(divider2, (x) => { chatEl.style.width = `${Math.max(260, window.innerWidth - x)}px`; });

run();
