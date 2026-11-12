// Mentions are plain text in the message: "@Name" for one person, "@all" (or "@everyone") for everybody.
// That way every Mumble client shows them as ordinary text, and only Libertad reacts to them.

export const MENTION_ALL = ['all', 'everyone'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The text of a chat message without its markup
function plain(html: string): string {
  return html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// Does the message mention one of these names, or everybody?
export function mentions(html: string, names: string[]): boolean {
  const text = plain(html);
  if (!text.includes('@')) return false;
  const all = [...MENTION_ALL, ...names.map(n => n.trim()).filter(Boolean)];
  // "@" at the start or after a space or punctuation, and the name must not run on into more letters
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])@(?:${all.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
  return re.test(text);
}

// The message html with every "@Name" / "@all" wrapped in a <span class="mtag">, so it can be styled and clicked.
// Only names of people given in `people` are marked, and never inside links. data-session says whose card a click opens.
export function markMentions(html: string, people: { name: string; session: number }[]): string {
  if (!html.includes('@')) return html;
  const names = [...MENTION_ALL.map(n => ({ name: n, session: -1 })), ...people.filter(p => p.name.trim())]
    .sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])@(${names.map(n => escapeRe(n.name)).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  const bySession = new Map(names.map(n => [n.name.toLowerCase(), n.session]));
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.includes('@') && !(n.parentElement?.closest('a'))) found.push(n as Text);
  }
  let changed = false;
  for (const node of found) {
    const text = node.data;
    const out = document.createDocumentFragment();
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) out.append(text.slice(last, m.index));
      const tag = document.createElement('span');
      tag.className = 'mtag';
      const id = bySession.get(m[1].toLowerCase()) ?? -1;
      if (id >= 0) { tag.dataset.session = String(id); tag.tabIndex = 0; tag.setAttribute('role', 'button'); }
      else tag.classList.add('all');
      tag.textContent = m[0];
      out.append(tag);
      last = m.index + m[0].length;
      changed = true;
    }
    if (last === 0) continue;
    if (last < text.length) out.append(text.slice(last));
    node.replaceWith(out);
  }
  return changed ? tpl.innerHTML : html;
}
