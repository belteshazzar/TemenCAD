/**
 * Variables panel: top-level declarations that call variable() become sliders and checkboxes:
 *   const W = variable("Width", 60, 10, 200, 1);   // label, value, min, max, step
 *   const R = variable("Radius", 2.5);             // range inferred from the value
 *   const SOLID = variable("Solid body", true);    // checkbox
 * Changing a control rewrites the value argument in the editor, so the script stays the single source of truth.
 */

const LINE_RE = /^(?<pre>(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*variable\(\s*(?<q>["'`])(?<label>.*?)\k<q>\s*,\s*)(?<value>-?\d+(?:\.\d+)?|true|false)\s*(?:,\s*(?<min>-?\d+(?:\.\d+)?)\s*)?(?:,\s*(?<max>-?\d+(?:\.\d+)?)\s*)?(?:,\s*(?<step>-?\d+(?:\.\d+)?)\s*)?\)\s*;?[ \t]*(?:\/\/.*)?$/;

function nice(x) { // round up to 1, 2, 5 × 10^k
  if (x <= 0) return 0;
  const k = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (m * k >= x) return m * k;
  return 10 * k;
}

function inferRange(v, text) {
  const decimals = (text.split('.')[1] || '').length;
  const step = decimals ? Math.pow(10, -decimals) : 1;
  if (v === 0) return { min: 0, max: 10, step };
  const span = nice(Math.abs(v) * 2);
  return v > 0 ? { min: 0, max: span, step } : { min: -span, max: span, step };
}

/** Parse a document string into variable descriptors with literal positions. */
export function parseVariables(text) {
  const vars = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const m = line.match(LINE_RE);
    if (m) {
      const { pre, name, label, value: literal, min, max, step } = m.groups;
      const litStart = offset + pre.length;
      const isBool = literal === 'true' || literal === 'false';
      const v = { name, label: label.trim() || name, from: litStart, to: litStart + literal.length, type: isBool ? 'boolean' : 'number' };
      v.value = isBool ? literal === 'true' : Number(literal);
      if (!isBool) {
        const inf = inferRange(v.value, literal);
        v.min = min !== undefined ? Number(min) : inf.min;
        v.max = max !== undefined ? Number(max) : inf.max;
        v.step = step !== undefined ? Number(step) : inf.step;
        if (!(v.max > v.min)) { v.min = inf.min; v.max = inf.max; }
        if (!(v.step > 0)) v.step = inf.step;
      }
      vars.push(v);
    }
    offset += line.length + 1;
  }
  return vars;
}

function format(n, step) {
  const decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  return Number(n.toFixed(decimals)).toString();
}

export class VariablesPanel {
  /**
   * @param {HTMLElement} root  container with .vars-header and .vars-body children
   * @param {EditorView} editor
   * @param {() => void} onChange  called after a control rewrites the source
   */
  constructor(root, editor, onChange) {
    this.root = root;
    this.editor = editor;
    this.onChange = onChange;
    this.body = root.querySelector('.vars-body');
    this.count = root.querySelector('.vars-count');
    this.rows = new Map();
    this.signature = '';
    root.querySelector('.vars-header').addEventListener('click', () => {
      root.classList.toggle('collapsed');
      try { localStorage.setItem('temencad.vars.collapsed', root.classList.contains('collapsed') ? '1' : '0'); } catch {}
    });
    try { if (localStorage.getItem('temencad.vars.collapsed') === '1') root.classList.add('collapsed'); } catch {}
  }

  refresh() {
    const vars = parseVariables(this.editor.state.doc.toString());
    this.vars = vars;
    this.count.textContent = vars.length ? `(${vars.length})` : '';
    this.root.hidden = vars.length === 0;
    const sig = vars.map((v) => `${v.name}:${v.type}:${v.min}:${v.max}:${v.step}:${v.label}`).join('|');
    if (sig !== this.signature) { this.signature = sig; this.rebuild(vars); }
    else for (const v of vars) this.rows.get(v.name)?.update(v);
  }

  rebuild(vars) {
    this.body.textContent = '';
    this.rows.clear();
    for (const v of vars) {
      const row = document.createElement('div');
      row.className = 'var-row';
      const label = document.createElement('label');
      label.textContent = v.label;
      label.title = v.name;
      row.appendChild(label);
      let update;
      if (v.type === 'boolean') {
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = v.value;
        cb.addEventListener('change', () => this.write(v.name, cb.checked ? 'true' : 'false'));
        row.appendChild(cb);
        update = (nv) => { cb.checked = nv.value; };
      } else {
        const range = document.createElement('input');
        range.type = 'range'; range.min = v.min; range.max = v.max; range.step = v.step; range.value = v.value;
        const num = document.createElement('input');
        num.type = 'number'; num.step = v.step; num.value = format(v.value, v.step);
        range.addEventListener('input', () => { num.value = format(+range.value, v.step); this.write(v.name, num.value); });
        num.addEventListener('change', () => { if (num.value === '' || Number.isNaN(+num.value)) return; range.value = num.value; this.write(v.name, format(+num.value, v.step)); });
        row.append(range, num);
        update = (nv) => {
          if (document.activeElement !== range && document.activeElement !== num) { range.value = nv.value; num.value = format(nv.value, v.step); }
        };
      }
      this.rows.set(v.name, { el: row, update });
      this.body.appendChild(row);
    }
  }

  /** Replace the literal of variable `name` in the editor with `literal`. */
  write(name, literal) {
    const v = parseVariables(this.editor.state.doc.toString()).find((x) => x.name === name);
    if (!v) return;
    const current = this.editor.state.doc.sliceString(v.from, v.to);
    if (current === literal) return;
    this.editor.dispatch({ changes: { from: v.from, to: v.to, insert: literal } });
    this.onChange();
  }
}
