/**
 * Shared-shape catalogue in the app: browse and add packages from the static catalogue site, and
 * share the current project as a package (publish endpoint, or download + instructions).
 */
import { CATALOG_URL, CATALOG_REPO_URL, PUBLISH_URL } from './config.js';
import { ENTRY, isScript } from './project.js';
import { readPackage, vendorPackage, addImportLine, buildPackage, validateManifest, findExports, slugify, LICENSES, API_VERSION } from './package.js';

let indexPromise = null;
/** index.json, fetched once per session (the browser cache handles revalidation on later loads). */
function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch(`${CATALOG_URL}index.json`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch((err) => { indexPromise = null; throw err; });
  }
  return indexPromise;
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * @param {object} o  getProject(), tabs (Tabs), onChange() after the project changed,
 *                    snapshot() -> { data (base64 PNG) } for share previews, log(text, cls)
 */
export function initCatalog(o) {
  // ---- Browse / add ----
  const dialog = document.getElementById('catalog-dialog');
  const search = dialog.querySelector('.catalog-search');
  const tagsEl = dialog.querySelector('.catalog-tags');
  const grid = dialog.querySelector('.catalog-grid');
  const detail = dialog.querySelector('.catalog-detail');
  const status = dialog.querySelector('.catalog-status');
  let packages = [], selected = null, tag = null;

  function renderGrid() {
    const q = search.value.trim().toLowerCase();
    const list = packages.filter((p) => (!tag || p.tags.includes(tag)) && (!q || `${p.title} ${p.description} ${p.tags.join(' ')} ${p.author}`.toLowerCase().includes(q)));
    grid.textContent = '';
    if (!list.length) grid.appendChild(el('div', 'catalog-empty', packages.length ? 'No shapes match.' : 'The catalogue is empty.'));
    for (const p of list) {
      const card = el('button', `catalog-card${p === selected ? ' selected' : ''}`);
      card.type = 'button';
      const img = el('img'); img.src = CATALOG_URL + p.thumb; img.alt = ''; img.loading = 'lazy';
      card.append(img, el('div', 'catalog-title', p.title), el('div', 'catalog-meta', `${p.author} · ${p.license}`));
      card.addEventListener('click', () => { selected = p; renderGrid(); renderDetail(); });
      grid.appendChild(card);
    }
  }
  function renderTags() {
    const counts = new Map();
    for (const p of packages) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    tagsEl.textContent = '';
    for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
      const b = el('button', `catalog-tag${t === tag ? ' on' : ''}`, `${t} ${n}`);
      b.type = 'button';
      b.addEventListener('click', () => { tag = tag === t ? null : t; renderTags(); renderGrid(); });
      tagsEl.appendChild(b);
    }
  }
  function renderDetail() {
    detail.textContent = '';
    if (!selected) { detail.appendChild(el('div', 'catalog-hint', 'Select a shape to see what it exports.')); return; }
    const p = selected;
    const img = el('img'); img.src = CATALOG_URL + p.thumb; img.alt = '';
    const usage = el('pre', null, `import { ${p.exports.join(', ')} } from './catalog/${p.name}/${p.module}';`);
    const add = el('button', null, o.getProject().has(`catalog/${p.name}/${p.module}`) ? 'Update in project' : 'Add to project');
    add.type = 'button';
    add.addEventListener('click', () => addPackage(p, add));
    const src = el('a', 'catalog-link', 'Source'); src.href = `${CATALOG_REPO_URL}/tree/main/${p.source}`; src.target = '_blank'; src.rel = 'noopener';
    detail.append(img, el('h3', null, p.title), el('p', null, p.description),
      el('div', 'catalog-meta', `${p.author} · ${p.license} · v${p.version} · ${fmtSize(p.bytes)} · ${p.parts.length} part${p.parts.length === 1 ? '' : 's'}`),
      usage, el('div', 'catalog-actions'));
    detail.querySelector('.catalog-actions').append(add, src);
  }
  /** Fetch a package archive and vendor it into the open project. */
  async function vendorFromCatalog(packagePath) {
    const res = await fetch(CATALOG_URL + packagePath);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { manifest, project: pkg } = readPackage(new Uint8Array(await res.arrayBuffer()));
    const project = o.getProject();
    const { importLine, added } = vendorPackage(project, pkg, manifest);
    o.tabs.filesChanged(added);
    o.tabs.setText(ENTRY, addImportLine(o.tabs.text(ENTRY), importLine));
    o.onChange();
    o.log(`Added ${manifest.name}@${manifest.version} from the catalogue: ${importLine}`, 'info');
    o.tabs.select(ENTRY);
    return manifest;
  }
  async function addPackage(p, button) {
    button.disabled = true; button.textContent = 'Adding…';
    try {
      await vendorFromCatalog(p.package);
      dialog.close();
    } catch (err) {
      status.textContent = `Could not add ${p.name}: ${err.message}`;
      button.disabled = false; button.textContent = 'Add to project';
    }
  }
  /** `#add=<name>` links from the catalogue site: add that package to the current project. */
  async function addByName(name) {
    try { await vendorFromCatalog(`packages/${encodeURIComponent(name)}.temen`); }
    catch (err) { o.log(`Could not add "${name}" from the catalogue: ${err.message}`, 'err'); }
  }
  async function openBrowser() {
    status.textContent = 'Loading catalogue…';
    grid.textContent = ''; detail.textContent = ''; selected = null; tag = null; search.value = '';
    dialog.showModal();
    try {
      const index = await loadIndex();
      packages = index.packages.filter((p) => p.apiVersion === API_VERSION);
      status.textContent = `${packages.length} shape${packages.length === 1 ? '' : 's'}`;
      renderTags(); renderGrid(); renderDetail();
      search.focus();
    } catch (err) {
      status.textContent = `Could not load the catalogue (${err.message}). It lives at ${CATALOG_URL}`;
    }
  }
  search.addEventListener('input', renderGrid);
  dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());

  // ---- Share ----
  const shareDialog = document.getElementById('share-dialog');
  const shareForm = document.getElementById('share-form');
  const shareError = shareForm.querySelector('.dialog-error');
  const shareResult = shareDialog.querySelector('.share-result');
  const shareBusy = shareDialog.querySelector('.dialog-busy');
  const setBusy = (text) => { shareBusy.hidden = !text; if (text) shareBusy.querySelector('.dialog-busy-text').textContent = text; };
  for (const [id, label] of LICENSES) shareForm.elements.license.appendChild(Object.assign(document.createElement('option'), { value: id, textContent: label }));

  function openShare() {
    const project = o.getProject();
    const scripts = project.names().filter((n) => isScript(n) && n !== ENTRY && !n.startsWith('catalog/'));
    const moduleSel = shareForm.elements.module;
    moduleSel.textContent = '';
    for (const s of scripts) moduleSel.appendChild(Object.assign(document.createElement('option'), { value: s, textContent: s }));
    shareError.hidden = true; shareResult.hidden = true; setBusy(null);
    shareForm.hidden = false;
    if (!scripts.length) {
      shareError.textContent = 'A shared shape needs a module file next to main.js that exports its functions (for example hinge.js with "export function hinge(...)"). main.js stays the demo.';
      shareError.hidden = false;
    }
    shareForm.elements.exports.value = scripts.length ? findExports(project.get(scripts[0])).join(', ') : '';
    shareForm.querySelector('.share-submit').textContent = PUBLISH_URL ? 'Share' : 'Download package';
    shareDialog.showModal();
    shareForm.elements.title.focus();
  }
  shareForm.elements.module.addEventListener('change', () => { shareForm.elements.exports.value = findExports(o.getProject().get(shareForm.elements.module.value) ?? '').join(', '); });
  shareForm.elements.title.addEventListener('input', () => { if (!shareForm.elements.name.dataset.edited) shareForm.elements.name.value = slugify(shareForm.elements.title.value); });
  shareForm.elements.name.addEventListener('input', () => { shareForm.elements.name.dataset.edited = '1'; });
  shareForm.querySelector('[data-cancel]').addEventListener('click', () => shareDialog.close());
  shareForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = shareForm.elements;
    const manifest = {
      name: f.name.value.trim(), version: f.version.value.trim() || '1.0.0', title: f.title.value.trim(), description: f.description.value.trim(),
      author: f.author.value.trim(), license: f.license.value, tags: f.tags.value.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean),
      module: f.module.value, exports: f.exports.value.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean), apiVersion: API_VERSION,
    };
    const project = o.getProject();
    const errors = validateManifest(manifest, project);
    if (errors.length) { shareError.textContent = errors.join('. ') + '.'; shareError.hidden = false; return; }
    const shot = o.snapshot();
    const thumb = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)).buffer;
    const bytes = buildPackage(project, manifest, thumb);
    const submit = shareForm.querySelector('.share-submit');
    submit.disabled = true;
    shareError.hidden = true;
    try {
      if (PUBLISH_URL) {
        setBusy(`Uploading ${manifest.name}.temen and opening a pull request…`);
        const body = new FormData();
        body.append('manifest', JSON.stringify(manifest));
        body.append('package', new Blob([bytes], { type: 'application/zip' }), `${manifest.name}.temen`);
        const res = await fetch(PUBLISH_URL, { method: 'POST', body });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
        showResult(`Submitted. A maintainer will review the pull request:`, out.pullRequest);
      } else {
        download(bytes, `${manifest.name}.temen`);
        showResult(`Downloaded ${manifest.name}.temen. To publish it, fork the catalogue, unzip the package into shapes/${manifest.name}/ and open a pull request:`, CATALOG_REPO_URL);
      }
    } catch (err) {
      shareError.textContent = err.message; shareError.hidden = false;
    } finally { submit.disabled = false; setBusy(null); }
  });
  function showResult(text, url) {
    shareForm.hidden = true;
    shareResult.hidden = false;
    shareResult.textContent = '';
    const a = el('a', null, url); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    const close = el('button', 'secondary', 'Close'); close.type = 'button'; close.addEventListener('click', () => shareDialog.close());
    shareResult.append(el('p', null, text), a, el('div', 'dialog-actions'));
    shareResult.querySelector('.dialog-actions').appendChild(close);
  }
  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { openBrowser, openShare, addByName };
}
