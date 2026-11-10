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
  /**
   * getProject() -> Project, setProject(project), fileInput, onChange(this),
   * extras() -> more archive entries to save ({ path: Uint8Array }, e.g. the conversation) or null, or a promise of them,
   * extrasToken() -> a string that changes whenever extras() would (so they count as unsaved changes)
   */
  constructor({ getProject, setProject, fileInput, onChange, extras, extrasToken }) {
    this.getProject = getProject;
    this.extras = extras ?? (() => null);
    this.extrasToken = extrasToken ?? (() => '');
    this.setProject = setProject;
    this.fileInput = fileInput;
    this.onChange = onChange ?? (() => {});
    this.handle = null;
    this.name = UNTITLED;
    this.dirty = false;
    this.generation = 0; // bumps whenever a different project is loaded (new / open), so per-reply undo knows not to cross it
    this.savedSnapshot = this.snapshot();
  }

  snapshot() { return JSON.stringify(this.getProject().toJSON()) + '\n' + this.extrasToken(); }

  /** Take the current state as the saved one (after a reload, where the file link is gone anyway). */
  rebase() { this.savedSnapshot = this.snapshot(); if (this.dirty) { this.dirty = false; this.onChange(this); } }

  async _zip() { return this.getProject().toZip(await this.extras()); }

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

  /** Start a project from one script. force skips the discard prompt (the caller already asked). */
  newProject(template = '', { force = false } = {}) {
    if (!force && !this.confirmDiscard()) return false;
    this.handle = null;
    this.generation++;
    this.setProject(Project.fromScript(template));
    this._update(UNTITLED);
    return true;
  }

  /** Build a project from an opened file: .temen archive or a single script. */
  async _load(file) {
    if (file.name.toLowerCase().endsWith(PROJECT_EXT)) return Project.fromZip(new Uint8Array(await file.arrayBuffer()));
    return Project.fromScript(await file.text());
  }

  /** Pick and open a project or script. Resolves true once one is open, false if cancelled. force skips the discard prompt. */
  async open({ force = false } = {}) {
    if (!force && !this.confirmDiscard()) return false;
    if (hasFSAccess) {
      let handle;
      try { [handle] = await window.showOpenFilePicker({ types: TYPES, multiple: false }); }
      catch (e) { if (e.name === 'AbortError') return false; throw e; }
      const file = await handle.getFile();
      const project = await this._load(file);
      this.handle = file.name.toLowerCase().endsWith(PROJECT_EXT) ? handle : null; // a .js opens as a new, unsaved project
      this.generation++;
      this.setProject(project);
      this._update(this.handle ? file.name : file.name.replace(/\.[^.]*$/, '') + PROJECT_EXT);
      return true;
    }
    return new Promise((resolve, reject) => {
      this.fileInput.value = '';
      this.fileInput.oncancel = () => resolve(false);
      this.fileInput.onchange = async () => {
        const file = this.fileInput.files?.[0];
        if (!file) return resolve(false);
        try {
          const project = await this._load(file);
          this.handle = null;
          this.generation++;
          this.setProject(project);
          this._update(file.name.toLowerCase().endsWith(PROJECT_EXT) ? file.name : file.name.replace(/\.[^.]*$/, '') + PROJECT_EXT);
          resolve(true);
        } catch (e) { reject(e); }
      };
      this.fileInput.click();
    });
  }

  /** Save would write the opened file in place (no picker, no click needed). */
  get canSaveInPlace() { return !!this.handle; }

  async save() {
    if (this.handle) {
      const w = await this.handle.createWritable();
      await w.write(await this._zip());
      await w.close();
      this._update(this.name);
      return true;
    }
    return this.saveAs();
  }

  async saveAs() {
    // started now but awaited after the picker, which must open straight from the click
    const zipping = this._zip();
    zipping.catch(() => {});
    const suggested = this.name.endsWith(PROJECT_EXT) ? this.name : this.name.replace(/\.[^.]*$/, '') + PROJECT_EXT;
    if (hasFSAccess) {
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: suggested, types: SAVE_TYPES }); }
      catch (e) { if (e.name === 'AbortError') return false; throw e; }
      const bytes = await zipping;
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      this.handle = handle;
      this._update(handle.name);
      return true;
    } else {
      let name = prompt('Save as:', suggested);
      if (!name) return false;
      if (!name.toLowerCase().endsWith(PROJECT_EXT)) name += PROJECT_EXT;
      const blob = new Blob([await zipping], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this._update(name);
      return true;
    }
  }
}
