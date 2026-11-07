/**
 * Open / save the project as a .temen archive (or open a plain .js script as a new project).
 * Uses the File System Access API where available (Chromium) so "Save" can overwrite the
 * opened file; falls back to <input type=file> + download.
 */
import { Project, PROJECT_EXT } from './project.js';

const TYPES = [
  { description: 'TemenCAD project', accept: { 'application/zip': [PROJECT_EXT] } },
  { description: 'JavaScript model script', accept: { 'text/javascript': ['.js', '.mjs'] } },
];
const SAVE_TYPES = [TYPES[0]];
const hasFSAccess = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
const UNTITLED = `untitled${PROJECT_EXT}`;

export class FileManager {
  /** getProject() -> Project, setProject(project), fileInput, onChange(this) */
  constructor({ getProject, setProject, fileInput, onChange }) {
    this.getProject = getProject;
    this.setProject = setProject;
    this.fileInput = fileInput;
    this.onChange = onChange ?? (() => {});
    this.handle = null;
    this.name = UNTITLED;
    this.dirty = false;
    this.savedSnapshot = this.snapshot();
  }

  snapshot() { return JSON.stringify(this.getProject().toJSON()); }

  _update(name) {
    this.name = name;
    this.savedSnapshot = this.snapshot();
    this.dirty = false;
    this.onChange(this);
  }

  /** Call whenever the project changes. */
  markChanged() {
    const d = this.snapshot() !== this.savedSnapshot;
    if (d !== this.dirty) { this.dirty = d; this.onChange(this); }
  }

  confirmDiscard() {
    return !this.dirty || confirm(`Discard unsaved changes to ${this.name}?`);
  }

  newProject(template = '') {
    if (!this.confirmDiscard()) return false;
    this.handle = null;
    this.setProject(Project.fromScript(template));
    this._update(UNTITLED);
    return true;
  }

  /** Build a project from an opened file: .temen archive or a single script. */
  async _load(file) {
    if (file.name.toLowerCase().endsWith(PROJECT_EXT)) return Project.fromZip(new Uint8Array(await file.arrayBuffer()));
    return Project.fromScript(await file.text());
  }

  async open() {
    if (!this.confirmDiscard()) return;
    if (hasFSAccess) {
      let handle;
      try { [handle] = await window.showOpenFilePicker({ types: TYPES, multiple: false }); }
      catch (e) { if (e.name === 'AbortError') return; throw e; }
      const file = await handle.getFile();
      const project = await this._load(file);
      this.handle = file.name.toLowerCase().endsWith(PROJECT_EXT) ? handle : null; // a .js opens as a new, unsaved project
      this.setProject(project);
      this._update(this.handle ? file.name : file.name.replace(/\.[^.]*$/, '') + PROJECT_EXT);
    } else {
      this.fileInput.value = '';
      this.fileInput.onchange = async () => {
        const file = this.fileInput.files?.[0];
        if (!file) return;
        const project = await this._load(file);
        this.handle = null;
        this.setProject(project);
        this._update(file.name.toLowerCase().endsWith(PROJECT_EXT) ? file.name : file.name.replace(/\.[^.]*$/, '') + PROJECT_EXT);
      };
      this.fileInput.click();
    }
  }

  async save() {
    if (this.handle) {
      const w = await this.handle.createWritable();
      await w.write(this.getProject().toZip());
      await w.close();
      this._update(this.name);
      return;
    }
    return this.saveAs();
  }

  async saveAs() {
    const bytes = this.getProject().toZip();
    const suggested = this.name.endsWith(PROJECT_EXT) ? this.name : this.name.replace(/\.[^.]*$/, '') + PROJECT_EXT;
    if (hasFSAccess) {
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: suggested, types: SAVE_TYPES }); }
      catch (e) { if (e.name === 'AbortError') return; throw e; }
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      this.handle = handle;
      this._update(handle.name);
    } else {
      let name = prompt('Save as:', suggested);
      if (!name) return;
      if (!name.toLowerCase().endsWith(PROJECT_EXT)) name += PROJECT_EXT;
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this._update(name);
    }
  }
}
