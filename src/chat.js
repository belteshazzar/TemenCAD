/**
 * Assistant chat panel and its settings dialog. Wraps an Agent and renders the streamed
 * conversation; the API key and model live in localStorage.
 *
 * The conversation is a transcript of plain entries (rendered by renderEntry) plus project
 * checkpoints taken around each reply, so it can be kept across reloads (IndexedDB, chat-store.js)
 * and inside saved .temen files (format 2, packed by the core: core/CONVERSATION.md), and any reply
 * can be undone, and any undo put back.
 */
import { Agent, MODELS, DEFAULT_MODEL, describeAgentError } from './agent.js';
import { classify, prepareImage, projectImage } from './attachments.js';
import { BlobStore, pruneBlobs, saveLocal, loadLocal, clearLocal, bytesToBase64, base64ToBytes as base64Bytes } from './chat-store.js';
import { isTextFile } from './project.js';
import { unifiedDiff } from './diff.js';

const SETTINGS_KEY = 'temencad.assistant';
const TOOL_LABELS = {
  read_script: 'Reading the script', edit_script: 'Editing the script', write_script: 'Writing the script', remove_file: 'Removing a file',
  rename_file: 'Renaming a file', run_model: 'Building the model', take_screenshot: 'Taking a screenshot', render_views: 'Rendering views',
  new_project: 'Starting a new project', open_project: 'Opening a project', save_project: 'Saving the project', export_model: 'Exporting',
  share_project: 'Preparing to share', set_view: 'Changing the view', set_plate: 'Setting the build plate', set_part_display: 'Changing part display',
  set_autorun: 'Changing auto-run', search_catalog: 'Searching the catalogue', add_from_catalog: 'Adding from the catalogue', add_files: 'Adding files', save_attachment: 'Adding the image to the project',
};
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Minimal markdown: fenced code blocks and inline code. */
function renderMarkdown(el, text) {
  el.textContent = '';
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)```/g);
  parts.forEach((p, i) => {
    if (i % 2) { const pre = document.createElement('pre'); pre.textContent = p.replace(/\n$/, ''); el.appendChild(pre); return; }
    p.split(/(`[^`]+`)/g).forEach((seg) => {
      if (/^`[^`]+`$/.test(seg)) { const c = document.createElement('code'); c.textContent = seg.slice(1, -1); el.appendChild(c); }
      else el.appendChild(document.createTextNode(seg));
    });
  });
}

/**
 * @param {object} o
 *   root: #chat element, host: Agent host callbacks plus snapshot / sameProject / restore / canExport /
 *   download / addChatFiles / putFile; onChange(): the conversation changed (it is saved with the project)
 */
export function initChat({ root, host, onChange = () => {} }) {
  const log = root.querySelector('.chat-log');
  const form = root.querySelector('.chat-form');
  const input = root.querySelector('.chat-input');
  const send = root.querySelector('.chat-send');
  const stop = root.querySelector('.chat-stop');
  const modelEl = root.querySelector('.chat-model');
  const attachRow = root.querySelector('.chat-attachments');
  const attachInput = root.querySelector('.chat-attach-input');
  const dropHint = root.querySelector('.chat-drop');
  const dialog = document.getElementById('assistant-dialog');
  const dialogForm = document.getElementById('assistant-form');

  const settings = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } })();
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };
  const keepInFile = () => settings.keepInFile !== false;
  // On touch screens focusing the input raises the keyboard and (in portrait) shrinks the 3D view, so the
  // chat only takes focus when tapped there; elsewhere it keeps focus ready for typing.
  const touch = matchMedia('(pointer: coarse)').matches;
  const focusInput = () => { if (!touch) input.focus(); };
  if (matchMedia('(max-width: 760px), (max-height: 520px)').matches) input.placeholder = 'Describe a change, or attach a photo';

  const agent = new Agent({ ...host, showImage, saveAttachment });
  function applySettings() {
    agent.configure({ apiKey: settings.apiKey, model: settings.model || DEFAULT_MODEL });
    modelEl.textContent = settings.apiKey ? (MODELS.find((m) => m[0] === agent.model)?.[1] ?? agent.model) : 'No API key set';
  }
  applySettings();

  // ---- Conversation state ----
  const store = new BlobStore(); // images, attachments and checkpoint contents, by content hash
  let entries = [];              // the transcript (see renderEntry)
  let checkpoints = [];          // project snapshots { generation, files }; reply and event entries refer to them by index
  let revision = 0;              // bumps whenever the conversation changes (the project's unsaved marker follows it)
  const liveUrls = [];           // object URLs made this session (downloads, pending attachments), revoked on reset

  function addMsg(cls, text = '') {
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children); return e; };
  const quote = (t) => `"${t.length > 80 ? t.slice(0, 77) + '…' : t}"`;

  /** Store the conversation: in this browser now, and in the project file on its next save. */
  let saving = Promise.resolve();
  function persist() {
    revision++;
    onChange();
    const state = entries.length ? pack() : null;
    saving = saving.then(() => (state ? saveLocal(state) : clearLocal())).catch((err) => console.warn('Could not keep the conversation in this browser:', err));
  }
  function pack() {
    const generation = host.snapshot().generation;
    return pruneBlobs({
      entries,
      checkpoints: checkpoints.map((c) => store.packSnapshot(c, generation)),
      messages: store.packMessages(agent.messages),
      notes: agent.notes,
      attachments: agent.attachments,
    }, store);
  }
  function reset() {
    cancelPending();
    if (agent.busy) agent.stop();
    agent.reset();
    for (const u of liveUrls.splice(0)) URL.revokeObjectURL(u);
    store.clear();
    entries = []; checkpoints = [];
    latestDownloads = null;
    log.textContent = '';
  }
  /** Show a kept conversation ({ json, blobs } from chat-store), or an empty chat for null. */
  function load(state) {
    reset();
    if (state) {
      for (const [k, b] of state.blobs) store.blobs.set(k, b);
      const generation = host.snapshot().generation;
      const j = state.json;
      checkpoints = (j.checkpoints ?? []).map((p) => store.unpackSnapshot(p, generation));
      agent.messages = store.unpackMessages(j.messages ?? []);
      agent.notes = j.notes ?? [];
      agent.attachments = j.attachments ?? [];
      entries = j.entries ?? [];
      for (const e of entries) renderEntry(e);
    }
    showEmpty();
  }
  function push(entry) { entries.push(entry); return renderEntry(entry, true); }

  // ---- The conversation in the project file: format 2 (core/CONVERSATION.md), packed by the core ----
  const ATT_TO_2 = { ref: 'reference', measure: 'measurement' }, ATT_FROM_2 = { reference: 'ref', measurement: 'measure' };
  /** { json, blobs } for the core: transcript images and messages inline, checkpoint files and attachments by reference. */
  function toFormat2() {
    const generation = host.snapshot().generation;
    const blobs = new Map();
    const ref = (key) => { blobs.set(key, store.get(key)); return { $blob: key }; };
    const inline = (key, type) => ({ type: 'base64', media_type: type, data: bytesToBase64(store.get(key)) });
    // undo points from before the assistant opened this project cannot be restored here: left empty, unused
    const ours = checkpoints.map((c) => c.generation === generation);
    const cps = checkpoints.map((c, i) => {
      const files = {};
      if (ours[i]) for (const [name, v] of Object.entries(c.files)) files[name] = ref(typeof v === 'string' ? store.putText(v) : store.putBuffer(v));
      return files;
    });
    const out = entries.map((e) => {
      switch (e.t) {
        case 'user': return { kind: 'user', text: e.text, attachments: (e.atts ?? []).map((a) => ({
          kind: ATT_TO_2[a.kind] ?? a.kind, name: a.name, size: a.size || undefined, text: a.text,
          color: a.colorHex !== undefined ? `#${a.colorHex.toString(16).padStart(6, '0')}` : undefined, color_name: a.color,
          image: a.key && a.kind === 'image' ? inline(a.key, a.type) : undefined })) };
        case 'assistant': case 'error': case 'status': return { kind: e.t, text: e.text };
        case 'tool': return { kind: 'tool', name: e.name };
        case 'image': return { kind: 'image', image: inline(e.key, e.type), caption: e.caption };
        case 'card': return { kind: 'card', text: e.text, answer: e.note, labels: e.labels };
        case 'download': return { kind: 'file', name: e.filename, size: e.size, text: e.text || undefined };
        case 'reply': {
          const ok = e.changed && ours[e.before] && ours[e.after];
          return { kind: 'reply', message: e.text, changed: !!ok, before: ok ? e.before : undefined, after: ok ? e.after : undefined };
        }
        case 'event': return { kind: 'event', message: e.reply, undo: e.kind === 'undo', put_back: e.putBack, used: !!e.used || !ours[e.putBack] };
        default: return e.text ? { kind: 'status', text: e.text } : null;
      }
    }).filter(Boolean);
    const json = {
      format: 2, app: 'TemenCAD web', entries: out, messages: agent.messages, notes: agent.notes,
      attachments: agent.attachments.map((a) => ({ name: a.name, media_type: a.type, data: ref(a.key) })),
      checkpoints: cps,
    };
    return { json, blobs };
  }
  /** Show a conversation read from a project file: the core's { json (text), blobs }. */
  function loadFormat2({ json: text, blobs }) {
    reset();
    const j = JSON.parse(text);
    const generation = host.snapshot().generation;
    for (const [k, b] of blobs) store.blobs.set(k, b);
    const put = (src) => (src?.data ? store.put(base64Bytes(src.data)) : undefined);
    checkpoints = (j.checkpoints ?? []).map((c) => {
      const files = {};
      for (const [name, r] of Object.entries(c)) {
        if (isTextFile(name)) { const s = store.text(r.$blob); store.textKeys.set(s, r.$blob); files[name] = s; }
        else { const b = store.buffer(r.$blob); store.objKeys.set(b, r.$blob); files[name] = b; }
      }
      return { generation: Object.keys(files).length ? generation : -1, files };
    });
    entries = (j.entries ?? []).map((e) => {
      switch (e.kind) {
        case 'user': return { t: 'user', text: e.text ?? '', atts: (e.attachments ?? []).map((a) => ({
          kind: ATT_FROM_2[a.kind] ?? a.kind, name: a.name ?? '', size: a.size ?? 0, text: a.text, color: a.color_name,
          colorHex: a.color ? parseInt(a.color.slice(1), 16) : undefined, key: put(a.image), type: a.image?.media_type })) };
        case 'assistant': case 'error': case 'status': return { t: e.kind, text: e.text ?? '' };
        case 'tool': return { t: 'tool', name: e.name ?? '' };
        case 'image': return e.image ? { t: 'image', key: put(e.image), type: e.image.media_type ?? 'image/png', caption: e.caption ?? '' } : null;
        case 'card': return { t: 'card', text: e.text ?? '', labels: e.labels ?? [], note: e.answer };
        case 'file': return { t: 'download', filename: e.name ?? 'file', size: e.size ?? 0, text: e.text ?? '' };
        case 'reply': return { t: 'reply', text: e.message ?? '', changed: !!e.changed, before: e.before, after: e.after };
        case 'event': return { t: 'event', kind: e.undo ? 'undo' : 'redo', reply: e.message ?? '', putBack: e.put_back, used: !!e.used };
        default: return e.text ? { t: 'status', text: e.text } : null; // a kind from a newer app
      }
    }).filter(Boolean);
    agent.messages = j.messages ?? [];
    agent.notes = j.notes ?? [];
    agent.attachments = (j.attachments ?? []).map((a) => ({ name: a.name, type: a.media_type, key: a.data?.$blob }));
    for (const e of entries) renderEntry(e);
    showEmpty();
  }

  /**
   * Draw one transcript entry. live: drawn as it happens (interactive cards, download links and
   * download buttons exist only then). Entries:
   *   { t: 'user', text, atts: [{ name, kind, size, key?, type? }] }   { t: 'assistant', text }
   *   { t: 'tool', name }   { t: 'image', key, type, caption }   { t: 'error', text }
   *   { t: 'card', text, labels, note }   { t: 'download', filename, size, text }
   *   { t: 'reply', text, changed, before, after }   (before / after: checkpoint indices)
   *   { t: 'event', kind: 'undo' | 'redo', reply, putBack, used }   (putBack: checkpoint that reverses it)
   */
  function renderEntry(e, live = false, extra = {}) {
    switch (e.t) {
      case 'user': {
        const m = addMsg('user', e.text);
        if (e.atts?.length) m.prepend(el('div', { className: 'msg-attachments' }, ...e.atts.map((a) => attachmentChip({ ...a, url: a.url ?? (a.key && a.kind === 'image' ? store.url(a.key, a.type) : null) }, 'sent'))));
        return m;
      }
      case 'assistant': { const m = addMsg('assistant'); renderMarkdown(m, e.text); return m; }
      case 'tool': return addMsg('tool', `${TOOL_LABELS[e.name] ?? e.name}…`);
      case 'error': return addMsg('error', e.text);
      case 'status': return addMsg('tool', e.text); // a line from the app (the iPhone app writes these)
      case 'image': {
        const url = store.url(e.key, e.type);
        const filename = `${e.caption.replace(/[^\w=.-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'view'}.${e.type === 'image/jpeg' ? 'jpg' : 'png'}`;
        const card = addMsg('card image');
        const img = el('img', { src: url, alt: e.caption, title: 'Open full size' });
        img.addEventListener('click', () => openLightbox(url, e.caption, filename));
        card.append(img, el('span', { className: 'card-note', textContent: e.caption }));
        return card;
      }
      case 'card': { // a settled card (live ones are drawn by ask())
        const card = addMsg('card');
        const row = el('div', { className: 'card-actions' }, ...e.labels.map((l) => el('button', { type: 'button', className: 'secondary', textContent: l, disabled: true })));
        if (e.note) row.appendChild(el('span', { className: 'card-note', textContent: e.note }));
        card.append(el('div', { className: 'card-text', textContent: e.text }), row);
        return card;
      }
      case 'download': { // after a reload the file itself is gone (it was downloaded); say how to get it again
        const card = addMsg('card download');
        if (e.text) card.appendChild(el('div', { className: 'card-text', textContent: e.text }));
        card.append(el('span', { className: 'download-gone', textContent: `⤓ ${e.filename}` }), el('span', { className: 'card-note', textContent: `${fmtBytes(e.size)} · downloaded earlier; export again for a new copy` }));
        return card;
      }
      case 'reply': return renderReply(e, live, extra);
      case 'event': return renderEvent(e);
    }
    return null;
  }

  // ---- Cards the assistant puts in the conversation ----
  const pending = new Set(); // cards still waiting for a click; settled as cancelled on Stop / New chat
  function cancelPending() { for (const settle of [...pending]) settle({ cancelled: true }); }

  /**
   * A card with buttons; resolves once one is clicked with { value, result } (result is what the
   * button's run() returned), or { cancelled: true } if the conversation is stopped first. run()
   * is called straight from the click, so it may open a file picker or start a download.
   * buttons: [{ label, value, primary?, run? }]
   */
  function ask(text, buttons) {
    const entry = { t: 'card', text, labels: buttons.map((b) => b.label) };
    entries.push(entry);
    const card = addMsg('card');
    card.appendChild(el('div', { className: 'card-text', textContent: text }));
    const row = el('div', { className: 'card-actions' });
    card.appendChild(row);
    return new Promise((resolve) => {
      const settle = (outcome, note) => {
        pending.delete(settle);
        for (const b of row.querySelectorAll('button')) b.disabled = true;
        entry.note = note ?? (outcome.cancelled ? 'Cancelled' : undefined);
        if (entry.note) row.appendChild(el('span', { className: 'card-note', textContent: entry.note }));
        resolve(outcome);
      };
      pending.add(settle);
      for (const btn of buttons) {
        const b = el('button', { type: 'button', textContent: btn.label, className: btn.primary ? '' : 'secondary' });
        b.addEventListener('click', async () => {
          if (!pending.has(settle)) return;
          for (const x of row.querySelectorAll('button')) x.disabled = true;
          try {
            const result = btn.run ? await btn.run() : undefined;
            // a run() that resolves false was cancelled in the picker
            settle({ value: btn.value, result }, btn.run && result === false ? 'Cancelled' : btn.run ? 'Done' : btn.label);
          } catch (err) { settle({ value: btn.value, error: err?.message ?? String(err) }, err?.message); }
        });
        row.appendChild(b);
      }
    });
  }

  /** A download link in the conversation (the file can be saved again until the page is reloaded). */
  function offerDownload(blob, filename, text = '') {
    entries.push({ t: 'download', filename, size: blob.size, text });
    const url = URL.createObjectURL(blob);
    liveUrls.push(url);
    const card = addMsg('card download');
    if (text) card.appendChild(el('div', { className: 'card-text', textContent: text }));
    const a = el('a', { href: url, download: filename, textContent: `⤓ ${filename}` });
    card.append(a, el('span', { className: 'card-note', textContent: fmtBytes(blob.size) }));
    return a;
  }

  // ---- Images the assistant looked at: thumbnails that open full size ----
  let lightbox = null;
  function openLightbox(url, caption, filename) {
    if (!lightbox) {
      lightbox = el('dialog', { className: 'lightbox' });
      lightbox.innerHTML = '<img alt=""><div class="lightbox-bar"><span class="lightbox-caption"></span><a class="lightbox-save">⤓ Save</a><button type="button" class="secondary">Close</button></div>';
      lightbox.querySelector('button').addEventListener('click', () => lightbox.close());
      lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); }); // backdrop
      document.body.appendChild(lightbox);
    }
    lightbox.querySelector('img').src = url;
    lightbox.querySelector('img').alt = caption;
    lightbox.querySelector('.lightbox-caption').textContent = caption;
    Object.assign(lightbox.querySelector('.lightbox-save'), { href: url, download: filename });
    lightbox.showModal();
  }
  /** data: PNG/JPEG bytes (Uint8Array) or base64 text. */
  function showImage(data, mediaType, caption) {
    const bytes = typeof data === 'string' ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : new Uint8Array(data);
    push({ t: 'image', key: store.put(bytes), type: mediaType, caption });
  }

  // ---- Under a reply: downloads, Undo, and what it changed ----
  let latestDownloads = null; // the newest reply's download buttons; older replies lose theirs (they would export the current model)
  function note(row, text) {
    row.querySelector(':scope > .card-note')?.remove();
    row.appendChild(el('span', { className: 'card-note', textContent: text }));
  }
  function button(row, label, title, onClick) {
    const b = el('button', { type: 'button', className: 'secondary', textContent: label, title });
    b.addEventListener('click', async () => {
      if (agent.busy) return note(row, 'Wait for the assistant to finish.');
      try { await onClick(b); } catch (err) { note(row, err?.message ?? String(err)); }
    });
    row.appendChild(b);
    return b;
  }
  /** Files that differ between two snapshots: [{ name, status: added | removed | changed, added?, removed?, hunks? }] */
  function changesBetween(a, b) {
    const out = [];
    for (const name of [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort()) {
      const x = a.files[name], y = b.files[name];
      if (x === y) continue;
      const status = x === undefined ? 'added' : y === undefined ? 'removed' : 'changed';
      const text = typeof (x ?? y) === 'string';
      if (status === 'changed' && !text && x.byteLength === y.byteLength && new Uint8Array(x).every((v, i) => v === new Uint8Array(y)[i])) continue;
      out.push(text ? { name, status, ...unifiedDiff(x ?? '', y ?? '') } : { name, status, binary: true, size: (y ?? x).byteLength });
    }
    return out;
  }
  function diffView(changes) {
    const box = el('div', { className: 'diff' });
    for (const c of changes) {
      const head = el('div', { className: 'diff-file' }, el('strong', { textContent: c.name }), ` ${c.status}`);
      if (!c.binary) head.append(el('span', { className: 'diff-add', textContent: ` +${c.added}` }), el('span', { className: 'diff-del', textContent: ` −${c.removed}` }));
      else head.append(el('span', { className: 'card-note', textContent: ` · ${fmtBytes(c.size)}` }));
      box.appendChild(head);
      if (c.binary) continue;
      const pre = el('pre');
      for (const h of c.hunks) {
        pre.appendChild(el('span', { className: 'diff-hunk', textContent: h.header + '\n' }));
        for (const l of h.lines) pre.appendChild(el('span', { className: l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : '', textContent: `${l.op}${l.text}\n` }));
      }
      box.appendChild(pre);
    }
    return box;
  }
  function renderReply(e, live, { canExport = false } = {}) {
    const wrap = addMsg('reply');
    const row = el('div', { className: 'actions' });
    wrap.appendChild(row);
    if (live && canExport) {
      latestDownloads = ['stl', '3mf'].map((fmt) => button(row, `⤓ ${fmt.toUpperCase()}`, `Download the model as ${fmt.toUpperCase()}`, () => {
        const f = host.download(fmt);
        note(row, `${f.filename}, ${fmtBytes(f.blob.size)}`);
      }));
    }
    if (!e.changed) return wrap;
    button(row, 'Undo', 'Put the project back as it was before this reply (you can put it back afterwards)', () =>
      restoreTo(e.before, row, { kind: 'undo', reply: e.text },
        (later) => `The user pressed Undo on your reply to ${quote(e.text)}: the project is now exactly as it was before that reply${later ? ' (this also took out every change made since)' : ''}.`));
    const changes = changesBetween(checkpoints[e.before], checkpoints[e.after]);
    const summary = changes.map((c) => c.binary || c.status !== 'changed' ? `${c.name} ${c.status}` : `${c.name} +${c.added} −${c.removed}`).join(', ');
    const toggle = button(row, 'Changes', `Show what this reply changed: ${summary}`, () => {
      const open = wrap.querySelector('.diff');
      if (open) { open.remove(); toggle.textContent = 'Changes'; return; }
      wrap.appendChild(diffView(changes));
      toggle.textContent = 'Hide changes';
    });
    row.appendChild(el('span', { className: 'card-note change-summary', textContent: summary }));
    return wrap;
  }
  const eventText = (e) => (e.kind === 'undo' ? `Undid the reply to ${quote(e.reply)}` : `Redid the reply to ${quote(e.reply)}`);
  function renderEvent(e) {
    const m = addMsg('event');
    m.appendChild(el('span', { textContent: eventText(e) }));
    const undo = e.kind === 'undo';
    const b = button(m, undo ? 'Put back' : 'Undo again', undo ? 'Put back what this undo took out' : 'Undo the reply again', async () => {
      const ok = await restoreTo(e.putBack, m, { kind: undo ? 'redo' : 'undo', reply: e.reply }, () => (undo
        ? `The user put back your reply to ${quote(e.reply)} after undoing it: the project is as it was just before the undo.`
        : `The user undid your reply to ${quote(e.reply)} again.`));
      if (ok) { e.used = true; b.disabled = true; persist(); }
    });
    b.disabled = !!e.used;
    return m;
  }
  /**
   * Restore checkpoint `index`, first keeping the current project as a checkpoint so the restore
   * can be put back (nothing typed by hand since is lost). Adds an event line ({ kind, reply })
   * and tells the model.
   */
  async function restoreTo(index, row, event, modelNote) {
    const target = checkpoints[index], current = host.snapshot();
    if (target.generation !== current.generation) { note(row, 'That was in a different project.'); return false; }
    if (host.sameProject(current, target)) { note(row, 'The project is already like that.'); return false; }
    const later = !isLatestState(index, current); // changed again since that reply (by a later one or by hand)
    checkpoints.push(current);
    await host.restore(target);
    push({ t: 'event', ...event, putBack: checkpoints.length - 1 });
    agent.note(modelNote(later));
    persist();
    return true;
  }
  /** Was `current` exactly the state right after the reply whose before-checkpoint is `index`? */
  function isLatestState(index, current) {
    const reply = entries.find((x) => x.t === 'reply' && x.before === index);
    return !reply || host.sameProject(current, checkpoints[reply.after]);
  }

  // ---- Attachments: shown to the assistant (images, PDFs) or added to the project (STL, SVG, fonts, scripts) ----
  let attached = []; // { file, name, kind: 'image' | 'pdf' | 'file', size, url? }
  let pasteCount = 0;
  /** a: { name, kind, size, url? }; mode: 'pending' (removable) or 'sent' */
  function attachmentChip(a, mode) {
    const chip = el('div', { className: 'attachment', title: a.text ?? a.name });
    if (a.kind === 'ref' || a.kind === 'measure') {
      const icon = el('span', { className: 'att-icon', textContent: a.kind === 'ref' ? '☝' : '📏' });
      if (a.colorHex !== undefined) { icon.style.background = `#${a.colorHex.toString(16).padStart(6, '0')}`; icon.style.color = '#fff'; }
      chip.appendChild(icon);
    } else if (a.kind === 'image' && a.url) {
      const img = el('img', { src: a.url, alt: a.name });
      if (mode === 'sent') img.addEventListener('click', () => openLightbox(a.url, a.name, a.name));
      chip.appendChild(img);
    } else {
      chip.appendChild(el('span', { className: 'att-icon', textContent: (a.name.match(/\.([^.]+)$/)?.[1] ?? '').toUpperCase().slice(0, 4) }));
    }
    chip.appendChild(el('span', { className: 'att-text' },
      el('span', { className: 'att-name', textContent: a.name }),
      el('span', { className: 'att-role', textContent: a.kind === 'file' ? (mode === 'pending' ? 'adds to the project' : 'added to the project')
        : a.kind === 'ref' ? `pointed at in the 3D view${a.color ? ` · ${a.color}` : ''}` : a.kind === 'measure' ? 'measured in the 3D view' : `for the assistant${a.size ? ` · ${fmtBytes(a.size)}` : ''}` })));
    if (mode === 'pending') {
      const x = el('button', { type: 'button', className: 'att-remove', textContent: '×', title: 'Remove' });
      x.addEventListener('click', () => { dropAttached(a); if (a.kind === 'ref') host.removeReference?.(a.id); focusInput(); });
      chip.appendChild(x);
    }
    return chip;
  }
  function dropAttached(a) { attached = attached.filter((b) => b !== a); if (a.url) URL.revokeObjectURL(a.url); renderAttached(); }
  /** A face pointed at, or a measurement, from the 3D view (pointer.js): waits in the composer like an attachment. */
  function addReference(ref) {
    const a = { kind: ref.kind, name: ref.label, text: ref.text, color: ref.color, colorHex: ref.colorHex, id: ref.id, size: 0 };
    attached.push(a);
    ref.setRemoved?.(() => dropAttached(a)); // clicking the face again drops the chip too
    renderAttached();
    log.querySelector('.msg.empty')?.remove();
  }
  function renderAttached() {
    attachRow.textContent = '';
    for (const a of attached) attachRow.appendChild(attachmentChip(a, 'pending'));
    attachRow.hidden = !attached.length;
  }
  function attach(files) {
    const problems = [];
    for (let file of files) {
      const kind = classify(file);
      if (typeof kind !== 'string') { problems.push(kind.error); continue; }
      // pasted screenshots all arrive as "image.png"
      if (kind === 'image' && /^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) file = new File([file], `pasted-${++pasteCount}.${file.name.split('.').pop()}`, { type: file.type });
      attached.push({ file, name: file.name, kind, size: file.size, url: kind === 'image' ? URL.createObjectURL(file) : null });
    }
    renderAttached();
    if (problems.length) addMsg('error', problems.join('\n'));
  }
  /** save_attachment: att is { name, type, key } from agent.attachments */
  async function saveAttachment(att, name, replace) {
    const file = new File([store.get(att.key)], att.name, { type: att.type });
    if (classify(file) !== 'image') throw new Error(`${att.name} is not an image; only images can be saved to the project`);
    const { name: target, buffer } = await projectImage(file, name);
    return host.putFile(target, buffer, { replace });
  }
  root.querySelector('.chat-attach').addEventListener('click', () => { attachInput.value = ''; attachInput.click(); });
  attachInput.addEventListener('change', () => { attach([...attachInput.files]); focusInput(); });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) { e.preventDefault(); attach(files); }
  });
  // Dropping anywhere on the chat panel
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  root.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropHint.hidden = false; });
  root.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  root.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropHint.hidden = true; } });
  root.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropHint.hidden = true;
    attach([...e.dataTransfer.files]);
    focusInput();
  });

  /**
   * Turn the attachments into content blocks and app-event notes for one message. Project files are
   * added here, inside the turn, so the reply's Undo takes them out again. Fills in each shown
   * attachment's blob key on the user entry.
   */
  async function prepareAttachments(list, userEntry) {
    const blocks = [], notes = [];
    const files = list.filter((a) => a.kind === 'file').map((a) => a.file);
    if (files.length) {
      const added = await host.addChatFiles(files);
      const skipped = files.map((f) => f.name).filter((n) => !added.includes(n));
      if (added.length) notes.push(`The user added these files to the project with this message: ${added.join(', ')}. Import them from main.js to use them.`);
      if (skipped.length) notes.push(`The user chose not to add (or replace) ${skipped.join(', ')}.`);
    }
    const refs = list.filter((a) => a.kind === 'ref'), measures = list.filter((a) => a.kind === 'measure');
    if (refs.length) {
      // the view as the user sees it, with the references highlighted in their colours
      const shot = host.referenceSnapshot?.();
      if (shot) {
        const bytes = base64Bytes(shot.data);
        userEntry.atts.push({ name: 'view with references', kind: 'image', size: bytes.length, key: store.put(bytes), type: shot.mediaType });
        blocks.push({ type: 'text', text: `The user pointed at ${refs.length === 1 ? 'a surface' : `${refs.length} surfaces`} in the 3D view. This is their view, with ${refs.length === 1 ? 'it' : 'each'} highlighted (${refs.map((r, i) => `reference ${i + 1} ${r.color}`).join(', ')}); "this" or "here" in their message means ${refs.length === 1 ? 'reference 1' : 'these'}.` },
          { type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.data } });
      }
      refs.forEach((r, i) => blocks.push({ type: 'text', text: `Reference ${i + 1} (${r.color}): ${r.text}` }));
      host.clearReferences?.();
    }
    for (const m of measures) blocks.push({ type: 'text', text: `The user measured in the 3D view, ${m.text}` });
    for (const [i, a] of list.entries()) {
      if (a.kind !== 'image' && a.kind !== 'pdf') continue;
      const bytes = new Uint8Array(await a.file.arrayBuffer());
      const att = { name: a.name, type: a.file.type || (a.kind === 'pdf' ? 'application/pdf' : 'image/png'), key: store.put(bytes) };
      userEntry.atts[i].key = att.key; userEntry.atts[i].type = att.type;
      const n = agent.addAttachment(att);
      if (a.kind === 'image') {
        const img = await prepareImage(a.file);
        const size = `${img.source.width}×${img.source.height} px${img.width !== img.source.width ? `, shown at ${img.width}×${img.height}` : ''}`;
        blocks.push({ type: 'text', text: `Attachment ${n}: ${a.name} (image, ${size})` }, { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      } else {
        blocks.push({ type: 'text', text: `Attachment ${n}: ${a.name} (PDF)` }, { type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: bytesToBase64(bytes) } });
      }
    }
    return { blocks, notes };
  }

  function showEmpty() {
    if (!log.children.length) addMsg('empty', settings.apiKey
      ? 'Describe what you want to build or change. The assistant edits the script, builds it, and checks the result.'
      : 'Set your Anthropic API key in Assistant settings to start.');
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if ((!text && !attached.length) || agent.busy) return;
    if (!settings.apiKey) { openSettings(); return; }
    log.querySelector('.msg.empty')?.remove();
    const sending = attached;
    if (!text && sending.every((a) => a.kind === 'ref' || a.kind === 'measure')) { input.focus(); return; } // say what to do with what you pointed at
    attached = []; renderAttached();
    for (const a of sending) if (a.url) liveUrls.push(a.url);
    const chipOf = (a) => ({ name: a.name, kind: a.kind, size: a.size, ...(a.color ? { color: a.color, colorHex: a.colorHex } : {}) });
    const userEntry = { t: 'user', text, atts: sending.map(chipOf) };
    entries.push(userEntry);
    const userEl = renderEntry({ ...userEntry, atts: sending.map((a) => ({ ...chipOf(a), url: a.url })) });
    input.value = '';
    send.disabled = true; stop.hidden = false;
    let reply = null; // the assistant entry being streamed, and its element
    const turn = { text: text || sending.map((a) => a.name).join(', '), before: host.snapshot() };
    try {
      const extra = await prepareAttachments(sending, userEntry);
      const view = userEntry.atts.find((a) => a.name === 'view with references');
      if (view) userEl.querySelector('.msg-attachments')?.appendChild(attachmentChip({ ...view, url: store.url(view.key, view.type) }, 'sent'));
      await agent.send(text || '(see the attachments)', {
        onText: (delta) => {
          if (!reply) { const entry = { t: 'assistant', text: '' }; reply = { entry, el: push(entry) }; }
          reply.entry.text += delta;
          renderMarkdown(reply.el, reply.entry.text);
          log.scrollTop = log.scrollHeight;
        },
        onTool: (name) => { reply = null; push({ t: 'tool', name }); },
        onDone: (final) => { if (final?.stop_reason === 'refusal') push({ t: 'error', text: 'The model declined this request.' }); },
      }, extra);
    } catch (err) {
      cancelPending();
      // the message was dropped from the conversation: put what it showed back, ready to send again
      // (project files were added already and stay; their names are in the project the next message carries)
      const shown = sending.filter((a) => a.kind !== 'file');
      if (shown.length) { attached = [...shown, ...attached]; renderAttached(); }
      push({ t: 'error', text: describeAgentError(err) });
      if (err instanceof Error && /API key/.test(err.message)) openSettings();
    } finally {
      try { endTurn(turn); } catch (err) { console.error(err); }
      send.disabled = false; stop.hidden = true;
      if (touch) input.blur(); else input.focus(); // on a phone, drop the keyboard so the result shows
    }
  });
  /** After a reply: checkpoint what it changed, put the actions under it, keep the conversation. */
  function endTurn(turn) {
    const after = host.snapshot();
    const sameFile = turn.before.generation === after.generation; // a reply that opened or started another project has nothing to undo into
    const changed = sameFile && !host.sameProject(turn.before, after);
    const canExport = host.canExport();
    latestDownloads?.forEach((b) => b.remove());
    latestDownloads = null;
    if (changed || canExport) {
      const e = { t: 'reply', text: turn.text, changed };
      if (changed) { checkpoints.push(turn.before, after); e.before = checkpoints.length - 2; e.after = checkpoints.length - 1; }
      entries.push(e);
      renderEntry(e, true, { canExport });
    }
    persist();
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  stop.addEventListener('click', () => { cancelPending(); agent.stop(); });
  root.querySelector('.chat-new').addEventListener('click', () => {
    if (entries.length && !confirm('Start a new chat? This conversation and its undo points are cleared (a saved project file keeps its copy until you save it again).')) return;
    reset();
    host.clearReferences?.();
    for (const a of attached) if (a.url) URL.revokeObjectURL(a.url);
    attached = []; renderAttached();
    persist();
    showEmpty();
  });

  // Settings dialog
  for (const [id, label] of MODELS) dialogForm.elements.model.appendChild(el('option', { value: id, textContent: label }));
  function openSettings() {
    dialogForm.elements.apiKey.value = settings.apiKey || '';
    dialogForm.elements.model.value = settings.model || DEFAULT_MODEL;
    dialogForm.elements.keepInFile.checked = keepInFile();
    dialogForm.querySelector('[data-cancel]').onclick = () => dialog.close('cancel');
    dialog.showModal();
    dialogForm.elements.apiKey.focus();
  }
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'ok') return;
    settings.apiKey = dialogForm.elements.apiKey.value.trim();
    settings.model = dialogForm.elements.model.value;
    const keep = dialogForm.elements.keepInFile.checked;
    const keepChanged = keep !== keepInFile();
    settings.keepInFile = keep;
    saveSettings();
    applySettings();
    if (keepChanged) { revision++; onChange(); } // what the next save writes has changed
    log.querySelector('.msg.empty')?.remove();
    if (!root.hidden) showEmpty();
  });
  showEmpty();

  return {
    openSettings, ask, offerDownload, addReference,
    /** Called by the tab bar when the Assistant tab is shown. */
    focus: () => { showEmpty(); focusInput(); },
    get busy() { return agent.busy; },
    /** A promise of the archive entries for the project file ({ path: bytes }), or of null when there is nothing to keep. */
    archive: async () => {
      if (!keepInFile() || !entries.length) return null;
      const { json, blobs } = toFormat2();
      return host.packConversation(json, blobs);
    },
    /** Changes whenever archive() would. */
    token: () => (keepInFile() ? String(revision) : ''),
    /**
     * A project was opened or started: show the conversation saved in it (archive extras), or a new
     * chat. Not while the assistant is working (it opened the project itself, and carries on).
     * Returns true when the file brought a conversation.
     */
    async loadArchive(extras) {
      if (agent.busy) return false;
      let state = null, problem = null;
      const hasOne = Object.keys(extras ?? {}).some((k) => k.startsWith('.assistant/'));
      if (hasOne) {
        try { state = await host.unpackConversation(extras); } catch (err) { problem = err?.message ?? String(err); }
      }
      if (agent.busy) return false; // the assistant started working while the file was read
      if (state) loadFormat2(state); else load(null);
      if (problem) { log.querySelector('.msg.empty')?.remove(); push({ t: 'error', text: `The conversation saved in this file could not be read: ${problem}` }); }
      persist();
      return entries.length > 0;
    },
    /** Bring back the conversation kept in this browser (after a reload). */
    async restoreLocal() {
      let state = null;
      try { state = await loadLocal(); } catch (err) { console.warn('Could not read the kept conversation:', err); }
      if (state && !entries.length && !agent.busy) load(state);
    },
    /** Forget the conversation kept in this browser (the page opened a different project). */
    forgetLocal: () => clearLocal().catch(() => {}),
  };
}
