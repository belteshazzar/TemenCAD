// The interpreter reaches its speed inside one run: node core/test/reentry.mjs
//
// V8 compiles a WebAssembly function twice, and switches to the optimised code only at the
// function's next call. lamassu's dispatch loop is one function, and a script used to run in one
// call of it: a long script stayed on the first compiler's code to its end, nearly three times
// slower, and only a second build in the same process found the good code. lamassu now leaves
// the loop and enters it again every 65,536 instructions (JsVm.slice in lamassu_internal.h).
//
// That is undone without a sign by anything that puts the loop back inside one activation: an
// optimiser inlining it into its caller (clang and Binaryen both do, which is why lamassu calls
// it through a volatile pointer), a build flag, an Emscripten upgrade. So this measures it. The
// first run of a fresh process (this file must stay a process of its own: the smoke test's
// hundreds of runs would have warmed the code long before) has to get as fast, by its end, as a
// second run is from its start.
import { createRuntime } from '../wasm/index.js';

const rt = await createRuntime();
const script = (ms) => `
  const round = () => { let s = 0; for (let i = 0; i < 1000000; i++) s = s + i; return s; };
  const times = [];
  const start = Date.now();
  while (Date.now() - start < ${ms}) { const t0 = Date.now(); round(); times.push(Date.now() - t0); }
  echo('rounds', times.join(' '));`;
const rounds = (ms) => {
  const r = rt.run({ 'main.js': script(ms) });
  if (!r.ok) { console.log('FAIL the timing script runs', r.error?.message); process.exit(1); }
  return r.messages.find((m) => m.text.includes('"rounds"')).text.split('"rounds", "')[1].replace('"', '').split(' ').map(Number);
};
const first = rounds(1200); // long enough for the optimised code to be ready well before the end
const second = rounds(300);
const best = (a) => Math.min(...a);
// Without re-entry the first run's best round is about 2.7 times the second's; with it they are
// the same code. 1.5 leaves room for a busy machine and none for the slow code.
const ok = best(first) <= 1.5 * best(second);
console.log(`${ok ? 'ok  ' : 'FAIL'} a script's own run reaches the optimised interpreter (ms per million iterations: first run ${first[0]} falling to ${best(first)}, second run ${best(second)})`);
process.exit(ok ? 0 : 1);
