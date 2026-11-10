/**
 * Line diff for the chat's "show changes" view: unified hunks with a few lines of context.
 * Common prefix and suffix are trimmed first; the middle uses an LCS table when it is small
 * enough, otherwise it is shown as removed then added.
 */
const MAX_CELLS = 4e6;

/** [{ op: ' ' | '-' | '+', text }] turning a into b (arrays of lines). */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const out = a.slice(0, pre).map((text) => ({ op: ' ', text }));
  const n = A.length, m = B.length;
  if (n * m > MAX_CELLS) {
    for (const text of A) out.push({ op: '-', text });
    for (const text of B) out.push({ op: '+', text });
  } else {
    // lcs[i][j] = LCS length of A[i..] and B[j..], in one flat array
    const w = m + 1, lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { out.push({ op: ' ', text: A[i] }); i++; j++; }
      else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) out.push({ op: '-', text: A[i++] }); // removals first
      else out.push({ op: '+', text: B[j++] });
    }
  }
  for (const text of a.slice(a.length - suf)) out.push({ op: ' ', text });
  return out;
}

/**
 * Unified hunks: [{ header: '@@ -l,n +l,n @@', lines: [{ op, text }] }] plus added / removed counts.
 * Text files only; the caller handles binaries.
 */
export function unifiedDiff(before, after, context = 3) {
  const split = (s) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
  const ops = diffLines(split(before), split(after));
  let added = 0, removed = 0;
  for (const o of ops) { if (o.op === '+') added++; else if (o.op === '-') removed++; }
  const hunks = [];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k].op === ' ') k++;
    if (k >= ops.length) break;
    let start = Math.max(0, k - context), end = k;
    // extend while changes are within 2*context lines of each other
    for (let gap = 0; end < ops.length; end++) {
      if (ops[end].op === ' ') { if (++gap > 2 * context) { end -= gap - context; break; } }
      else gap = 0;
    }
    end = Math.min(end, ops.length);
    if (end === ops.length) { let tail = 0; while (tail < end - k && ops[end - 1 - tail].op === ' ') tail++; end -= Math.max(0, tail - context); }
    // line numbers at the hunk start
    let la = 1, lb = 1;
    for (let q = 0; q < start; q++) { if (ops[q].op !== '+') la++; if (ops[q].op !== '-') lb++; }
    const lines = ops.slice(start, end);
    const na = lines.filter((o) => o.op !== '+').length, nb = lines.filter((o) => o.op !== '-').length;
    hunks.push({ header: `@@ -${na ? la : la - 1},${na} +${nb ? lb : lb - 1},${nb} @@`, lines });
    k = end;
  }
  return { hunks, added, removed };
}
