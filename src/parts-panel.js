/**
 * Parts list in the menu: per-part visibility and ghost toggles, solo on
 * double-click, single-part STL export. User overrides survive rebuilds.
 */
export class PartsPanel {
  /**
   * @param {HTMLElement} root  the #parts-menu element
   * @param {object} h  callbacks: viewer, onChange() after any toggle, onExport(part, index), onLayout() after re-render
   */
  constructor(root, h) {
    this.h = h;
    this.body = root.querySelector('.parts-body');
    this.state = new Map(); // name -> { visible, ghost } overrides that survive rebuilds
    this.parts = [];
    // Keep the dropdown open while interacting with the list.
    root.querySelector('.parts-items').addEventListener('click', (e) => e.stopPropagation());
    root.querySelector('.parts-all').addEventListener('click', () => { this.state.clear(); this.changed(); });
    root.querySelector('.parts-none').addEventListener('click', () => {
      this.parts.forEach((p) => this.state.set(p.name, { ...this.flags(p), visible: false }));
      this.changed();
    });
  }

  /** Replace the part list after a build; stale overrides are dropped. */
  setParts(parts) {
    this.parts = parts;
    for (const k of [...this.state.keys()]) if (!parts.some((p) => p.name === k)) this.state.delete(k);
    this.render();
  }

  flags(p) {
    const o = this.state.get(p.name) ?? {};
    return { visible: o.visible ?? !p.hidden, ghost: o.ghost ?? p.ghost };
  }

  set(p, patch) {
    this.state.set(p.name, { ...this.flags(p), ...patch });
    this.changed();
  }

  changed() { this.render(); this.h.onChange?.(); }

  render() {
    const { viewer } = this.h;
    this.body.textContent = '';
    if (!this.parts.length) this.body.appendChild(Object.assign(document.createElement('div'), { className: 'parts-empty', textContent: 'No parts yet' }));
    this.parts.forEach((p, i) => {
      const f = this.flags(p);
      viewer.updatePart(i, f);
      const row = document.createElement('div');
      row.className = `part-row${f.visible ? '' : ' off'}${f.ghost ? ' ghost' : ''}`;
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: f.visible, title: 'Show / hide' });
      cb.addEventListener('change', () => this.set(p, { visible: cb.checked }));
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = p.color;
      const name = document.createElement('span'); name.className = 'pname'; name.textContent = p.name;
      name.title = `${p.name}\n${p.tris} triangles · ${p.volume.toFixed(1)} mm³\nClick to show/hide · double-click to solo`;
      // Single click toggles like the checkbox; a double-click solos (and undoes the two single-click toggles).
      let clickTimer = null;
      name.addEventListener('click', () => {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => this.set(p, { visible: !this.flags(p).visible }), 220);
      });
      name.addEventListener('dblclick', () => {
        clearTimeout(clickTimer);
        const soloed = this.parts.every((q, j) => (j === i) === this.flags(q).visible);
        this.parts.forEach((q, j) => this.state.set(q.name, { ...this.flags(q), visible: soloed ? true : j === i }));
        this.changed();
      });
      const ghost = document.createElement('button'); ghost.textContent = 'ghost'; ghost.title = 'Show as transparent reference (not exported)';
      ghost.className = f.ghost ? 'on' : ''; ghost.addEventListener('click', () => this.set(p, { ghost: !f.ghost }));
      const stl = document.createElement('button'); stl.textContent = 'stl'; stl.title = 'Export this part as STL';
      stl.addEventListener('click', () => this.h.onExport?.(p, i));
      row.append(cb, sw, name, ghost, stl);
      this.body.appendChild(row);
    });
    this.h.onLayout?.();
  }
}
