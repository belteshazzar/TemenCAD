/**
 * Open / save the script as a .js text file.
 * Uses the File System Access API where available (Chromium) so "Save" can
 * overwrite the opened file; falls back to <input type=file> + download.
 */
const TYPES = [{ description: 'JavaScript model script', accept: { 'text/javascript': ['.js', '.mjs'], 'text/plain': ['.txt'] } }];
const hasFSAccess = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;

export class FileManager {
  constructor({ getText, setText, fileInput, onChange }) {
    this.getText = getText;
    this.setText = setText;
    this.fileInput = fileInput;
    this.onChange = onChange ?? (() => {});
    this.handle = null;
    this.name = 'untitled.js';
    this.dirty = false;
    this.savedText = getText();
  }

  _update(name, text) {
    this.name = name;
    this.savedText = text;
    this.dirty = false;
    this.onChange(this);
  }

  /** Call whenever the editor content changes. */
  markChanged() {
    const d = this.getText() !== this.savedText;
    if (d !== this.dirty) { this.dirty = d; this.onChange(this); }
  }

  confirmDiscard() {
    return !this.dirty || confirm(`Discard unsaved changes to ${this.name}?`);
  }

  newFile(template = '') {
    if (!this.confirmDiscard()) return false;
    this.handle = null;
    this.setText(template);
    this._update('untitled.js', template);
    return true;
  }

  async open() {
    if (!this.confirmDiscard()) return;
    if (hasFSAccess) {
      let handle;
      try { [handle] = await window.showOpenFilePicker({ types: TYPES, multiple: false }); }
      catch (e) { if (e.name === 'AbortError') return; throw e; }
      const file = await handle.getFile();
      const text = await file.text();
      this.handle = handle;
      this.setText(text);
      this._update(file.name, text);
    } else {
      this.fileInput.value = '';
      this.fileInput.onchange = async () => {
        const file = this.fileInput.files?.[0];
        if (!file) return;
        const text = await file.text();
        this.handle = null;
        this.setText(text);
        this._update(file.name, text);
      };
      this.fileInput.click();
    }
  }

  async save() {
    if (this.handle) {
      const text = this.getText();
      const w = await this.handle.createWritable();
      await w.write(text);
      await w.close();
      this._update(this.name, text);
      return;
    }
    return this.saveAs();
  }

  async saveAs() {
    const text = this.getText();
    const suggested = this.name.endsWith('.js') ? this.name : this.name.replace(/\.[^.]*$/, '') + '.js';
    if (hasFSAccess) {
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: suggested, types: TYPES }); }
      catch (e) { if (e.name === 'AbortError') return; throw e; }
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      this.handle = handle;
      this._update(handle.name, text);
    } else {
      const name = prompt('Save as:', suggested);
      if (!name) return;
      const blob = new Blob([text], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this._update(name, text);
    }
  }
}
