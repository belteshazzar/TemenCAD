/**
 * Chat assistant that edits the model script. Runs in the browser with the
 * user's own Anthropic API key (bring-your-own-key; nothing is proxied).
 *
 * The agent never drives the UI directly: it reads and edits the script,
 * builds it, and reads the same diagnostics the user sees.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import apiHtml from '../api.html?raw';

export const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (default)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster, cheaper)'],
];
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Plain-text API reference derived from api.html so the two never drift. */
function referenceText() {
  const body = apiHtml.slice(apiHtml.indexOf('<main'), apiHtml.indexOf('</main>'));
  return body
    .replace(/<h2[^>]*>/g, '\n# ').replace(/<h3[^>]*>/g, '\n## ')
    .replace(/<pre[^>]*>/g, '\n```\n').replace(/<\/pre>/g, '\n```\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

const SYSTEM = `You are the modelling assistant inside TemenCAD, a browser app where a JavaScript script describes a 3D model for 3D printing. The user types plain English; you change the script so the model matches, then build it and check the result.

How to work:
- The current script and the last build report are included with every user message. Read them before deciding what to change.
- Make the smallest edit that does the job with edit_script (exact-match replacement). Use write_script only for new models or large rewrites.
- After every change call run_model and read the report. Fix any error or warning it reports (they include line numbers) before replying. If the report says the model does not fit the plate, tell the user rather than silently shrinking their design.
- Use take_screenshot when the shape of the result matters and the build report can't confirm it (first version of a new model, visual arrangement, anything you are unsure of).
- Keep designs parametric: declare dimensions at the top of the script with \`const WALL = variable('Wall thickness', 1.6, 0.8, 4, 0.1)\` (label, value, min, max, step) so they appear as sliders; \`variable('Label', true)\` makes a checkbox. Return parts as an object so they are named: \`return { body, lid }\`.
- Units are millimetres, Y is up, the build plate is y = 0, +Z is the front. Put parts on the plate with .onPlate(). Screw cutters have their top at y = 0; translate them to the top face of the part before subtracting.
- Work in the style of the existing script. Don't rename or restructure things the user didn't ask about.
- Reply briefly in plain prose: what you changed and anything the user should decide. No code in the reply unless asked; the script is already visible in the editor. Never claim a build succeeded unless run_model said so.

The complete API reference follows. Only these functions exist; do not invent others.

${referenceText()}`;

const TOOL_DESCRIPTIONS = {
  read_script: 'Return the full current script. Usually unnecessary because the script is included with each user message; use it after your own edits if you need to re-read.',
  edit_script: 'Replace one exact occurrence of old_text with new_text in the script. old_text must match exactly once (include enough surrounding lines to be unique). Preferred for all changes.',
  write_script: 'Replace the entire script. Use for a brand-new model or a complete rewrite only.',
  run_model: 'Build the current script and return the report: parts (name, size, volume), warnings and errors with line numbers, and whether it fits the selected build plate.',
  take_screenshot: 'Render the current 3D view and return it as an image, with the camera framing the model. Optional view: iso, top, front, right, left, back.',
};

export class Agent {
  /**
   * @param {object} host  callbacks into the app:
   *   getScript(), setScript(text), runAndWait() -> report object, screenshot(view) -> { dataUrl, mediaType, data },
   *   lastReport() -> report object | null
   */
  constructor(host) {
    this.host = host;
    this.messages = [];
    this.client = null;
    this.abort = null;
  }

  configure({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.client = apiKey ? new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) : null;
  }

  reset() { this.messages = []; }

  get busy() { return !!this.abort; }

  stop() { this.abort?.abort(); }

  tools() {
    const host = this.host;
    const str = (v, name) => { if (typeof v !== 'string') throw new Error(`${name} must be a string`); return v; };
    return [
      betaTool({
        name: 'read_script', description: TOOL_DESCRIPTIONS.read_script,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => host.getScript(),
      }),
      betaTool({
        name: 'edit_script', description: TOOL_DESCRIPTIONS.edit_script,
        eager_input_streaming: true,
        inputSchema: {
          type: 'object',
          properties: { old_text: { type: 'string' }, new_text: { type: 'string' } },
          required: ['old_text', 'new_text'], additionalProperties: false,
        },
        run: async ({ old_text, new_text }) => {
          str(old_text, 'old_text'); str(new_text, 'new_text');
          const src = host.getScript();
          const first = src.indexOf(old_text);
          if (first < 0) return 'Error: old_text was not found in the script. Re-read the script and match it exactly (whitespace included).';
          if (src.indexOf(old_text, first + 1) >= 0) return 'Error: old_text occurs more than once; include more surrounding context so it is unique.';
          host.setScript(src.slice(0, first) + new_text + src.slice(first + old_text.length));
          return 'Edited. Call run_model to build and check.';
        },
      }),
      betaTool({
        name: 'write_script', description: TOOL_DESCRIPTIONS.write_script,
        eager_input_streaming: true,
        inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'], additionalProperties: false },
        run: async ({ script }) => { str(script, 'script'); host.setScript(script); return 'Script replaced. Call run_model to build and check.'; },
      }),
      betaTool({
        name: 'run_model', description: TOOL_DESCRIPTIONS.run_model,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => JSON.stringify(await host.runAndWait(), null, 1),
      }),
      betaTool({
        name: 'take_screenshot', description: TOOL_DESCRIPTIONS.take_screenshot,
        inputSchema: { type: 'object', properties: { view: { type: 'string', enum: ['iso', 'top', 'front', 'right', 'left', 'back'] } }, additionalProperties: false },
        run: async ({ view }) => {
          const shot = await host.screenshot(view || 'iso');
          return [
            { type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.data } },
            { type: 'text', text: `Screenshot from the ${view || 'iso'} view. Y is up; the blue plate edge is the front.` },
          ];
        },
      }),
    ];
  }

  /** Context appended to every user turn so the model always sees the live script. */
  turnContext() {
    const report = this.host.lastReport();
    return `\n\n<current_script>\n${this.host.getScript()}\n</current_script>\n\n<last_build>\n${report ? JSON.stringify(report, null, 1) : 'not built yet'}\n</last_build>`;
  }

  /**
   * Send a user message and stream the reply.
   * events: onText(delta), onTool(name), onDone(finalMessage), onError(err)
   */
  async send(text, events) {
    if (!this.client) throw new Error('No API key set. Open Assistant settings and paste your Anthropic API key.');
    if (this.busy) throw new Error('The assistant is still working.');
    this.abort = new AbortController();
    const before = [...this.messages];
    this.messages.push({ role: 'user', content: text + this.turnContext() });

    const params = {
      model: this.model,
      max_tokens: 32000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: this.tools(),
      messages: this.messages,
      thread: false, // we keep the full history ourselves
      max_iterations: 24,
      stream: true,
    };
    let runner = this.client.beta.messages.toolRunner(params, { signal: this.abort.signal });
    let final = null;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          for await (const messageStream of runner) {
            for await (const event of messageStream) {
              if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') events.onTool?.(event.content_block.name);
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') events.onText?.(event.delta.text);
            }
            const message = await messageStream.finalMessage();
            attempt = 0;
            final = message;
            const hasToolUse = message.content.some((b) => b.type === 'tool_use');
            if (message.stop_reason === 'max_tokens' && hasToolUse) throw Object.assign(new Error('The reply was cut off (max_tokens) while writing a tool call.'), { fatal: true });
            if (message.stop_reason === 'refusal') break;
          }
          break;
        } catch (err) {
          if (err instanceof Anthropic.APIError || err?.fatal || err?.name === 'AbortError' || attempt >= 2) throw err;
          runner = this.client.beta.messages.toolRunner({ ...runner.params }, { signal: this.abort.signal });
        }
      }
      // The runner appended the assistant/tool turns to params.messages as it went; keep that history.
      this.messages = [...runner.params.messages];
      events.onDone?.(final);
      return final;
    } catch (err) {
      // Drop the half-finished turn so the next message starts clean.
      this.messages = before;
      events.onError?.(err);
      throw err;
    } finally {
      this.abort = null;
    }
  }
}

/** Human-readable error text, using the SDK's typed errors. */
export function describeAgentError(err) {
  if (err?.name === 'AbortError') return 'Stopped.';
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in Assistant settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This key is not allowed to use that model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the API. Wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your connection.';
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err?.message ?? String(err);
}
