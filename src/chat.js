/**
 * Assistant chat panel and its settings dialog. Wraps an Agent and renders
 * the streamed conversation; the API key and model live in localStorage.
 */
import { Agent, MODELS, DEFAULT_MODEL, describeAgentError } from './agent.js';

const SETTINGS_KEY = 'temencad.assistant';
const TOOL_LABELS = {
  read_script: 'Reading the script', edit_script: 'Editing the script', write_script: 'Writing the script', remove_file: 'Removing a file',
  rename_file: 'Renaming a file', run_model: 'Building the model', take_screenshot: 'Taking a screenshot', render_views: 'Rendering views',
  new_project: 'Starting a new project', open_project: 'Opening a project', save_project: 'Saving the project', export_model: 'Exporting',
  share_project: 'Preparing to share', set_view: 'Changing the view', set_plate: 'Setting the build plate', set_part_display: 'Changing part display',
  set_autorun: 'Changing auto-run', search_catalog: 'Searching the catalogue', add_from_catalog: 'Adding from the catalogue', add_files: 'Adding files',
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
 *   root: #chat element, host: Agent host callbacks (listFiles, getScript, setScript, removeFile, renameFile,
 *   runAndWait, lastReport, screenshot)
 */
export function initChat({ root, host }) {
  const log = root.querySelector('.chat-log');
  const form = root.querySelector('.chat-form');
  const input = root.querySelector('.chat-input');
  const send = root.querySelector('.chat-send');
  const stop = root.querySelector('.chat-stop');
  const modelEl = root.querySelector('.chat-model');
  const dialog = document.getElementById('assistant-dialog');
  const dialogForm = document.getElementById('assistant-form');

  const settings = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } })();
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

  const agent = new Agent({ ...host, showImage });
  function applySettings() {
    agent.configure({ apiKey: settings.apiKey, model: settings.model || DEFAULT_MODEL });
    modelEl.textContent = settings.apiKey ? (MODELS.find((m) => m[0] === agent.model)?.[1] ?? agent.model) : 'No API key set';
  }
  applySettings();

  function addMsg(cls, text = '') {
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  // ---- Cards the assistant puts in the conversation ----
  const pending = new Set(); // cards still waiting for a click; settled as cancelled on Stop / New chat
  const downloads = [];      // object URLs behind download links, revoked on New chat
  function cancelPending() { for (const settle of [...pending]) settle({ cancelled: true }); }

  /**
   * A card with buttons; resolves once one is clicked with { value, result } (result is what the
   * button's run() returned), or { cancelled: true } if the conversation is stopped first. run()
   * is called straight from the click, so it may open a file picker or start a download.
   * buttons: [{ label, value, primary?, run? }]
   */
  function ask(text, buttons) {
    const card = addMsg('card');
    card.appendChild(Object.assign(document.createElement('div'), { className: 'card-text', textContent: text }));
    const row = Object.assign(document.createElement('div'), { className: 'card-actions' });
    card.appendChild(row);
    return new Promise((resolve) => {
      const settle = (outcome, note) => {
        pending.delete(settle);
        for (const b of row.querySelectorAll('button')) b.disabled = true;
        if (note) row.appendChild(Object.assign(document.createElement('span'), { className: 'card-note', textContent: note }));
        resolve(outcome);
      };
      pending.add(settle);
      for (const btn of buttons) {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: btn.label, className: btn.primary ? '' : 'secondary' });
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
    }).then((outcome) => { if (outcome.cancelled) row.appendChild(Object.assign(document.createElement('span'), { className: 'card-note', textContent: 'Cancelled' })); return outcome; });
  }

  /** A download link in the conversation (the file can be saved again later). */
  function offerDownload(blob, filename, text = '') {
    const url = URL.createObjectURL(blob);
    downloads.push(url);
    const card = addMsg('card download');
    if (text) card.appendChild(Object.assign(document.createElement('div'), { className: 'card-text', textContent: text }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename, textContent: `⤓ ${filename}` });
    card.append(a, Object.assign(document.createElement('span'), { className: 'card-note', textContent: fmtBytes(blob.size) }));
    return a;
  }

  // ---- Images the assistant looked at: thumbnails that open full size ----
  let lightbox = null;
  function openLightbox(url, caption, filename) {
    if (!lightbox) {
      lightbox = Object.assign(document.createElement('dialog'), { className: 'lightbox' });
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
    const bytes = typeof data === 'string' ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : data;
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    downloads.push(url);
    const filename = `${caption.replace(/[^\w=.-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'view'}.${mediaType === 'image/jpeg' ? 'jpg' : 'png'}`;
    const card = addMsg('card image');
    const img = Object.assign(document.createElement('img'), { src: url, alt: caption, title: 'Open full size' });
    img.addEventListener('click', () => openLightbox(url, caption, filename));
    card.append(img, Object.assign(document.createElement('span'), { className: 'card-note', textContent: caption }));
  }

  // ---- Actions under a reply: download the result, undo / redo what the reply changed ----
  let latestDownloads = null; // the newest reply's download buttons; older replies lose theirs (they would export the current model)
  function note(row, text) {
    row.querySelector('.card-note')?.remove();
    row.appendChild(Object.assign(document.createElement('span'), { className: 'card-note', textContent: text }));
  }
  function button(row, label, title, onClick) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: label, title });
    b.addEventListener('click', async () => {
      if (agent.busy) return note(row, 'Wait for the assistant to finish.');
      try { await onClick(b); } catch (err) { note(row, err?.message ?? String(err)); }
    });
    row.appendChild(b);
    return b;
  }
  function addReplyActions(turn) {
    const after = host.snapshot();
    const sameFile = turn.before.generation === after.generation; // a reply that opened or started another project has nothing to undo into
    const changed = sameFile && !host.sameProject(turn.before, after);
    const canExport = host.canExport();
    latestDownloads?.forEach((b) => b.remove());
    latestDownloads = null;
    if (!changed && !canExport) return;
    const row = addMsg('actions');
    if (canExport) {
      latestDownloads = ['stl', '3mf'].map((fmt) => button(row, `⤓ ${fmt.toUpperCase()}`, `Download the model as ${fmt.toUpperCase()}`, () => {
        const f = host.download(fmt);
        note(row, `${f.filename}, ${fmtBytes(f.blob.size)}`);
      }));
    }
    if (!changed) return;
    const quoted = `"${turn.text.length > 80 ? turn.text.slice(0, 77) + '…' : turn.text}"`;
    let undone = false;
    button(row, 'Undo', 'Put the project back as it was before this reply', async (b) => {
      if (!undone) {
        const later = !host.sameProject(host.snapshot(), after); // changed again since (by a later reply or by hand)
        b.disabled = true;
        await host.restore(turn.before);
        undone = true;
        b.textContent = 'Redo'; b.title = 'Put back what this reply changed'; b.disabled = false;
        note(row, later ? 'Back to how it was before this reply' : 'Undone');
        agent.note(`The user pressed Undo on your reply to ${quoted}: the project is now exactly as it was before that reply${later ? ' (this replaced every change made since)' : ''}.`);
      } else {
        if (!host.sameProject(host.snapshot(), turn.before)) { b.disabled = true; return note(row, 'The project has changed since the undo, so it can\'t be redone.'); }
        b.disabled = true;
        await host.restore(after);
        undone = false;
        b.textContent = 'Undo'; b.title = 'Put the project back as it was before this reply'; b.disabled = false;
        note(row, 'Redone');
        agent.note(`The user pressed Redo on your reply to ${quoted}: its changes are back.`);
      }
    });
  }

  function showEmpty() {
    if (!log.children.length) addMsg('empty', settings.apiKey
      ? 'Describe what you want to build or change. The assistant edits the script, builds it, and checks the result.'
      : 'Set your Anthropic API key in Assistant settings to start.');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || agent.busy) return;
    if (!settings.apiKey) { openSettings(); return; }
    log.querySelector('.msg.empty')?.remove();
    addMsg('user', text);
    input.value = '';
    send.disabled = true; stop.hidden = false;
    let bubble = null;
    const ensureBubble = () => bubble ?? (bubble = addMsg('assistant'));
    let streamed = '';
    const turn = { text, before: host.snapshot() };
    try {
      await agent.send(text, {
        onText: (delta) => { streamed += delta; renderMarkdown(ensureBubble(), streamed); log.scrollTop = log.scrollHeight; },
        onTool: (name) => { bubble = null; streamed = ''; addMsg('tool', `${TOOL_LABELS[name] ?? name}…`); },
        onDone: (final) => { if (final?.stop_reason === 'refusal') addMsg('error', 'The model declined this request.'); },
      });
    } catch (err) {
      cancelPending();
      addMsg('error', describeAgentError(err));
      if (err instanceof Error && /API key/.test(err.message)) openSettings();
    } finally {
      try { addReplyActions(turn); } catch (err) { console.error(err); }
      send.disabled = false; stop.hidden = true;
      input.focus();
    }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  stop.addEventListener('click', () => { cancelPending(); agent.stop(); });
  root.querySelector('.chat-new').addEventListener('click', () => {
    cancelPending();
    if (agent.busy) agent.stop();
    agent.reset();
    for (const u of downloads.splice(0)) URL.revokeObjectURL(u);
    log.textContent = '';
    latestDownloads = null;
    showEmpty();
  });

  // Settings dialog
  for (const [id, label] of MODELS) dialogForm.elements.model.appendChild(Object.assign(document.createElement('option'), { value: id, textContent: label }));
  function openSettings() {
    dialogForm.elements.apiKey.value = settings.apiKey || '';
    dialogForm.elements.model.value = settings.model || DEFAULT_MODEL;
    dialogForm.querySelector('[data-cancel]').onclick = () => dialog.close('cancel');
    dialog.showModal();
    dialogForm.elements.apiKey.focus();
  }
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'ok') return;
    settings.apiKey = dialogForm.elements.apiKey.value.trim();
    settings.model = dialogForm.elements.model.value;
    saveSettings();
    applySettings();
    log.querySelector('.msg.empty')?.remove();
    if (!root.hidden) showEmpty();
  });
  showEmpty();

  /** Called by the tab bar when the Assistant tab is shown. */
  const focus = () => { showEmpty(); input.focus(); };
  return { openSettings, focus, ask, offerDownload };
}
