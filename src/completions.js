/**
 * Editor autocompletion for the TemenCAD API: global functions at the top level, shape and sketch
 * methods after a dot. Snippets carry placeholders; Tab accepts a suggestion and then jumps between
 * them. CodeMirror's own JavaScript completion (local variables, keywords) stays active alongside.
 */
import { snippetCompletion } from '@codemirror/autocomplete';
import { GLOBALS, METHODS } from './api-catalog.js';

// Every snippet with fields ends with an explicit empty field so the last Tab lands after the closing bracket.
const withEnd = (snippet) => (snippet.includes('${') && !snippet.endsWith('${}') ? snippet + '${}' : snippet);
const toCompletion = (e, boost = 0) => (e.snippet
  ? snippetCompletion(withEnd(e.snippet), { label: e.label, detail: e.detail, info: e.info, type: e.kind, boost })
  : { label: e.label, detail: e.detail, info: e.info, type: e.kind === 'constant' ? 'constant' : e.kind, boost });

const globalCompletions = GLOBALS.map((e) => toCompletion(e, 1));
// Methods shared by shapes and sketches first, then the rest; the receiver's type is unknown statically.
const methodCompletions = METHODS.map((e) => toCompletion(e, e.on === 'both' ? 1 : 0));

/** Completion source for the API. Does nothing inside strings and comments. */
export function apiCompletions(context) {
  const node = context.tokenBefore(['String', 'TemplateString', 'LineComment', 'BlockComment', 'PropertyName']);
  if (node && node.type.name !== 'PropertyName' && node.type.name !== 'VariableName') return null;
  const dot = context.matchBefore(/\.\w*$/);
  if (dot) {
    // Not after a number literal (1.5) or a known non-shape object.
    const before = context.state.sliceDoc(Math.max(0, dot.from - 30), dot.from);
    if (/\d$/.test(before) || /\b(Math|JSON|console|Object|Array|Number|String)$/.test(before)) return null;
    return { from: dot.from + 1, options: methodCompletions, validFor: /^\w*$/ };
  }
  const word = context.matchBefore(/\w+$/);
  if (!word && !context.explicit) return null;
  return { from: word ? word.from : context.pos, options: globalCompletions, validFor: /^\w*$/ };
}
