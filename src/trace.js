/** Formatting for script locations: a trace is [{ file, line }] innermost first. Shared by the app and the CLI. */
import { ENTRY } from './project.js';

/** "line 6" for the entry script, "lid.js line 3" for any other file. */
export const locText = (t) => (t.file && t.file !== ENTRY ? `${t.file} line ${t.line}` : `line ${t.line}`);

/** " (line 6, called from lid.js line 3 ← line 12)" or '' when nothing is known. */
export function whereText(trace) {
  const t = (trace ?? []).filter((x) => x && x.line);
  if (!t.length) return '';
  return ` (${locText(t[0])}${t.length > 1 ? `, called from ${t.slice(1).map(locText).join(' ← ')}` : ''})`;
}
