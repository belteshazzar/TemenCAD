/**
 * File tabs above the editor. Each text file keeps its own CodeMirror state (undo history,
 * diagnostics); binary files (fonts, meshes) show an info panel with the import line to use.
 * The "+" menu adds, renames and removes files.
 */
import { setDiagnostics } from '@codemirror/lint';
import { ENTRY, ACCEPTED_EXT, isTextFile, isFontFile, isMeshFile, extOf } from './project.js';

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
    this.menu = root.querySelector('.tab-menu');
    this.states = new Map();
    this.diags = new Map();
    this.active = null;
    root.querySelector('.tab-add').addEventListener('click', (e) => { e.stopPropagation(); this.menu.classList.toggle('open'); });
    document.addEventListener('click', () => this.menu.classList.remove('open'));
    this.menu.addEventListener('click', (e) => {
      const action = e.target.closest('button')?.dataset.action;
      if (!action) return;
      this.menu.classList.remove('open');
      if (action === 'new') this.newScript();
      if (action === 'add') { o.fileInput.value = ''; o.fileInput.click(); }
      if (action === 'rename') this.rename();
      if (action === 'remove') this.remove();
    });
    o.fileInput.addEventListener('change', () => this.addFiles([...o.fileInput.files]));
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
      b.className = `tab${name === this.active ? ' active' : ''}${isTextFile(name) ? '' : ' asset'}`;
      b.textContent = name;
      b.title = name === ENTRY ? 'Entry script' : name;
      b.addEventListener('click', () => this.select(name));
      this.list.appendChild(b);
    }
    for (const b of this.menu.querySelectorAll('[data-action="rename"], [data-action="remove"]')) b.disabled = this.active === ENTRY;
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

  newScript() {
    const name = prompt('New script name:', this.project.uniqueName('part.js'));
    if (!name) return;
    const n = name.includes('.') ? name : `${name}.js`;
    if (!ACCEPTED_EXT.includes(extOf(n))) return alert(`Unsupported file type "${extOf(n)}". Use ${ACCEPTED_EXT.join(', ')}.`);
    if (this.project.has(n)) return alert(`"${n}" already exists.`);
    const ident = n.replace(/\.[^.]*$/, '').replace(/[^\w$]+/g, '_');
    try { this.project.set(n, `// ${n}\nexport const ${ident} = box(10);\n`); } catch (e) { return alert(e.message); }
    this.changed(n);
    this.select(n);
  }

  async addFiles(files) {
    let last = null;
    for (const f of files) {
      if (!ACCEPTED_EXT.includes(extOf(f.name))) { alert(`Skipped "${f.name}": use ${ACCEPTED_EXT.join(', ')}.`); continue; }
      if (this.project.has(f.name) && !confirm(`Replace "${f.name}"?`)) continue;
      const content = isTextFile(f.name) ? await f.text() : await f.arrayBuffer();
      this.project.set(f.name, content);
      this.states.delete(f.name);
      last = f.name;
    }
    if (last) { this.changed(last); this.select(last); }
  }

  rename() {
    const from = this.active;
    if (from === ENTRY) return;
    const to = prompt('Rename to:', from);
    if (!to || to === from) return;
    let n;
    try { n = this.renameFile(from, to); } catch (e) { return alert(e.message); }
    this.changed(n);
  }

  remove() {
    const file = this.active;
    if (file === ENTRY || !confirm(`Remove "${file}" from the project?`)) return;
    this.removeFile(file);
    this.changed(file);
  }
}
