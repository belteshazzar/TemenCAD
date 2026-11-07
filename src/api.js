/**
 * API reference page: syntax highlighting for the code blocks and a table of contents. Runs in the
 * browser only; the assistant reads the raw HTML, which stays plain.
 */
const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function highlight(code) {
  // Tokenise once so comments and strings are never re-coloured by later rules.
  const re = /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|\b(const|let|return|import|from|export|function|new|true|false)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)(?=\()|(→)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [tok, c, s, k, n, f, arrow] = m;
    out += c ? `<span class="c">${esc(c)}</span>` : s ? `<span class="s">${esc(s)}</span>` : k ? `<span class="k">${k}</span>`
      : n ? `<span class="n">${n}</span>` : f ? `<span class="f">${f}</span>` : arrow ? `<span class="c">${arrow}</span>` : esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last));
}
for (const pre of document.querySelectorAll('main pre')) pre.innerHTML = highlight(pre.textContent);

const toc = document.getElementById('toc');
for (const h of document.querySelectorAll('main h3')) {
  const short = h.textContent.replace(/\s*\(.*$/, '');
  h.id = short.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const li = document.createElement('li');
  const a = document.createElement('a'); a.href = `#${h.id}`; a.textContent = short;
  li.appendChild(a); toc.appendChild(li);
  const link = document.createElement('a'); link.className = 'anchor'; link.href = `#${h.id}`; link.textContent = '#'; link.setAttribute('aria-label', `Link to ${short}`);
  h.appendChild(link);
}
// Highlight the section in view
const links = [...toc.querySelectorAll('a')];
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) for (const l of links) l.classList.toggle('on', l.getAttribute('href') === `#${e.target.id}`);
}, { rootMargin: '-10% 0px -75% 0px' });
for (const h of document.querySelectorAll('main h3')) io.observe(h);
