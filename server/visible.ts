// What a page of the site shows today, read from its build (sites built here) or from the live site.
// A site's templates may keep content they never display, or display something else in its place (a photo
// swapped for a logo file, a hero fixed in the code): changing it would change nothing anyone sees.
import fs from 'node:fs';
import path from 'node:path';
import type { Site } from './sites.ts';
import type { Element } from './adapters/types.ts';
import { stripTags } from './adapters/blocks-json.ts';

interface Shown { text: string; html: string }

/** Letters and digits only, lowercase, no accents: what survives the markup, case and spacing a template adds. */
const bare = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);

function parse(html: string): Shown {
  const body = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ');
  return { text: bare(decode(body.replace(/<[^>]*>/g, ' '))), html: body.toLowerCase() };
}

const live = new Map<string, { at: number; page: Promise<Shown | null> }>();
const LIVE_TTL = 10 * 60e3;

async function shownOn(s: Site, url: string): Promise<Shown | null> {
  if (s.previews === 'local' && s.baseOut) {
    const p = path.join(s.baseOut, path.normalize(decodeURI(url)).replace(/^(\.\.[/\\])+/, ''));
    const file = [path.join(p, 'index.html'), p + '.html', p].find(f => f.startsWith(s.baseOut) && fs.existsSync(f) && fs.statSync(f).isFile());
    return file ? parse(fs.readFileSync(file, 'utf8')) : null;
  }
  const key = `${s.id} ${url}`, hit = live.get(key);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.page;
  const page = fetch(new URL(url, s.liveUrl), { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'ClaudePress' } })
    .then(async r => r.ok && (r.headers.get('content-type') || '').includes('text/html') ? parse(await r.text()) : null)
    .catch(() => null);
  live.set(key, { at: Date.now(), page });
  return page;
}

function seen(shown: Shown, e: Element) {
  if (e.type === 'image') {
    const name = path.parse(e.src || '').name.toLowerCase();
    return !name || shown.html.includes(name);
  }
  const t = bare(decode(stripTags(e.type === 'list' ? (e.items || []).join(' ') : e.type === 'button' ? e.text || '' : e.html || '')));
  if (t.length < 8) return true;   // too short to tell
  return shown.text.includes(t.slice(0, 30)) || shown.text.includes(t.slice(-30));
}

/**
 * Ids of the elements of a page that the site does not show as they are (current, published content).
 * Empty when the page cannot be read: nothing is flagged on a guess.
 */
export async function unseen(s: Site, url: string): Promise<Set<string>> {
  const page = s.adapter_.readPage(s.content, url);
  const shown = page && await shownOn(s, url);
  if (!page || !shown) return new Set();
  const out = page.elements.filter(e => !seen(shown, e)).map(e => e.id);
  // most of a page missing means the page read is not this content (another version, a sign-in page): say nothing
  return out.length > page.elements.length * 0.6 ? new Set() : new Set(out);
}
