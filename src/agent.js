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
import rulesText from './assistant-rules.txt?raw';

/** The modelling rules both assistants follow (the iOS app bundles the same file). */
const MODELLING_RULES = rulesText.split('\n').filter((l) => l.startsWith('- ')).join('\n');

export const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (default)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster, cheaper)'],
];
export const DEFAULT_MODEL = 'claude-opus-5-5';

import { referenceFromHtml } from './api-text.js';
import { PLATES } from './plate.js';

const PLATE_IDS = PLATES.map((p) => p[0]);
const VIEWS = ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'];

const referenceText = () => referenceFromHtml(apiHtml);

const SYSTEM = `You are the modelling assistant inside TemenCAD, a browser app where a JavaScript script describes a 3D model for 3D printing. The user types plain English; you change the script so the model matches, then build it and check the result.

How to work:
- The project's files and the last build report are included with every user message. Read them before deciding what to change. main.js is the entry script; other .js files are ES modules it imports (\`import { lid } from './lid.js'\`, \`export const lid = ...\`). Fonts (.ttf/.otf), meshes (.stl) and images (.png/.jpg) in the project are imported the same way: \`import logo from './Logo.ttf'\` gives a font name for text(), \`import part from './part.stl'\` gives a Shape, \`import photo from './photo.png'\` gives an image for heightmap() and lithophane().
- Make the smallest edit that does the job with edit_script (exact-match replacement; pass \`file\` for anything other than main.js). Use write_script only for new models, new files or large rewrites. To split a model into modules, write_script a new .js file name (it is created) and import it from main.js; remove_file and rename_file manage script files. Fonts, meshes and images can only be added by the user: they can attach or drop them into the chat (the message's <app_events> lists what was added), or you can ask with add_files.
- The user can point at surfaces in the 3D view ("make this thicker"): such a message carries Reference n blocks (part name, which way the face points and where its plane is, its extent and area; or a hole / boss / fillet with its diameter or radius and axis) and a snapshot of their view with each reference highlighted in its colour. Work out which line of the script made that surface (the part name, the face's plane and extent against the shapes' sizes and positions) before editing, and say which feature you took it to be; if two features could match, ask. They can also measure between two points (distances, and the gap between parallel faces); trust those numbers, they come from the built mesh.
- The user can attach photos, sketches and PDFs to a message (labelled Attachment 1, 2, … in order across the conversation). Use them as references: a broken part next to a ruler, a hand sketch with dimensions, a drawing. Read dimensions from the drawing's labels first; when you scale from a photo, say which reference you used (a ruler, a coin, a known part) and how sure you are, and ask for the one or two measurements that matter most (hole spacing, mating diameters) rather than guessing them. To use an attached image in the model itself (lithophane, heightmap), save_attachment puts it in the project.
- After every change call run_model and read the report. Fix any error or warning it reports (they include line numbers) before replying. If the report says the model does not fit the plate, tell the user rather than silently shrinking their design.
- Use render_views when the shape of the result matters and the build report can't confirm it (first version of a new model, visual arrangement, fit against a ghost reference, anything you are unsure of): it returns labelled views (part names, sizes, scale bar, axes) with ghosts translucent, and can cut the model open with a section. take_screenshot gives the live 3D view instead. Both images also appear in the chat as thumbnails the user can open, so you can refer to them.
- Each of your replies that changed the project gets an Undo button, and Download STL / 3MF buttons when the build succeeded, so you don't need to offer those. When the user undoes a reply (or puts an undo back), an <app_events> note says so at the top of their next message; the <project> block is then the restored state. The conversation is kept with the project, so a user may come back to it after reloading or reopening the file.
${MODELLING_RULES}
- The user can stay in this chat for everything; never send them to a menu for something a tool does. You can start a new project, open and save projects, export STL or 3MF (all visible parts or named ones), give them the rendered views as a PNG, set the build plate, show/hide/ghost/solo parts, point the 3D view, turn auto-run and wireframe on or off, search and add shapes from the shared catalogue, and add files from their computer. The app state (project file name, unsaved changes, plate, auto-run, part display) comes with every message.
- Opening a project, saving to a new file and adding files from disk need the user's click: those tools put a button in the chat and wait for it. Say in a few words what the button is for; if they cancel, accept it and carry on. Ask before replacing their work: new_project and open_project check for unsaved changes themselves, so call them directly when the user asks.
- Exports and saved renders download straight away and leave a link in the chat. Hidden and ghost parts are never exported; to export one part, name it. Sharing to the catalogue opens a form you can prefill (the shape must live in a module next to main.js); the user reviews it and presses Share.
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
  render_views: 'Render the last build as a sheet of labelled views (part names, sizes in each view, scale bar, axes; ghost parts translucent). views: a list from iso, top, bottom, front, back, left, right (default iso, top, front, right). section: { axis, value } cuts the model open at that plane (y keeps what is below; x and z keep the negative side) and paints cut faces red. save: true also gives the user the PNG as a download. Build with run_model first.',
  new_project: 'Start a new project (File > New): one main.js holding `script` (default: the demo script), a new untitled file. If the open project has unsaved changes the user is asked in the chat whether to discard them. Builds the new project.',
  open_project: 'Open a .temen project or a .js script from the user\'s computer (File > Open). Puts a button in the chat for the user to click (browsers only open a file picker from a click), then returns the opened files. Unsaved changes are asked about first.',
  save_project: 'Save the project as a .temen file (File > Save / Save As). Writes the opened file in place when it can; otherwise, or with as_new_file, puts a "Save as" button in the chat for the user to click and pick a name.',
  export_model: 'Export the visible, non-ghost parts for printing (File > Export STL / 3MF, or one part from the Parts list) and download it; a link to the file stays in the chat. format: stl (one mesh) or 3mf (named, coloured objects, what Prusa, Bambu, Orca and Cura prefer). parts: export only these part names (each must be visible and not a ghost). Build first.',
  share_project: 'Open the Share form (File > Share) to submit a shape to the shared catalogue, prefilled with what you pass. The shape must be a module next to main.js that exports its functions (module); main.js stays the demo. The user reviews the form and presses Share.',
  set_view: 'Point the user\'s 3D view (View menu): view is one of iso, top, bottom, front, back, left, right, or reset to frame the model (or plate). wireframe turns wireframe display on or off.',
  set_plate: 'Show a printer build plate in the view and check the parts fit it (View > Plate). plate: a preset id, custom (with size [width, depth, height] in mm) or none. Returns whether the visible parts fit.',
  set_part_display: 'Show, hide, ghost or solo parts in the view (the Parts list). parts: part names (default all). visible / ghost set those flags; solo: true shows only the named parts; reset: true goes back to what the script says. Display only: it does not edit the script, and hidden or ghost parts are left out of exports.',
  set_autorun: 'Turn auto-run (rebuild as the user types) on or off (View > Auto-run).',
  search_catalog: 'Search the shared catalogue of parametric shapes (hinges, clips, knobs, boxes…). query: words that must all match (empty lists everything). Returns name, title, description, exports and parts of each.',
  add_from_catalog: 'Add a catalogue shape to the project by name: its files are copied into catalog/<name>/ and an import line is added to main.js. Then use its exports in main.js and run_model.',
  save_attachment: 'Add an image the user attached to a message (Attachment n) to the project as a file, e.g. a photo for lithophane() or heightmap(); then import it from main.js. .png and .jpg keep their bytes; other types are converted to .png. PDFs cannot be saved.',
  add_files: 'Ask the user to add files from their computer (images for heightmap/lithophane, fonts for text, STL meshes, SVG drawings, scripts). Puts an "Add files" button in the chat with your reason, waits for the click and returns the names added; import them from main.js.',
};

export class Agent {
  /**
   * @param {object} host  callbacks into the app:
   *   listFiles(), getScript(file), setScript(file, text), removeFile(file), renameFile(file, to) -> name,
   *   runAndWait() -> report object, screenshot(view) -> { dataUrl, mediaType, data }, renderViews(opts) -> Uint8Array (PNG),
   *   lastReport() -> report object | null
   *   and the menus' actions (main.js appActions): appState(), newProject(script), openProject(), saveProject(asNew),
   *   exportModel({ format, parts, filename }), saveRender({ views, section }), shareProject(prefill), setView({ view, wireframe }),
   *   setPlate(id, size), setPartDisplay(opts), setAutorun(on), searchCatalog(query), addFromCatalog(name), addFiles(reason)
   */
  constructor(host) {
    this.host = host;
    this.messages = [];
    this.notes = []; // things the user did in the app (undo, redo) to tell the model with the next message
    this.attachments = []; // files the user showed the model (attachment n is attachments[n - 1]), for save_attachment
    this.client = null;
    this.abort = null;
  }

  configure({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.client = apiKey ? new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) : null;
  }

  reset() { this.messages = []; this.notes = []; this.attachments = []; }
  /** Remember a file shown to the model; returns its attachment number. */
  addAttachment(file) { this.attachments.push(file); return this.attachments.length; }
  /** Tell the model about something the user did, with their next message. */
  note(text) { this.notes.push(text); }

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
          host.showImage?.(shot.data, shot.mediaType, `Screenshot, ${view || 'iso'} view`);
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
          save: { type: 'boolean', description: 'Also give the user the PNG (at a larger size) as a download' },
        }, additionalProperties: false },
        run: async ({ views, section, save }) => {
          const list = views?.length ? views : ['iso', 'top', 'front', 'right'];
          const png = await host.renderViews({ views: list, section: section ?? null, width: 640, height: 480, labels: true });
          if (save) await host.saveRender({ views: list, section: section ?? null });
          host.showImage?.(png, 'image/png', `${list.join(', ')}${section ? `, cut at ${section.axis} = ${section.value}` : ''}`);
          let bin = ''; for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
          return [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: btoa(bin) } },
            { type: 'text', text: `Views: ${list.join(', ')}${section ? `, cut at ${section.axis} = ${section.value}` : ''}. Each view is titled with its axes and the model size; ghosts are translucent reference parts.${save ? ' The PNG is in the chat as a download.' : ''}` },
          ];
        },
      }),
      ...this.appTools(),
    ];
  }

  /** The app's menus as tools: files, export, sharing, view, plate, parts, catalogue. */
  appTools() {
    const host = this.host;
    const tool = (name, properties, run, required = []) => betaTool({
      name, description: TOOL_DESCRIPTIONS[name],
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      run: async (input) => { try { return await run(input ?? {}); } catch (e) { return `Error: ${e?.message ?? e}`; } },
    });
    const json = (v) => JSON.stringify(v, null, 1);
    const strs = { type: 'array', items: { type: 'string' } };
    return [
      tool('new_project', { script: { type: 'string', description: 'main.js for the new project (default: the demo script)' } },
        async ({ script }) => json(await host.newProject(script))),
      tool('open_project', {}, async () => json(await host.openProject())),
      tool('save_project', { as_new_file: { type: 'boolean', description: 'Save As: pick a new file name' } },
        async ({ as_new_file }) => json(await host.saveProject(!!as_new_file))),
      tool('export_model', {
        format: { type: 'string', enum: ['stl', '3mf'] },
        parts: { ...strs, description: 'Only these part names (default: every visible, non-ghost part)' },
        filename: { type: 'string', description: 'File name without extension (default: the project name, or the part name)' },
      }, async ({ format, parts, filename }) => json(await host.exportModel({ format, parts, filename })), ['format']),
      tool('share_project', {
        title: { type: 'string' }, name: { type: 'string', description: 'Package name: lowercase letters, digits and dashes (default: from the title)' },
        description: { type: 'string' }, tags: strs, module: { type: 'string', description: 'The module file that exports the shape, e.g. hinge.js' },
        exports: { ...strs, description: 'Exported function names (default: found in the module)' },
        author: { type: 'string' }, license: { type: 'string', description: 'SPDX id, e.g. CC-BY-4.0, MIT' }, version: { type: 'string' },
      }, async (prefill) => json(host.shareProject(prefill))),
      tool('set_view', { view: { type: 'string', enum: [...VIEWS, 'reset'] }, wireframe: { type: 'boolean' } },
        async ({ view, wireframe }) => json(host.setView({ view, wireframe }))),
      tool('set_plate', {
        plate: { type: 'string', enum: PLATE_IDS, description: PLATES.map(([id, label]) => `${id}: ${label}`).join('; ') },
        size: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[width, depth, height] in mm, for plate: custom' },
      }, async ({ plate, size }) => json(await host.setPlate(plate, size)), ['plate']),
      tool('set_part_display', {
        parts: { ...strs, description: 'Part names (default: every part)' }, visible: { type: 'boolean' }, ghost: { type: 'boolean' },
        solo: { type: 'boolean' }, reset: { type: 'boolean' },
      }, async (o) => json(host.setPartDisplay({ names: o.parts, visible: o.visible, ghost: o.ghost, solo: o.solo, reset: o.reset }))),
      tool('set_autorun', { on: { type: 'boolean' } }, async ({ on }) => json(host.setAutorun(on)), ['on']),
      tool('search_catalog', { query: { type: 'string' } }, async ({ query }) => json(await host.searchCatalog(query ?? ''))),
      tool('add_from_catalog', { name: { type: 'string', description: 'Package name from search_catalog' } },
        async ({ name }) => json(await host.addFromCatalog(name)), ['name']),
      tool('save_attachment', {
        attachment: { type: 'integer', description: 'The attachment number from the message' },
        name: { type: 'string', description: 'File name in the project (default: the attachment\'s name); the extension follows the image type' },
        replace: { type: 'boolean', description: 'Replace a project file of the same name' },
      }, async ({ attachment, name, replace }) => {
        const file = this.attachments[attachment - 1];
        if (!file) throw new Error(`no attachment ${attachment}; there ${this.attachments.length === 1 ? 'is 1' : `are ${this.attachments.length}`}`);
        return json(await host.saveAttachment(file, name, !!replace));
      }, ['attachment']),
      tool('add_files', { reason: { type: 'string', description: 'Shown on the button card: what to add and why, e.g. "Add the photo for the lithophane (.png or .jpg)"' } },
        async ({ reason }) => json(await host.addFiles(reason)), ['reason']),
    ];
  }

  /** Context appended to every user turn so the model always sees the live project. */
  turnContext() {
    const report = this.host.lastReport();
    const files = this.host.listFiles().map((name) => {
      const text = this.host.getScript(name);
      return typeof text === 'string' ? `<file name="${name}">\n${text}\n</file>` : `<file name="${name}" binary="true" />`;
    }).join('\n');
    const app = this.host.appState?.();
    return `\n\n<project>\n${files}\n</project>${app ? `\n\n<app>\n${JSON.stringify(app, null, 1)}\n</app>` : ''}\n\n<last_build>\n${report ? JSON.stringify(report, null, 1) : 'not built yet'}\n</last_build>`;
  }

  /**
   * Send a user message and stream the reply.
   * events: onText(delta), onTool(name), onDone(finalMessage), onError(err)
   * extra: { blocks: image / document content blocks to show with the message, notes: lines for <app_events> }
   */
  async send(text, events, extra = {}) {
    if (!this.client) throw new Error('No API key set. Open Assistant settings and paste your Anthropic API key.');
    if (this.busy) throw new Error('The assistant is still working.');
    this.abort = new AbortController();
    const before = [...this.messages];
    const notes = this.notes.splice(0);
    const appEvents = [...notes, ...(extra.notes ?? [])];
    const body = (appEvents.length ? `<app_events>\n${appEvents.join('\n')}\n</app_events>\n\n` : '') + text + this.turnContext();
    this.messages.push({ role: 'user', content: extra.blocks?.length ? [...extra.blocks, { type: 'text', text: body }] : body });

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
      this.notes.unshift(...notes);
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
