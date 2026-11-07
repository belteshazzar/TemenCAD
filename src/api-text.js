/** Plain-text API reference derived from api.html, so the assistant, the command line and the docs never drift. */
export function referenceFromHtml(apiHtml) {
  const body = apiHtml.slice(apiHtml.indexOf('<main'), apiHtml.indexOf('</main>'));
  return body
    .replace(/<h2[^>]*>/g, '\n# ').replace(/<h3[^>]*>/g, '\n## ')
    .replace(/<pre[^>]*>/g, '\n```\n').replace(/<\/pre>/g, '\n```\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
