/**
 * File tabs above the editor. Each text file keeps its own CodeMirror state (undo history,
 * diagnostics); binary files (fonts, meshes) show an info panel with the import line to use.
 * The "+" menu adds, renames and removes files.
 */
import { setDiagnostics } from '@codemirror/lint';
import { ENTRY, ACCEPTED_EXT, isTextFile, isFontFile, isMeshFile, extOf, normalizePath } from './project.js';

/**
 * Name / confirm dialog (same <dialog> styling as the custom plate dialog). Resolves to the entered
 * name, or true for a confirmation (`input: false`), or null when cancelled. `validate(value)` returns an
 * error string to show inline and keep the dialog open, or null to accept.
 */
export function askName({ title, message = '', value = '', ok = 'OK', input = true, validate = () => null }) {
  const dialog = document.getElementById('name-dialog');
  const form = document.getElementById('name-form');
  const field = form.querySelector('.name-field');
  const error = form.querySelector('.dialog-error');
  form.querySelector('.name-title').textContent = title;
  form.querySelector('.name-message').textContent = message;
  form.querySelector('.name-ok').textContent = ok;
  field.hidden = !input;
  form.elements.name.value = value;
  error.hidden = true;
  return new Promise((resolve) => {
    let accepted = false; // set by a valid submit; Cancel, Escape and a backdrop close leave it false
    const onSubmit = (e) => {
      const err = input ? validate(form.elements.name.value) : null;
      if (err) { e.preventDefault(); error.textContent = err; error.hidden = false; form.elements.name.focus(); return; }
      accepted = true;
    };
    const done = () => {
      dialog.removeEventListener('close', done);
      form.removeEventListener('submit', onSubmit);
      if (!accepted) return resolve(null);
      resolve(input ? form.elements.name.value.trim() : true);
    };
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', done);
    form.querySelector('[data-cancel]').onclick = () => dialog.close('cancel');
    dialog.showModal();
    if (input) { const el = form.elements.name; el.focus(); const dot = el.value.lastIndexOf('.'); el.setSelectionRange(0, dot > 0 ? dot : el.value.length); }
  });
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export class Tabs {
  /**
   * @param {HTMLElement} root  the #tabs element (.tab-list, .tab-add, .tab-menu)
   * @param {object} o  editor (EditorView), makeState(doc) -> EditorState, project, assetEl (info panel),
   *                    fileInput (multiple), onChange(file) after any project edit, onSelect(file)
   */
  constructor(root, o) {
    this.root = root;
    this.o = o;
    this.list = root.querySelector('.tab-list');
    this.menu = root.querySelector('.tab-menu-wrap .tab-menu');
    this.fileMenu = root.querySelector('.file-menu');
    this.states = new Map();
    this.diags = new Map();
    this.active = null;
    const closeMenus = () => { this.menu.classList.remove('open'); this.fileMenu.classList.remove('open'); this.list.querySelector('.tab-caret.open')?.classList.remove('open'); };
    this.closeMenus = closeMenus;
    root.querySelector('.tab-add').addEventListener('click', (e) => { e.stopPropagation(); const open = this.menu.classList.contains('open'); closeMenus(); if (!open) this.menu.classList.add('open'); });
    document.addEventListener('click', closeMenus);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
    this.menu.addEventListener('click', (e) => {
      const action = e.target.closest('button')?.dataset.action;
      if (!action) return;
      closeMenus();
      if (action === 'new') this.newScript();
      if (action === 'add') { o.fileInput.value = ''; o.fileInput.click(); }
    });
    this.fileMenu.addEventListener('click', (e) => {
      const action = e.target.closest('button')?.dataset.action;
      if (!action) return;
      closeMenus();
      if (action === 'rename') this.rename();
      if (action === 'remove') this.remove();
    });
    o.fileInput.addEventListener('change', () => this.addFiles([...o.fileInput.files]));
  }

  /** Open the rename/remove menu under the active tab's caret. */
  openFileMenu(caret) {
    const open = this.fileMenu.classList.contains('open');
    this.closeMenus();
    if (open) return;
    this.fileMenu.style.left = `${caret.getBoundingClientRect().left - this.root.getBoundingClientRect().left - 6}px`;
    this.fileMenu.classList.add('open');
    caret.classList.add('open');
  }

  get project() { return this.o.project; }

  /** Replace the whole project (open / new): drop editor states and show the entry. */
  setProject(project) {
    this.o.project = project;
    this.states.clear();
    this.diags.clear();
    this.active = null;
    this.select(ENTRY);
  }

  text(file) { return file === this.active ? this.o.editor.state.doc.toString() : this.project.get(file); }

  /** Write text into a file from outside the editor (file open, assistant edits). */
  setText(file, text) {
    this.project.set(file, text);
    if (file === this.active) this.o.editor.dispatch({ changes: { from: 0, to: this.o.editor.state.doc.length, insert: text } });
    else this.states.delete(file);
    if (!this.project.has(this.active)) this.select(ENTRY); else this.render();
  }

  /** Remove / rename from outside the UI (assistant). Both return normally or throw a readable error. */
  removeFile(file) {
    if (!this.project.has(file)) throw new Error(`no file named ${file}`);
    this.project.remove(file);
    this.states.delete(file);
    this.diags.delete(file);
    if (this.active === file) { this.active = null; this.select(ENTRY); } else this.render();
  }
  renameFile(file, to) {
    if (!this.project.has(file)) throw new Error(`no file named ${file}`);
    const n = this.project.rename(file, to);
    const state = this.states.get(file); this.states.delete(file); if (state) this.states.set(n, state);
    const d = this.diags.get(file); this.diags.delete(file); if (d) this.diags.set(n, d);
    if (this.active === file) this.active = n;
    this.render();
    return n;
  }

  select(file) {
    if (!this.project.has(file)) return;
    if (this.active && isTextFile(this.active)) this.states.set(this.active, this.o.editor.state);
    this.active = file;
    if (isTextFile(file)) {
      let state = this.states.get(file);
      if (!state) { state = this.o.makeState(this.project.get(file)); this.states.set(file, state); }
      this.o.editor.setState(state);
      this.o.editor.dispatch(setDiagnostics(this.o.editor.state, this.diags.get(file) ?? []));
      this.o.editor.dom.parentElement.hidden = false;
      this.o.assetEl.hidden = true;
    } else {
      this.o.editor.dom.parentElement.hidden = true;
      this.o.assetEl.hidden = false;
      this.renderAsset(file);
    }
    this.render();
    this.o.onSelect?.(file);
  }

  renderAsset(file) {
    const kind = isFontFile(file) ? 'Font' : isMeshFile(file) ? 'Mesh (STL)' : 'File';
    const ident = file.replace(/\.[^.]*$/, '').replace(/[^\w$]+/g, '_').replace(/^(\d)/, '_$1');
    const usage = isFontFile(file) ? `import ${ident} from './${file}';\ntext3d('Hi', { font: ${ident} })`
      : isMeshFile(file) ? `import ${ident} from './${file}';\nreturn ${ident}.onPlate();`
      : `import ${ident} from './${file}';`;
    this.o.assetEl.innerHTML = '';
    const h = document.createElement('div'); h.className = 'asset-kind'; h.textContent = `${kind} · ${fmtSize(this.project.get(file).byteLength)}`;
    const p = document.createElement('p'); p.textContent = 'Binary files cannot be edited here. Import it from a script:';
    const pre = document.createElement('pre'); pre.textContent = usage;
    this.o.assetEl.append(h, p, pre);
  }

  render() {
    this.list.textContent = '';
    for (const name of this.project.names()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tab${name === this.active ? ' active' : ''}${isTextFile(name) ? '' : ' asset'}${name === ENTRY ? '' : ' has-menu'}`;
      b.textContent = name;
      b.title = name === ENTRY ? 'Entry script' : name;
      b.addEventListener('click', () => this.select(name));
      if (name !== ENTRY) {
        const caret = document.createElement('span');
        caret.className = 'tab-caret'; caret.textContent = '▾'; caret.title = 'Rename or remove';
        caret.addEventListener('click', (e) => { e.stopPropagation(); if (name !== this.active) this.select(name); this.openFileMenu(e.currentTarget); });
        b.appendChild(caret);
      }
      this.list.appendChild(b);
    }
  }

  // ---- Diagnostics per file ----
  clearDiagnostics() {
    this.diags.clear();
    if (isTextFile(this.active)) this.o.editor.dispatch(setDiagnostics(this.o.editor.state, []));
  }
  /** Mark a line in `file` (squiggle + gutter icon + hover message), whether or not it is the visible tab. */
  addDiagnostic(file, line, message, severity) {
    if (!line || !this.project.has(file) || !isTextFile(file)) return;
    const state = file === this.active ? this.o.editor.state : (this.states.get(file) ?? this.o.makeState(this.project.get(file)));
    const doc = state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    const from = l.from + (l.text.match(/^\s*/)?.[0].length ?? 0);
    const list = this.diags.get(file) ?? [];
    list.push({ from, to: Math.max(from + 1, l.to), severity, message });
    this.diags.set(file, list);
    if (file === this.active) this.o.editor.dispatch(setDiagnostics(this.o.editor.state, list));
  }

  // ---- File operations ----
  changed(file) { this.render(); this.o.onChange?.(file); }

  /** Validate a script name for New / Rename: returns the normalised name or an error string. */
  checkScriptName(raw, current = null) {
    const name = raw.trim();
    if (!name) return { error: 'Enter a file name.' };
    const n = normalizePath(name.includes('.') ? name : `${name}.js`);
    if (!n) return { error: 'That is not a valid file name.' };
    if (!ACCEPTED_EXT.includes(extOf(n))) return { error: `Unsupported file type "${extOf(n)}". Use ${ACCEPTED_EXT.join(', ')}.` };
    if (n === ENTRY) return { error: `${ENTRY} is the entry script.` };
    if (n !== current && this.project.has(n)) return { error: `"${n}" already exists.` };
    if (current && isTextFile(current) !== isTextFile(n)) return { error: 'Keep the same kind of file extension.' };
    return { name: n };
  }

  async newScript() {
    const name = await askName({ title: 'New script', message: 'Import it from main.js with import { … } from \'./name.js\'.', value: this.project.uniqueName('part.js'), ok: 'Create',
      validate: (v) => this.checkScriptName(v).error });
    if (!name) return;
    const n = this.checkScriptName(name).name;
    const ident = n.replace(/\.[^.]*$/, '').split('/').pop().replace(/[^\w$]+/g, '_');
    this.project.set(n, `// ${n}\nexport const ${ident} = box(10);\n`);
    this.changed(n);
    this.select(n);
  }

  async addFiles(files) {
    let last = null;
    for (const f of files) {
      if (!ACCEPTED_EXT.includes(extOf(f.name))) { alert(`Skipped "${f.name}": use ${ACCEPTED_EXT.join(', ')}.`); continue; }
      if (this.project.has(f.name) && !(await askName({ title: 'Replace file', message: `"${f.name}" is already in the project. Replace it?`, ok: 'Replace', input: false }))) continue;
      const content = isTextFile(f.name) ? await f.text() : await f.arrayBuffer();
      this.project.set(f.name, content);
      this.states.delete(f.name);
      last = f.name;
    }
    if (last) { this.changed(last); this.select(last); }
  }

  async rename() {
    const from = this.active;
    if (from === ENTRY) return;
    const to = await askName({ title: 'Rename file', message: 'Imports that refer to the old name must be updated by hand.', value: from, ok: 'Rename',
      validate: (v) => (isTextFile(from) ? this.checkScriptName(v, from).error : (normalizePath(v) && extOf(v) === extOf(from) ? null : `Keep the ${extOf(from)} extension.`)) });
    if (!to) return;
    const n = isTextFile(from) ? this.checkScriptName(to, from).name : normalizePath(to);
    if (n === from) return;
    this.renameFile(from, n);
    this.changed(n);
  }

  async remove() {
    const file = this.active;
    if (file === ENTRY) return;
    if (!(await askName({ title: 'Remove file', message: `Remove "${file}" from the project? This cannot be undone.`, ok: 'Remove', input: false }))) return;
    this.removeFile(file);
    this.changed(file);
  }
}
