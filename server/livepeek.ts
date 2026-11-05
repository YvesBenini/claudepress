// A glance at a site as it is online: its share image (og:image), title and description, and when the host says it last
// changed. Read from the live address, kept for a few hours.
import net from 'node:net';

export interface Peek { image: string | null; title: string | null; description: string | null; modified: string | null; at: number }

const HOURS = 6;
const cache = new Map<string, Peek>();

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).trim();

/** The content of the first <meta> with one of these property or name values. */
function meta(html: string, keys: string[]) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (key && keys.includes(key) && content) return decode(content[1] ?? content[2]);
  }
  return null;
}

/** Only public web addresses: a site's address is typed by an administrator, it must not reach this server's own network. */
function publicUrl(raw: string) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || net.isIP(u.hostname.replace(/^\[|\]$/g, '')) || /^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}

export async function livePeek(liveUrl: string): Promise<Peek> {
  // a site that answered is read again after a few hours; one that did not (down, slow), after a few minutes
  const hit = cache.get(liveUrl);
  if (hit && Date.now() - hit.at < (hit.title || hit.image ? HOURS * 3600e3 : 10 * 60e3)) return hit;
  const empty: Peek = { image: null, title: null, description: null, modified: null, at: Date.now() };
  const url = publicUrl(liveUrl);
  if (!url) return empty;
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'ClaudePress (+https://claudepress.org)', Accept: 'text/html' } });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('html')) { cache.set(liveUrl, empty); return empty; }
    // the head is enough: read at most 300 kB
    const reader = r.body!.getReader();
    let html = '', size = 0;
    while (size < 300_000) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      html += new TextDecoder().decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const image = meta(html, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
    const abs = image ? publicUrl(new URL(image, r.url).href)?.href ?? null : null;
    const modified = r.headers.get('last-modified');
    const peek: Peek = {
      image: abs,
      title: meta(html, ['og:title', 'twitter:title']) || (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ? decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)![1]) : null),
      description: meta(html, ['og:description', 'description', 'twitter:description']),
      modified: modified && !isNaN(Date.parse(modified)) ? new Date(modified).toISOString() : null,
      at: Date.now(),
    };
    cache.set(liveUrl, peek);
    return peek;
  } catch {
    cache.set(liveUrl, empty);
    return empty;
  }
}
