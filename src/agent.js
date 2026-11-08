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

import { referenceFromHtml } from './api-text.js';

const referenceText = () => referenceFromHtml(apiHtml);

const SYSTEM = `You are the modelling assistant inside TemenCAD, a browser app where a JavaScript script describes a 3D model for 3D printing. The user types plain English; you change the script so the model matches, then build it and check the result.

How to work:
- The project's files and the last build report are included with every user message. Read them before deciding what to change. main.js is the entry script; other .js files are ES modules it imports (\`import { lid } from './lid.js'\`, \`export const lid = ...\`). Fonts (.ttf/.otf), meshes (.stl) and images (.png/.jpg) in the project are imported the same way: \`import logo from './Logo.ttf'\` gives a font name for text(), \`import part from './part.stl'\` gives a Shape, \`import photo from './photo.png'\` gives an image for heightmap() and lithophane().
- Make the smallest edit that does the job with edit_script (exact-match replacement; pass \`file\` for anything other than main.js). Use write_script only for new models, new files or large rewrites. To split a model into modules, write_script a new .js file name (it is created) and import it from main.js; remove_file and rename_file manage script files. Fonts, meshes and images can only be added by the user.
- After every change call run_model and read the report. Fix any error or warning it reports (they include line numbers) before replying. If the report says the model does not fit the plate, tell the user rather than silently shrinking their design.
- Use render_views when the shape of the result matters and the build report can't confirm it (first version of a new model, visual arrangement, fit against a ghost reference, anything you are unsure of): it returns labelled views (part names, sizes, scale bar, axes) with ghosts translucent, and can cut the model open with a section. take_screenshot gives the live 3D view instead.
- Keep designs parametric: declare dimensions as named constants at the top of the script. Return parts as an object so they are named: \`return { body, lid }\`.
- Units are millimetres, Y is up, the build plate is y = 0, +Z is the front. Put parts on the plate with .onPlate(). Screw cutters have their top at y = 0; translate them to the top face of the part before subtracting.
- Design for printing. Horizontal holes should be hole() cutters (teardrop by default) rather than plain cylinders; use { flat } when the hole is close to a surface. Counterbored or countersunk holes printed head-down can take { bridge: 0.2 }. Where a boss or wall meets a plate, a concave fillet (s.fillet(r, { edges: 'concave' })) adds strength; top-edge fillets or chamfers (edges: 'top') soften parts; bottom chamfers avoid elephant's foot. Use sweep() along a path for handles, hooks, channels and springs rather than many unions; heightmap() and lithophane() for pictures the user adds as .png/.jpg files.
- Work in the style of the existing script. Don't rename or restructure things the user didn't ask about.
- Write scripts in the strict JavaScript subset the TemenCAD engine runs, so they work in every host (browser, CLI and phone). Use: \`let\`/\`const\`, functions and arrow functions with default and rest parameters, closures, object and array literals, destructuring and spread, template literals, \`if\`/\`for\`/\`for...of\`/\`while\`/\`switch\`, \`try\`/\`catch\`, regular expressions, \`async\`/\`await\` and ES module \`import\`/\`export\`. Never use: \`class\`, \`var\`, \`for...in\`, generators (\`function*\`/\`yield\`), \`eval\` or the \`Function\` constructor, \`Proxy\`, \`Reflect\`, \`Symbol\`, typed arrays or \`ArrayBuffer\`, \`Intl\`, \`with\`, labels, \`__proto__\`, \`instanceof\` (a syntax error), getters/setters in object literals, object rest in destructuring (\`const { a, ...rest } = o\`), \`flatMap\`, or \`Array.from({ length: n })\` (build arrays with a counted \`for\` loop and \`push\`, or map an existing array). Group related helpers as plain functions or object literals rather than classes. Do not rewrite existing code that already follows these rules.
- Reply briefly in plain prose: what you changed and anything the user should decide. No code in the reply unless asked; the script is already visible in the editor. Never claim a build succeeded unless run_model said so.

The complete API reference follows. Only these functions exist; do not invent others.

${referenceText()}`;

const TOOL_DESCRIPTIONS = {
  read_script: 'Return the full text of a script file (default main.js). Usually unnecessary because the files are included with each user message; use it after your own edits if you need to re-read.',
  edit_script: 'Replace one exact occurrence of old_text with new_text in a script file (default main.js). old_text must match exactly once (include enough surrounding lines to be unique). Preferred for all changes.',
  write_script: 'Replace the entire text of a script file, creating it if it does not exist (default main.js). Use for a brand-new model, a new module file, or a complete rewrite only.',
  run_model: 'Build the current script and return the report: parts (name, size, volume), warnings and errors with line numbers, and whether it fits the selected build plate.',
  remove_file: 'Delete a script file from the project. main.js, fonts and meshes cannot be removed. Update any imports of it first.',
  rename_file: 'Rename a script file in the project (e.g. to move it into a folder). main.js, fonts and meshes cannot be renamed. Update any imports of it afterwards.',
  take_screenshot: 'Render the current 3D view and return it as an image, with the camera framing the model. Optional view: iso, top, front, right, left, back.',
  render_views: 'Render the last build as a sheet of labelled views (part names, sizes in each view, scale bar, axes; ghost parts translucent). views: a list from iso, top, bottom, front, back, left, right (default iso, top, front, right). section: { axis, value } cuts the model open at that plane (y keeps what is below; x and z keep the negative side) and paints cut faces red. Build with run_model first.',
};

export class Agent {
  /**
   * @param {object} host  callbacks into the app:
   *   listFiles(), getScript(file), setScript(file, text), removeFile(file), renameFile(file, to) -> name,
   *   runAndWait() -> report object, screenshot(view) -> { dataUrl, mediaType, data }, renderViews(opts) -> Uint8Array (PNG),
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
        inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Project file name, e.g. main.js or lib/part.js' } }, additionalProperties: false },
        run: async ({ file }) => { const text = host.getScript(file || 'main.js'); return typeof text === 'string' ? text : `Error: no script file named ${file}. Files: ${host.listFiles().join(', ')}`; },
      }),
      betaTool({
        name: 'edit_script', description: TOOL_DESCRIPTIONS.edit_script,
        eager_input_streaming: true,
        inputSchema: {
          type: 'object',
          properties: { file: { type: 'string', description: 'Project file name (default main.js)' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
          required: ['old_text', 'new_text'], additionalProperties: false,
        },
        run: async ({ file, old_text, new_text }) => {
          str(old_text, 'old_text'); str(new_text, 'new_text');
          const name = file || 'main.js';
          const src = host.getScript(name);
          if (typeof src !== 'string') return `Error: no script file named ${name}. Files: ${host.listFiles().join(', ')}`;
          const first = src.indexOf(old_text);
          if (first < 0) return `Error: old_text was not found in ${name}. Re-read the file and match it exactly (whitespace included).`;
          if (src.indexOf(old_text, first + 1) >= 0) return 'Error: old_text occurs more than once; include more surrounding context so it is unique.';
          host.setScript(name, src.slice(0, first) + new_text + src.slice(first + old_text.length));
          return `Edited ${name}. Call run_model to build and check.`;
        },
      }),
      betaTool({
        name: 'write_script', description: TOOL_DESCRIPTIONS.write_script,
        eager_input_streaming: true,
        inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Project file name (default main.js); a new .js name creates the file' }, script: { type: 'string' } }, required: ['script'], additionalProperties: false },
        run: async ({ file, script }) => {
          str(script, 'script');
          const name = file || 'main.js';
          if (!/\.(js|mjs)$/i.test(name)) return 'Error: write_script can only write .js files.';
          host.setScript(name, script);
          return `Wrote ${name}. Call run_model to build and check.`;
        },
      }),
      betaTool({
        name: 'remove_file', description: TOOL_DESCRIPTIONS.remove_file,
        inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false },
        run: async ({ file }) => {
          str(file, 'file');
          if (!/\.(js|mjs)$/i.test(file)) return 'Error: only script files can be removed.';
          try { host.removeFile(file); } catch (e) { return `Error: ${e.message}`; }
          return `Removed ${file}. Files: ${host.listFiles().join(', ')}`;
        },
      }),
      betaTool({
        name: 'rename_file', description: TOOL_DESCRIPTIONS.rename_file,
        inputSchema: { type: 'object', properties: { file: { type: 'string' }, new_name: { type: 'string' } }, required: ['file', 'new_name'], additionalProperties: false },
        run: async ({ file, new_name }) => {
          str(file, 'file'); str(new_name, 'new_name');
          if (!/\.(js|mjs)$/i.test(file) || !/\.(js|mjs)$/i.test(new_name)) return 'Error: only script files can be renamed, and the new name must end in .js.';
          let name;
          try { name = host.renameFile(file, new_name); } catch (e) { return `Error: ${e.message}`; }
          return `Renamed ${file} to ${name}. Update imports that referred to it. Files: ${host.listFiles().join(', ')}`;
        },
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
      betaTool({
        name: 'render_views', description: TOOL_DESCRIPTIONS.render_views,
        inputSchema: { type: 'object', properties: {
          views: { type: 'array', items: { type: 'string', enum: ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'] } },
          section: { type: 'object', properties: { axis: { type: 'string', enum: ['x', 'y', 'z'] }, value: { type: 'number' } }, required: ['axis', 'value'], additionalProperties: false },
        }, additionalProperties: false },
        run: async ({ views, section }) => {
          const list = views?.length ? views : ['iso', 'top', 'front', 'right'];
          const png = await host.renderViews({ views: list, section: section ?? null, width: 640, height: 480, labels: true });
          let bin = ''; for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
          return [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: btoa(bin) } },
            { type: 'text', text: `Views: ${list.join(', ')}${section ? `, cut at ${section.axis} = ${section.value}` : ''}. Each view is titled with its axes and the model size; ghosts are translucent reference parts.` },
          ];
        },
      }),
    ];
  }

  /** Context appended to every user turn so the model always sees the live project. */
  turnContext() {
    const report = this.host.lastReport();
    const files = this.host.listFiles().map((name) => {
      const text = this.host.getScript(name);
      return typeof text === 'string' ? `<file name="${name}">\n${text}\n</file>` : `<file name="${name}" binary="true" />`;
    }).join('\n');
    return `\n\n<project>\n${files}\n</project>\n\n<last_build>\n${report ? JSON.stringify(report, null, 1) : 'not built yet'}\n</last_build>`;
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
