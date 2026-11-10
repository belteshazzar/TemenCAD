import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { keymap } from '@codemirror/view';
import { acceptCompletion } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { apiCompletions } from './completions.js';
import { lintGutter } from '@codemirror/lint';
import { Viewer } from './viewer.js';
import { exportSTL, export3MF, exportFile, downloadBlob } from './export.js';
import { FileManager } from './files.js';
import { PLATES, fitProblems } from './plate.js';
import { Builder } from './build.js';
import { PartsPanel } from './parts-panel.js';
import { initMenus } from './menu.js';
import { initChat } from './chat.js';
import { DEFAULT_SCRIPT } from './default-script.js';
import { Project, ENTRY } from './project.js';
import { Tabs } from './tabs.js';
import { whereText } from './trace.js';
import { initCatalog } from './catalog.js';

const STORAGE_KEY = 'temencad.project';
const LEGACY_SCRIPT_KEY = 'temencad.script';
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

// ---- Project, editor tabs and file manager ----
function loadProject() {
  try {
    const saved = store.get(STORAGE_KEY);
    if (saved) return Project.fromJSON(JSON.parse(saved));
    const legacy = store.get(LEGACY_SCRIPT_KEY); // single-script storage from before projects
    if (legacy) return Project.fromScript(legacy);
  } catch {}
  return Project.fromScript(DEFAULT_SCRIPT);
}
/** A script in the URL (#script=…, as the product site's "Open in TemenCAD" links use) opens as a new, unsaved project. */
function projectFromHash() {
  const m = location.hash.match(/^#script=(.+)$/);
  if (!m) return null;
  try { history.replaceState(null, '', location.pathname + location.search); return Project.fromScript(decodeURIComponent(m[1])); } catch { return null; }
}
let project = projectFromHash() ?? loadProject();
const persist = () => store.set(STORAGE_KEY, JSON.stringify(project.toJSON()));

/** Every text file gets its own editor state so undo history and diagnostics stay per file. */
const makeState = (doc) => EditorState.create({
  doc,
  extensions: [
    basicSetup,
    lintGutter(),
    javascript(),
    javascriptLanguage.data.of({ autocomplete: apiCompletions }),
    keymap.of([
      { key: 'Tab', run: acceptCompletion }, // Tab accepts a suggestion (and then steps through snippet fields); otherwise it indents
      indentWithTab,
      { key: 'Mod-Enter', run: () => (run(), true) },
      { key: 'Mod-o', run: () => (files.open().catch(reportErr), true) },
      { key: 'Mod-s', run: () => (files.save().catch(reportErr), true) },
      { key: 'Shift-Mod-s', run: () => (files.saveAs().catch(reportErr), true) },
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && tabs.active) {
        project.set(tabs.active, u.state.doc.toString());
        projectChanged();
      }
    }),
  ],
});
const editor = new EditorView({ state: makeState(''), parent: document.getElementById('editor') });

const chatEl = document.getElementById('chat');
const tabs = new Tabs(document.getElementById('tabs'), {
  editor,
  makeState,
  project,
  assetEl: document.getElementById('asset-info'),
  fileInput: document.getElementById('add-file-input'),
  onChange: () => projectChanged(),
  panels: [{ id: 'assistant', label: 'Assistant', el: chatEl, onShow: () => chat?.focus() }],
  onCatalog: () => catalog.openBrowser(),
});
/** The project changed: store it, update the unsaved marker and (unless told not to) schedule an auto-run. */
function projectChanged({ run = true } = {}) {
  persist();
  files?.markChanged();
  if (run) scheduleRun();
}

const files = new FileManager({
  getProject: () => project,
  setProject: (p) => { project = p; tabs.setProject(p); persist(); clearTimeout(timer); run(); },
  fileInput: document.getElementById('file-input'),
  onChange: (f) => { document.title = `${f.dirty ? '• ' : ''}${f.name} — TemenCAD`; },
});
window.addEventListener('beforeunload', (e) => { if (files.dirty) e.preventDefault(); });

// ---- Diagnostics (editor squiggles, per file) ----
const traceOf = (msg) => (msg.trace?.length ? msg.trace : msg.line ? [{ file: msg.file ?? ENTRY, line: msg.line }] : []);
const where = (msg) => whereText(traceOf(msg));
/** Mark the innermost location with the message and each caller with a pointer to it. */
function markTrace(msg, severity, message) {
  const t = traceOf(msg);
  if (!t.length) return;
  tabs.addDiagnostic(t[0].file, t[0].line, message, severity);
  t.slice(1).forEach((l, i) => tabs.addDiagnostic(l.file, l.line, `Called from here → ${severity} at ${t[i].file} line ${t[i].line}: ${message}`, 'info'));
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
let lastMeshes = null;
let lastAnnotations = [];
let runDiagnostics = [];    // warnings collected during the current build
let framedOnce = false;

const builder = new Builder({
  getFiles: () => project.toFiles(),
  onStart: () => {
    consoleEl.textContent = '';
    tabs.clearDiagnostics();
    runDiagnostics = [];
    setBusy(true);
  },
  onLog: (text) => logLine(text),
  onWarn: (msg) => {
    logLine(`Warning${where(msg)}: ${msg.text}`, 'warn');
    markTrace(msg, 'warning', msg.text);
    runDiagnostics.push({ severity: 'warning', file: msg.file ?? ENTRY, line: msg.line, calledFrom: msg.trace?.slice(1), message: msg.text });
  },
  onCancel: () => { setBusy(false); logLine('Build cancelled.', 'err'); },
  onFinish: (msg) => {
    setBusy(false);
    if (msg.type !== 'result') {
      logLine(`Error${where(msg)}: ${msg.message}`, 'err');
      markTrace(msg, 'error', msg.message.split('\n')[0]);
      lastReport = { ok: false, error: { file: msg.file ?? ENTRY, line: msg.line, calledFrom: msg.trace?.slice(1), message: msg.message }, warnings: runDiagnostics };
      return lastReport;
    }
    // Catch anything Three.js complains about while building the display meshes.
    const origWarn = console.warn;
    console.warn = (...a) => { logLine(`Warning: ${a.join(' ')}`, 'warn'); origWarn(...a); };
    try { viewer.setMeshes(msg.meshes); } finally { console.warn = origWarn; }
    lastMeshes = msg.meshes; lastAnnotations = msg.annotations ?? [];
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
  if (action === 'wireframe') toggleWireframe();
  if (action === 'autorun') toggleAutorun();
  menus.closeMenus();
});
function toggleWireframe() {
  wireframe = !wireframe;
  viewer.setWireframe(wireframe);
  viewMenu.querySelector('[data-action="wireframe"] .check').textContent = wireframe ? '✓' : '';
}
function toggleAutorun() {
  autorun = !autorun;
  store.set('temencad.autorun', autorun ? '1' : '0');
  reflectAutorun();
  if (autorun) scheduleRun(0);
}

// ---- Assistant (first tab of the editor pane) ----
const chat = initChat({
  root: chatEl,
  host: {
    listFiles: () => project.names(),
    getScript: (file = ENTRY) => tabs.text(file),
    // the assistant builds explicitly via run_model, so its edits store the project without an auto-run
    setScript: (file, text) => { tabs.setText(file, text); clearTimeout(timer); projectChanged({ run: false }); },
    removeFile: (file) => { tabs.removeFile(file); clearTimeout(timer); projectChanged({ run: false }); },
    renameFile: (file, to) => { const n = tabs.renameFile(file, to); clearTimeout(timer); projectChanged({ run: false }); return n; },
    runAndWait: () => builder.runAndWait(),
    lastReport: () => lastReport,
    renderViews: (opts) => renderSheet(opts),
    screenshot: async (view) => {
      if (view && view !== 'iso') viewer.setView(view); else viewer.resetView();
      await new Promise((r) => requestAnimationFrame(r));
      return viewer.snapshot(1024);
    },
    ...appActions(),
  },
});

/**
 * The menus' actions for the assistant (agent.js appTools). Each returns a plain object for the
 * model to read. Actions that need a click (file pickers) put a button card in the chat and wait;
 * anything that would switch the editor to a file tab switches back to the chat afterwards.
 */
function appActions() {
  const stayInChat = () => tabs.select('assistant');
  const baseName = () => files.name.replace(/\.[^.]*$/, '');
  const projectInfo = () => ({ file: files.name, unsaved: files.dirty, files: project.names() });
  /** Unsaved changes: ask in the chat. Resolves true to go ahead. */
  async function okToDiscard() {
    if (!files.dirty) return true;
    const r = await chat.ask(`${files.name} has unsaved changes. Discard them?`, [
      { label: 'Discard changes', value: 'discard', primary: true },
      { label: 'Keep working', value: 'keep' },
    ]);
    return r.value === 'discard';
  }
  return {
    appState: () => ({
      ...projectInfo(), files: undefined,
      plate: plate ? { id: plate.id, size: [plate.w, plate.d, plate.h] } : null,
      autorun, wireframe,
      parts: parts.describe(),
    }),
    newProject: async (script) => {
      if (!(await okToDiscard())) return { done: false, reason: 'the user kept the unsaved changes' };
      files.newProject(typeof script === 'string' ? script : DEFAULT_SCRIPT, { force: true });
      stayInChat();
      return { done: true, ...projectInfo(), build: await builder.runAndWait() };
    },
    openProject: async () => {
      if (!(await okToDiscard())) return { done: false, reason: 'the user kept the unsaved changes' };
      const r = await chat.ask('Choose a TemenCAD project (.temen) or a script (.js) to open.', [
        { label: 'Open…', value: 'open', primary: true, run: () => files.open({ force: true }) }, // unsaved changes were asked about above
        { label: 'Cancel', value: 'cancel' },
      ]);
      if (r.error) return { done: false, error: r.error };
      if (r.value !== 'open' || !r.result) return { done: false, reason: 'cancelled' };
      stayInChat();
      return { done: true, ...projectInfo(), build: await builder.runAndWait() };
    },
    saveProject: async (asNew) => {
      if (!asNew && files.canSaveInPlace) {
        await files.save();
        return { done: true, saved_in_place: true, ...projectInfo() };
      }
      const r = await chat.ask(asNew || files.name.startsWith('untitled') ? 'Choose where to save the project.' : `Save ${files.name}: choose where to save it.`, [
        { label: 'Save as…', value: 'save', primary: true, run: () => files.saveAs() },
        { label: 'Cancel', value: 'cancel' },
      ]);
      if (r.error) return { done: false, error: r.error };
      if (r.value !== 'save' || !r.result) return { done: false, reason: 'cancelled' };
      return { done: true, ...projectInfo() };
    },
    exportModel: async ({ format, parts: names, filename }) => {
      if (!lastMeshes?.length) throw new Error('Nothing built yet; call run_model first');
      let only;
      if (names?.length) {
        const all = lastMeshes.map((m) => m.name);
        const missing = names.filter((n) => !all.includes(n));
        if (missing.length) throw new Error(`no part named ${missing.map((n) => `"${n}"`).join(', ')}; parts are ${all.map((n) => `"${n}"`).join(', ')}`);
        only = names.map((n) => all.indexOf(n));
      }
      const stem = (filename || (names?.length === 1 ? names[0] : baseName())).replace(/\.(stl|3mf)$/i, '').replace(/[^\w.-]+/g, '_');
      const f = exportFile(viewer.modelGroup, format, `${stem}.${format}`, { only });
      downloadBlob(f.blob, f.filename);
      const what = format === 'stl' ? `${f.count} triangles` : `${f.count} part${f.count === 1 ? '' : 's'}`;
      chat.offerDownload(f.blob, f.filename);
      logLine(`Exported ${what} to ${f.filename}`);
      return { done: true, file: f.filename, bytes: f.blob.size, [format === 'stl' ? 'triangles' : 'parts']: f.count, downloaded: true, link_in_chat: true };
    },
    saveRender: async ({ views, section }) => {
      const png = await renderSheet({ views, section, width: 1280, height: 960, labels: true });
      const name = `${baseName()}-views.png`;
      chat.offerDownload(new Blob([png], { type: 'image/png' }), name);
      return name;
    },
    shareProject: (prefill) => {
      catalog.openShare(prefill);
      return { done: true, note: 'The Share form is open with your values; the user reviews it and presses Share (or Cancel).' };
    },
    setView: ({ view, wireframe: wf }) => {
      if (view === 'reset') viewer.resetView();
      else if (view) viewer.setView(view);
      if (typeof wf === 'boolean' && wf !== wireframe) toggleWireframe();
      return { view: view ?? 'unchanged', wireframe };
    },
    setPlate: async (id, size) => {
      if (id === 'custom') {
        if (!Array.isArray(size) || size.length !== 3 || !size.every((n) => Number.isFinite(n) && n > 0)) throw new Error('plate custom needs size: [width, depth, height] in mm');
        store.set('temencad.plate.custom', JSON.stringify(size));
      }
      if (!PLATES.some((p) => p[0] === id)) throw new Error(`unknown plate "${id}"`);
      await applyPlate(id);
      const fit = checkFit();
      return { plate: plate ? { id: plate.id, size: [plate.w, plate.d, plate.h] } : null, fits: fit.fits, problems: fit.problems };
    },
    setPartDisplay: (opts) => ({ parts: parts.apply(opts), fits_plate: plate ? checkFit().fits : undefined }),
    setAutorun: (on) => { if (!!on !== autorun) toggleAutorun(); return { autorun }; },
    searchCatalog: async (query) => {
      const found = await catalog.search(query);
      return { count: found.length, packages: found.slice(0, 30) };
    },
    addFromCatalog: async (name) => {
      const m = await catalog.add(name);
      stayInChat();
      return { done: true, name: m.name, version: m.version, import_line: m.importLine, exports: m.exports, note: 'The import line was added to main.js; use the exports there, then run_model.' };
    },
    addFiles: async (reason) => {
      const r = await chat.ask(reason || 'Add files to the project.', [
        { label: 'Add files…', value: 'add', primary: true, run: () => tabs.pickFiles() },
        { label: 'Cancel', value: 'cancel' },
      ]);
      stayInChat();
      if (r.error) return { done: false, error: r.error };
      if (r.value !== 'add' || !r.result?.length) return { done: false, reason: 'cancelled or no files chosen' };
      return { done: true, added: r.result, files: project.names() };
    },
  };
}
document.querySelector('#menu-root > .menu-items').addEventListener('click', (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (action === 'assistant-settings') { chat.openSettings(); menus.closeMenus(); }
});
tabs.select('assistant');

// ---- Catalogue: add shared shapes, share this one ----
const catalog = initCatalog({
  getProject: () => project,
  tabs,
  onChange: () => projectChanged(),
  snapshot: () => { viewer.resetView(); return viewer.snapshot(480); },
  log: logLine,
});

// A catalogue "Add in TemenCAD" link (#add=<name>) adds that package to the open project.
{
  const m = location.hash.match(/^#add=(.+)$/);
  if (m) { history.replaceState(null, '', location.pathname + location.search); catalog.addByName(decodeURIComponent(m[1])); }
}

// ---- File menu ----
document.getElementById('file-menu').addEventListener('click', async (e) => {
  const action = e.target.closest('button')?.dataset.action;
  if (!action) return;
  menus.closeMenus();
  const base = files.name.replace(/\.[^.]*$/, '');
  try {
    switch (action) {
      case 'new': files.newProject(DEFAULT_SCRIPT); break;
      case 'open': await files.open(); break;
      case 'save': await files.save(); break;
      case 'save-as': await files.saveAs(); break;
      case 'export-stl': {
        const n = exportSTL(viewer.modelGroup, `${base}.stl`);
        logLine(`Exported ${n} triangles to ${base}.stl`);
        break;
      }
      case 'share': catalog.openShare(); break;
      case 'export-3mf': {
        const n = export3MF(viewer.modelGroup, `${base}.3mf`);
        logLine(`Exported ${n} part${n === 1 ? '' : 's'} with names and colors to ${base}.3mf`);
        break;
      }
      case 'render-sheet': {
        const opts = await askRenderOptions();
        if (!opts) break;
        const png = await renderSheet(opts);
        const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
        const a = document.createElement('a'); a.href = url; a.download = `${base}-views.png`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        logLine(`Rendered ${opts.views.join(', ')} to ${base}-views.png`);
        break;
      }
    }
  } catch (err) { reportErr(err); }
});

/** Render the last build's meshes in the worker: { views, section, width, height, labels }. */
async function renderSheet(opts) {
  if (!lastMeshes?.length) throw new Error('Build the model first');
  return builder.render(lastMeshes, { ...opts, annotations: lastAnnotations });
}

/** The Render views dialog; resolves with options or null. */
function askRenderOptions() {
  const dlg = document.getElementById('render-dialog'), form = document.getElementById('render-form'), err = document.getElementById('render-error');
  err.textContent = '';
  return new Promise((resolve) => {
    let result = null;
    const onSubmit = (e) => {
      const views = [...form.querySelectorAll('input[name=view]:checked')].map((i) => i.value);
      if (!views.length) { e.preventDefault(); err.textContent = 'Pick at least one view.'; return; }
      const axis = form.axis.value, value = parseFloat(form.value.value);
      if (axis && !Number.isFinite(value)) { e.preventDefault(); err.textContent = 'Enter the section position in mm.'; return; }
      const [width, height] = form.size.value.split('x').map(Number);
      result = { views, width, height, labels: form.labels.checked, section: axis ? { axis, value } : null };
    };
    const onClose = () => { form.removeEventListener('submit', onSubmit); dlg.removeEventListener('close', onClose); resolve(result); };
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
    dlg.showModal();
  });
}

// ---- Draggable divider: viewer | editor ----
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
makeDivider(document.getElementById('divider'), (x) => { editorPane.style.width = `${Math.max(200, window.innerWidth - x)}px`; });

run();
