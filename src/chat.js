/**
 * Assistant chat panel and its settings dialog. Wraps an Agent and renders
 * the streamed conversation; the API key and model live in localStorage.
 */
import { Agent, MODELS, DEFAULT_MODEL, describeAgentError } from './agent.js';

const SETTINGS_KEY = 'temencad.assistant';
const TOOL_LABELS = { read_script: 'Reading the script', edit_script: 'Editing the script', write_script: 'Writing the script', remove_file: 'Removing a file', rename_file: 'Renaming a file', run_model: 'Building the model', take_screenshot: 'Taking a screenshot' };

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

  const agent = new Agent(host);
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
    try {
      await agent.send(text, {
        onText: (delta) => { streamed += delta; renderMarkdown(ensureBubble(), streamed); log.scrollTop = log.scrollHeight; },
        onTool: (name) => { bubble = null; streamed = ''; addMsg('tool', `${TOOL_LABELS[name] ?? name}…`); },
        onDone: (final) => { if (final?.stop_reason === 'refusal') addMsg('error', 'The model declined this request.'); },
      });
    } catch (err) {
      addMsg('error', describeAgentError(err));
      if (err instanceof Error && /API key/.test(err.message)) openSettings();
    } finally {
      send.disabled = false; stop.hidden = true;
      input.focus();
    }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  stop.addEventListener('click', () => agent.stop());
  root.querySelector('.chat-new').addEventListener('click', () => { if (agent.busy) agent.stop(); agent.reset(); log.textContent = ''; showEmpty(); });

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
  return { openSettings, focus };
}
