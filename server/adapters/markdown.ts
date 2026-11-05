// Adapter for sites whose pages are Markdown files with a front matter header (Astro, Next.js, Hugo, Eleventy…),
// in one or more folders ("collections"), each published under an address pattern.
//
// Config (sites[].adapter):
//   { "type": "markdown", "collections": [{ "dir": "src/content/blog", "url": "/blog/{slug}/", "kind": "post" },
//                                        { "dir": "src/content/pages", "url": "/{path}/", "kind": "page" }],
//     "lang": "en", "mediaDir": "public/images", "mediaPrefix": "/images/", "build": ["npm", "run", "build"],
//     "outDir": "dist", "sharedFiles": ["src/data/site.json"], "guide": "…" }
//
// {path} is the file's path inside the folder without its extension ("about", "guides/start"; "index" files give
// their folder), {slug} the front matter's slug or the file's name. A `permalink` or `url` in the front matter wins.
//
// Only what can be written back without touching the rest is editable: the title, description and cover photo of
// the front matter, and the headings, paragraphs, simple lists, quotes, photos and link-only lines of the body.
// Code, tables, HTML, MDX components and shortcodes are kept as they are and left to the agency. An edit rewrites
// only the lines of what it changes.

import fs from 'node:fs';
import path from 'node:path';
import type { Content, Element, Highlight, Match, NewPost, Op, PageSummary, SiteAdapter } from './types.ts';
import { datedMediaPath, fold, runBuild, same, stripTags } from './blocks-json.ts';
import { sharedJson } from './shared-json.ts';
import { fieldsOf, removeField, setField, splitDoc, type Doc, type Field } from './frontmatter.ts';

export interface Collection { dir: string; url: string; kind: 'page' | 'post' }

export interface MarkdownConfig {
  type: 'markdown';
  collections: Collection[];
  lang: string;
  mediaDir: string;
  mediaPrefix: string;
  build: string[];
  buildEnv?: Record<string, string>;
  outDir: string;
  guide?: string;
  sharedFiles?: string[];
}

const EXT = /\.(md|mdx|markdown)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.astro', '.next', 'dist', '.cache']);

// front matter keys, in order of preference
const TITLE = ['title'];
const SEO_TITLE = ['seo.title', 'metaTitle', 'meta_title', 'seoTitle', 'seo_title'];
const DESCRIPTION = ['seo.description', 'description', 'metaDescription', 'meta_description', 'summary', 'excerpt'];
const IMAGE = ['heroImage', 'hero_image', 'image', 'cover', 'coverImage', 'cover_image', 'featuredImage', 'featured_image', 'thumbnail', 'banner', 'cover.image', 'image.src', 'image.url', 'featured_image.src'];
const DATE = ['pubDate', 'date', 'publishDate', 'published', 'publishedAt', 'pubdate'];
const STALE = ['updatedDate', 'updated', 'lastmod', 'modified', 'modifiedAt', 'updatedAt', 'permalink', 'url', 'aliases', 'redirect_from'];

const LABELS: Record<string, string> = { heading: 'Titre', text: 'Paragraphe', list: 'Liste', image: 'Photo', button: 'Bouton', quote: 'Citation' };

// ------------------------------------------------------------------ inline Markdown ⇄ the HTML the tools speak

const escHtml = (s: string) => s.replace(/&(?![a-z]+;|#\d+;|#x[\da-f]+;)/gi, '&amp;').replace(/<(?![a-zA-Z/!])/g, '&lt;');

/** Inline Markdown as HTML: emphasis, links, line breaks. Code, images and reference links stay as written. */
export function mdToHtml(md: string): string {
  const keep: string[] = [];
  const hold = (s: string) => `\u0000${keep.push(s) - 1}\u0000`;
  let s = md
    .replace(/(`+)[\s\S]*?\1/g, m => hold(escHtml(m)))
    .replace(/<(https?:\/\/[^\s>]+)>/g, (_m, u) => hold(`<a href="${u}">${u}</a>`))
    .replace(/\\([\\`*_{}\[\]()#+\-.!<>|~])/g, (_m, c) => hold(c === '<' ? '&lt;' : c === '>' ? '&gt;' : c))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, m => hold(m))
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, m => hold(m));
  s = escHtml(s)
    .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*|\*([^\s*])\*/g, (_m, a, b) => `<em>${a ?? b}</em>`)
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_]|[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/<br\s*\/?>/gi, '<br>')
    .replace(/( {2,}|\\)\n/g, '<br>')
    .replace(/\s*\n\s*/g, ' ');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[+i]);
}

/** The HTML of a text tool (already sanitized: strong, em, b, i, br, span, a) as inline Markdown on one line. */
export function htmlToMd(html: string): string {
  let out = '';
  const links: string[] = [];
  for (const part of String(html ?? '').split(/(<[^>]+>)/)) {
    const tag = part.match(/^<(\/?)([a-z0-9]+)([^>]*)>$/i);
    if (!tag) {
      out += part
        .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\*/g, '\\*')
        .replace(/(^|[^\w\\])_|_(?=[^\w]|$)/g, m => m.replace('_', '\\_'));
      continue;
    }
    const [, close, name, attrs] = tag;
    const n = name.toLowerCase();
    if (n === 'strong' || n === 'b') out += '**';
    else if (n === 'em' || n === 'i') out += '*';
    else if (n === 'br') out += '<br />';
    else if (n === 'a') {
      if (close) { const href = links.pop(); out += href ? `](${href})` : ''; }
      else { const href = attrs.match(/href="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"').replace(/&amp;/g, '&') || ''; links.push(href.replace(/[()\s]/g, c => encodeURIComponent(c))); if (href) out += '['; }
    }
  }
  // a line must not start a heading, list, quote or code block
  return out.trim().replace(/^(#{1,6}\s|[-+]\s|>|\d+[.)]\s|={3,}$)/, '\\$1');
}

// ------------------------------------------------------------------ the body: blocks with their lines

interface Block {
  type: 'heading' | 'text' | 'list' | 'image' | 'button' | 'quote' | 'other';
  start: number;       // first line (index in the file)
  end: number;         // line after the last one
  md?: string;         // heading, text, quote: inline Markdown
  level?: number;
  setext?: boolean;
  items?: string[];    // list: inline Markdown of each item
  ordered?: boolean;
  marker?: string;     // list: "-" or "1." ("1)")
  indent?: string;
  loose?: boolean;
  img?: { alt: string; src: string; title: string; href: string };
  link?: { text: string; href: string; wrap: string };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const QUOTE = /^ {0,3}>/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const IMG_LINE = /^(\[)?!\[((?:\\.|[^\]\\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"((?:\\.|[^"\\])*)")?\s*\)(?:\]\(\s*([^)\s]+)\s*\))?$/;
const LINK_LINE = /^(\*\*|__)?\[((?:\\.|[^\]\\!])(?:\\.|[^\]\\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\1$/;
const unescape = (s: string) => s.replace(/\\([\[\]"\\])/g, '$1');

/** Does this line start a block other than a paragraph (so it ends a paragraph)? */
const opens = (l: string, mdx: boolean) => ATX.test(l) || FENCE.test(l) || QUOTE.test(l) || HR.test(l) || /^ {0,3}([-*+]|1[.)])[ \t]+\S/.test(l)
  || /^ {0,3}</.test(l) || /^\s*(\{\{[<%]|\{%)/.test(l) || (mdx && /^(import|export)\s/.test(l));

export function blocksOf(doc: Doc, mdx: boolean): Block[] {
  const L = doc.lines, out: Block[] = [];
  const isBlank = (i: number) => i >= L.length || !L[i].trim();
  const untilBlank = (i: number) => { while (i < L.length && !isBlank(i)) i++; return i; };
  let i = doc.body;
  while (i < L.length) {
    const l = L[i];
    if (isBlank(i)) { i++; continue; }
    const start = i;
    let m: RegExpMatchArray | null;
    if ((m = l.match(FENCE))) {
      const close = new RegExp(`^ {0,3}${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}\\s*$`);
      i++;
      while (i < L.length && !close.test(L[i])) i++;
      out.push({ type: 'other', start, end: Math.min(i + 1, L.length) });
      i++;
    } else if (/^ {4,}|^\t/.test(l)) {
      // indented code
      while (i < L.length && (isBlank(i) ? /^( {4,}|\t)/.test(L[i + 1] ?? '') : /^( {4,}|\t)/.test(L[i]))) i++;
      out.push({ type: 'other', start, end: i });
    } else if ((m = l.match(ATX))) {
      out.push({ type: 'heading', start, end: ++i, level: m[1].length, md: m[2] ?? '' });
    } else if (HR.test(l) || /^ {0,3}\$\$/.test(l) && (() => { i++; while (i < L.length && !/\$\$\s*$/.test(L[i])) i++; return true; })()) {
      out.push({ type: 'other', start, end: ++i });
    } else if (/^ {0,3}</.test(l) || /^\s*(\{\{[<%]|\{%|\[[^\]]+\]:\s)/.test(l) || (mdx && /^(import|export)\s/.test(l)) || (l.includes('|') && TABLE_RULE.test(L[i + 1] ?? ''))) {
      // HTML, MDX components and statements, shortcodes, link definitions, tables: kept as they are
      i = untilBlank(i);
      out.push({ type: 'other', start, end: i });
    } else if (QUOTE.test(l)) {
      i = untilBlank(i);
      const inner = L.slice(start, i).map(x => x.replace(/^ {0,3}> ?/, ''));
      const simple = L.slice(start, i).every(x => QUOTE.test(x)) && inner.every(x => x.trim() && !opens(x, mdx) && !/^\[!/.test(x));
      out.push(simple ? { type: 'quote', start, end: i, md: inner.join('\n') } : { type: 'other', start, end: i });
    } else if ((m = l.match(ITEM))) {
      const indent = m[1], ordered = /\d/.test(m[2]), family = ordered ? /^\d{1,9}[.)]$/ : new RegExp(`^\\${m[2]}$`);
      const items: string[] = [];
      let simple = true, loose = false;
      while (i < L.length) {
        const im = L[i].match(ITEM);
        if (im && im[1] === indent && family.test(im[2])) {
          if (/^\[[ xX]\]\s/.test(im[4])) simple = false;          // task lists
          items.push(im[4]);
          i++;
        } else if (!isBlank(i) && (/^\s/.test(L[i]) || !opens(L[i], mdx))) {
          // continuation of the item (indented, or a lazy line)
          if (ITEM.test(L[i].trim()) || FENCE.test(L[i].trim()) || QUOTE.test(L[i].trim())) simple = false;
          items[items.length - 1] += '\n' + L[i].trim();
          i++;
        } else if (isBlank(i)) {
          let j = i;
          while (j < L.length && isBlank(j)) j++;
          const next = L[j]?.match(ITEM);
          if (next && next[1] === indent && family.test(next[2])) { loose = true; i = j; }
          else if (j < L.length && /^\s{2,}\S/.test(L[j])) { simple = false; i = j; }   // a second paragraph inside an item
          else break;
        } else break;
      }
      out.push(simple ? { type: 'list', start, end: i, items, ordered, marker: m[2], indent, loose } : { type: 'other', start, end: i });
    } else {
      // paragraph, or a setext heading
      i++;
      while (i < L.length && !isBlank(i) && !opens(L[i], mdx) && !/^ {0,3}(=+|-+)\s*$/.test(L[i])) i++;
      if (i < L.length && /^ {0,3}(=+|-+)\s*$/.test(L[i]) && !isBlank(i)) {
        out.push({ type: 'heading', start, end: i + 1, level: L[i].trim()[0] === '=' ? 1 : 2, setext: true, md: L.slice(start, i).map(x => x.trim()).join('\n') });
        i++;
        continue;
      }
      const md = L.slice(start, i).map(x => x.trim()).join('\n');
      if ((m = md.match(IMG_LINE))) out.push({ type: 'image', start, end: i, img: { alt: unescape(m[2]), src: m[3], title: unescape(m[4] ?? ''), href: m[1] ? m[5] ?? '' : '' } });
      else if ((m = md.match(LINK_LINE))) out.push({ type: 'button', start, end: i, link: { text: m[2], href: m[3], wrap: m[1] ?? '' } });
      else if (/\{\{|\{%/.test(md) || (mdx && /[{}]|<[A-Z]/.test(md))) out.push({ type: 'other', start, end: i });
      else out.push({ type: 'text', start, end: i, md });
    }
  }
  return out;
}

/** The lines of a block once changed. */
function blockLines(b: Block): string[] {
  if (b.type === 'heading') return b.setext ? [b.md!, (b.level === 1 ? '=' : '-').repeat(Math.max(3, Math.min(b.md!.length, 60)))] : [`${'#'.repeat(b.level!)} ${b.md}`];
  if (b.type === 'text') return [b.md!];
  if (b.type === 'quote') return [`> ${b.md}`];
  if (b.type === 'list') {
    const first = parseInt(b.marker!, 10), delim = b.marker!.slice(-1);
    const lines = b.items!.map((it, k) => `${b.indent}${b.ordered ? `${first + k}${delim}` : b.marker} ${it}`);
    return b.loose ? lines.flatMap((x, k) => k ? ['', x] : [x]) : lines;
  }
  if (b.type === 'image') {
    const { alt, src, title, href } = b.img!;
    const img = `![${alt.replace(/[\\\[\]]/g, '\\$&')}](${src}${title ? ` "${title.replace(/["\\]/g, '\\$&')}"` : ''})`;
    return [href ? `[${img}](${href})` : img];
  }
  if (b.type === 'button') return [`${b.link!.wrap}[${b.link!.text}](${b.link!.href})${b.link!.wrap}`];
  throw new Error('Bloc non modifiable');
}

const md1 = (html: string) => htmlToMd(html);
const textOf = (html: string) => stripTags(html).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
const plainHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const relative = (src: string) => !!src && !/^(\/|[a-z][a-z0-9+.-]*:|#)/i.test(src);

// ------------------------------------------------------------------ the adapter

export function markdown(cfg: MarkdownConfig): SiteAdapter {
  const collections = [...cfg.collections].map(c => ({ ...c, dir: c.dir.replace(/^\.?\/|\/$/g, '') })).sort((a, b) => b.dir.length - a.dir.length);
  const shared = sharedJson(cfg.sharedFiles || [], cfg.lang);
  const within = (dir: string, p: string) => !dir || p.startsWith(dir + '/');

  /** The collection a file belongs to (the most specific folder), or null when it is not a page. */
  function collectionOf(p: string) {
    if (!EXT.test(p)) return null;
    const name = path.posix.basename(p).replace(EXT, '');
    if (/^readme$/i.test(name) || (name.startsWith('_') && name !== '_index')) return null;
    return collections.find(c => within(c.dir, p)) ?? null;
  }

  const slugify = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');

  // ---- pages: what each file is, cached by its text
  interface Meta { file: string; url: string; kind: string; title: string; draft: boolean; doc: Doc; fields: Map<string, Field>; mdx: boolean }
  const metas = new Map<string, { text: string; meta: Meta }>();

  function metaOf(file: string, text: string): Meta {
    const hit = metas.get(file);
    if (hit && hit.text === text) return hit.meta;
    const c = collectionOf(file)!;
    const doc = splitDoc(text);
    const fields = fieldsOf(doc);
    const val = (k: string) => fields.get(k)?.value ?? null;
    const rel = file.slice(c.dir ? c.dir.length + 1 : 0).replace(EXT, '').split('/');
    if (['index', '_index'].includes(rel[rel.length - 1])) rel.pop();
    const pathPart = rel.map(slugify).join('/');
    const slug = val('slug') || slugify(rel[rel.length - 1] || '');
    const fixed = [val('permalink'), val('url')].find(u => u && u.startsWith('/'));
    let url = fixed ? fixed.replace(/index\.html?$/, '') : c.url.replace('{path}', pathPart).replace('{slug}', slug);
    url = ('/' + url).replace(/\/{2,}/g, '/');
    const first = blocksOf(doc, /\.mdx$/i.test(file)).find(b => b.type === 'heading');
    const meta: Meta = { file, url, kind: c.kind, title: stripTags(val('title') || '') || (first ? textOf(mdToHtml(first.md!)) : '') || url,
                         draft: /^(true|yes)$/i.test(val('draft') || ''), doc, fields, mdx: /\.mdx$/i.test(file) };
    metas.set(file, { text, meta });
    return meta;
  }

  function pages(content: Content): Meta[] {
    const out: Meta[] = [], seen = new Set<string>();
    for (const [file, text] of Object.entries<string | null>(content.files).sort(([a], [b]) => a.localeCompare(b))) {
      if (text == null) continue;
      const m = metaOf(file, text);
      if (m.draft || seen.has(m.url)) continue;
      seen.add(m.url);
      out.push(m);
    }
    return out;
  }

  function pageOf(content: Content, url: string) {
    const p = pages(content).find(m => m.url === url);
    if (!p) throw new Error(`Page introuvable : ${url}`);
    return p;
  }

  const firstField = (m: Meta, keys: string[], scalar = true) => keys.find(k => { const f = m.fields.get(k); return f && (!scalar || f.value !== null); });

  /** The front matter field that holds the alt text of the cover photo (existing or to add). */
  function altKey(m: Meta, img: string) {
    const dot = img.indexOf('.');
    const candidates = dot > 0 ? [`${img.slice(0, dot)}.alt`] : [`${img}Alt`, `${img}_alt`, `${img}alt`, 'imageAlt', 'image_alt', 'alt'];
    return candidates.find(k => m.fields.has(k)) ?? (dot > 0 ? candidates[0] : img.includes('_') ? `${img}_alt` : `${img}Alt`);
  }

  function elementsOf(m: Meta): { el: Element; block?: Block }[] {
    const out: { el: Element; block?: Block }[] = [];
    const title = firstField(m, TITLE);
    if (title) out.push({ el: { id: 'fm.title', type: 'heading', label: 'Titre de la page', html: plainHtml(m.fields.get(title)!.value!) } });
    const img = firstField(m, IMAGE);
    if (img) out.push({ el: { id: 'fm.image', type: 'image', label: 'Photo principale', src: m.fields.get(img)!.value!, alt: m.fields.get(altKey(m, img))?.value ?? '' } });
    blocksOf(m.doc, m.mdx).forEach((b, i) => {
      if (b.type === 'other') return;
      const el: Element = { id: `b${i}`, type: b.type, label: LABELS[b.type] + (b.type === 'heading' ? ` (niveau ${b.level})` : '') };
      if (b.md !== undefined) el.html = mdToHtml(b.md);
      if (b.items) el.items = b.items.map(mdToHtml);
      if (b.img) { el.src = b.img.src; el.alt = b.img.alt; if (b.img.href) el.href = b.img.href; }
      if (b.link) { el.text = textOf(mdToHtml(b.link.text)); el.href = b.link.href; }
      out.push({ el, block: b });
    });
    return out;
  }

  const seoKeys = (m: Meta) => ({ title: firstField(m, SEO_TITLE) ?? 'title', description: firstField(m, DESCRIPTION) ?? 'description' });

  /** The text of a file once one element is changed. */
  function withElement(m: Meta, elementId: string, field: string, value: any): string {
    let text = m.doc.lines.join(m.doc.eol);
    if (elementId === 'fm.title') return setField(text, firstField(m, TITLE)!, textOf(value));
    if (elementId === 'fm.image') {
      const img = firstField(m, IMAGE)!;
      if (field === 'src') return setField(text, img, String(value));
      // an empty alt text is no alt text (and undoing an added one removes it)
      return textOf(value) ? setField(text, altKey(m, img), textOf(value)) : removeField(text, altKey(m, img));
    }
    const b = { ...blocksOf(m.doc, m.mdx)[+elementId.slice(1)] };
    if (field === 'html') b.md = md1(value);
    else if (field === 'items') b.items = (value as string[]).map(md1);
    else if (b.type === 'image') b.img = { ...b.img!, [field]: field === 'alt' ? textOf(value) : String(value) };
    else if (b.type === 'button') b.link = { ...b.link!, [field]: field === 'text' ? htmlToMd(plainHtml(value)) : String(value) };
    const lines = [...m.doc.lines];
    lines.splice(b.start, b.end - b.start, ...blockLines(b));
    return lines.join(m.doc.eol);
  }

  // ---- new blog posts, modelled on the latest post of the site
  const postsOf = (content: Content) => pages(content).filter(m => m.kind === 'post');
  const postCollection = () => collections.find(c => c.kind === 'post') ?? null;

  function latestPost(content: Content) {
    const dateOf = (m: Meta) => Date.parse(m.fields.get(firstField(m, DATE) ?? '')?.value || '') || 0;
    return postsOf(content).sort((a, b) => dateOf(b) - dateOf(a) || b.file.localeCompare(a.file))[0] ?? null;
  }

  function postMd(post: NewPost) {
    return post.blocks.map(b =>
      b.type === 'h2' || b.type === 'h3' ? `${b.type === 'h2' ? '##' : '###'} ${md1(b.html || '')}` :
      b.type === 'ul' || b.type === 'ol' ? (b.items || []).map((x, k) => `${b.type === 'ol' ? `${k + 1}.` : '-'} ${md1(x)}`).join('\n') :
      b.type === 'quote' ? `> ${md1(b.html || '')}` : md1(b.html || '')).join('\n\n');
  }

  function postFile(content: Content, slug: string) {
    const c = postCollection();
    if (!c) throw new Error('Ce site n’a pas de dossier d’articles.');
    const t = latestPost(content);
    const ext = t ? path.posix.extname(t.file) : '.md';
    const bundle = t && /(^|\/)index\.\w+$/.test(t.file);
    return `${c.dir ? c.dir + '/' : ''}${slug}${bundle ? '/index' : ''}${ext}`;
  }

  function postText(content: Content, post: NewPost, file: string) {
    const t = latestPost(content);
    const date = post.published || new Date().toISOString();
    let text: string;
    if (t) {
      text = t.doc.lines.slice(0, t.doc.fmEnd + 1).join('\n') + '\n';
      for (const k of STALE) text = removeField(text, k);
      for (const f of fieldsOf(splitDoc(text)).values()) {
        // lists (tags, categories…) start empty
        if (f.kind === 'list' && !f.key.includes('.')) {
          const d = splitDoc(text);
          d.lines.splice(f.start, f.end - f.start, `${f.indent}${f.name}${d.format === 'toml' ? ' = ' : ': '}[]`);
          text = d.lines.join('\n');
        }
      }
      const fields = fieldsOf(splitDoc(text));
      const has = (keys: string[]) => keys.find(k => fields.get(k)?.value != null);
      text = setField(text, has(TITLE) ?? 'title', post.title);
      const seoTitle = has(SEO_TITLE);
      if (seoTitle) text = setField(text, seoTitle, post.metaTitle);
      text = setField(text, has(DESCRIPTION) ?? 'description', post.metaDescription);
      const dk = has(DATE);
      if (dk) {
        const f = fields.get(dk)!;
        const v = /^\d{4}-\d\d-\d\d$/.test(f.value!) ? date.slice(0, 10) : date;
        text = setField(text, dk, v, { raw: f.style === 'plain' || f.style === 'bare' });
      }
      if (fields.get('slug')?.value != null) text = setField(text, 'slug', post.slug);
      if (fields.has('draft')) text = setField(text, 'draft', 'false', { raw: true });
      const img = has(IMAGE);
      if (img) {
        if (post.cover?.src) {
          // photos given relative to their page: the cover is written relative to the new file
          const src = relative(fields.get(img)!.value!) && post.cover.src.startsWith(cfg.mediaPrefix)
            ? toRelative(path.posix.dirname(file), mediaRepo(post.cover.src)) : post.cover.src;
          text = setField(text, img, src);
          text = setField(text, altKey({ ...t, fields } as Meta, img), post.cover.alt || '');
        } else {
          text = removeField(text, img);
          text = removeField(text, altKey({ ...t, fields } as Meta, img));
        }
      }
    } else {
      text = ['---', '---', ''].join('\n');
      text = setField(text, 'title', post.title);
      text = setField(text, 'description', post.metaDescription);
      text = setField(text, 'date', date.slice(0, 10), { raw: true });
      if (post.cover?.src) { text = setField(text, 'image', post.cover.src); text = setField(text, 'imageAlt', post.cover.alt || ''); }
    }
    return text.replace(/\n*$/, '\n') + '\n' + postMd(post) + '\n';
  }

  // ---- media
  const mediaRepo = (publicPath: string) => {
    if (!publicPath.startsWith(cfg.mediaPrefix)) throw new Error(`Chemin média inattendu : ${publicPath}`);
    return path.posix.join(cfg.mediaDir, publicPath.slice(cfg.mediaPrefix.length));
  };
  const toRelative = (fromDir: string, repoPath: string) => { const r = path.posix.relative(fromDir, repoPath); return r.startsWith('.') ? r : './' + r; };

  const readFrom = (dir: string) => (p: string) => fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p), 'utf8') : null;

  /** Markdown files of the collections in a checkout. */
  function walk(dir: string) {
    const out: string[] = [];
    const visit = (rel: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() && !SKIP_DIRS.has(e.name)) visit(p);
        else if (e.isFile() && collectionOf(p)) out.push(p);
      }
    };
    for (const c of collections) visit(c.dir);
    return [...new Set(out)];
  }

  const adapter: SiteAdapter = {
    guide: cfg.guide || '',
    contentFiles: [...new Set([...collections.map(c => c.dir || '.'), ...shared.files, cfg.mediaDir])],
    textFiles: all => [...all.filter(p => collectionOf(p)), ...shared.files],
    owns: p => !!collectionOf(p) || shared.files.includes(p),
    sharedFiles: shared.files,

    parse(read, paths) {
      const files: Record<string, string | null> = {};
      for (const p of paths) if (collectionOf(p)) { const t = read(p); if (t != null) files[p] = t; }
      return { files, shared: shared.parse(read) };
    },

    render(content, read) {
      const out: Record<string, string | null> = {};
      for (const [p, text] of Object.entries<string | null>(content.files)) {
        const cur = read(p);
        if (text == null ? cur != null : text !== cur) out[p] = text;
      }
      shared.render(content.shared, read, out);
      return out;
    },

    load(dir) { return adapter.parse(readFrom(dir), walk(dir)); },

    save(dir, content) {
      for (const [p, text] of Object.entries(adapter.render(content, readFrom(dir)))) {
        if (text == null) fs.rmSync(path.join(dir, p), { force: true });
        else { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
      }
    },

    mediaRepoPath: p => p.startsWith('/') ? mediaRepo(p) : p,

    listPages(content, kind) {
      return pages(content).filter(m => !kind || kind === 'all' || m.kind === kind)
        .map((m): PageSummary => ({ url: m.url, kind: m.kind, title: m.title }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url));
    },

    readPage(content, url) {
      const m = pages(content).find(x => x.url === url);
      if (!m) return null;
      const k = seoKeys(m);
      return { title: m.title, kind: m.kind, seo: { title: m.fields.get(k.title)?.value ?? '', description: m.fields.get(k.description)?.value ?? '' },
               elements: elementsOf(m).map(x => x.el) };
    },

    search(content, query) {
      const q = fold(query);
      if (!q) return [];
      const out: Match[] = [];
      for (const m of pages(content)) {
        for (const { el } of elementsOf(m)) {
          const text = el.type === 'list' ? el.items!.map(stripTags).join(' · ') : el.type === 'button' ? el.text! : el.type === 'image' ? el.alt || '' : stripTags(el.html || '');
          const at = fold(text).indexOf(q);
          if (at < 0) continue;
          out.push({ url: m.url, pageTitle: m.title, elementId: el.id, label: el.label, snippet: (at > 60 ? '…' : '') + text.slice(Math.max(0, at - 60), at + q.length + 80) });
          if (out.length >= 40) return out;
        }
      }
      return out;
    },

    apply(content, op) {
      if (op.kind === 'set') {
        const m = pageOf(content, op.url);
        const el = elementsOf(m).find(x => x.el.id === op.elementId)?.el;
        if (!el) throw new Error(`Élément inconnu : ${op.elementId}`);
        if (!same((el as any)[op.field] ?? '', op.before ?? '')) throw new Error(`Le contenu a changé depuis (${op.url}, ${op.elementId})`);
        content.files[m.file] = withElement(m, op.elementId, op.field, op.after);
      } else if (op.kind === 'seo') {
        const m = pageOf(content, op.url);
        const key = seoKeys(m)[op.field];
        if ((m.fields.get(key)?.value ?? '') !== (op.before ?? '')) throw new Error(`Le référencement a changé depuis (${op.url})`);
        const text = m.doc.lines.join(m.doc.eol);
        content.files[m.file] = op.after || key === 'title' ? setField(text, key, op.after) : removeField(text, key);
      } else if (op.kind === 'price') {
        throw new Error('Ce site n’a pas de prix');
      } else if (op.kind === 'create_post') {
        if (pages(content).some(m => m.url === op.url)) throw new Error(`Une page existe déjà à l’adresse ${op.url}`);
        const file = postFile(content, op.post.slug);
        if (content.files[file] != null) throw new Error(`Le fichier ${file} existe déjà`);
        content.files[file] = postText(content, op.post, file);
      } else if (op.kind === 'delete_post') {
        const m = pages(content).find(x => x.url === op.url);
        if (m) content.files[m.file] = null;
      } else if (op.kind === 'shared') {
        shared.apply(content.shared, op);
      } else if (op.kind === 'file') {
        // whole files are written by ClaudePress itself, next to the content (see changeFiles)
      } else if ((op as any).kind === 'restore_page') {
        const snap = (op as any).snapshot;
        if (snap?.file) content.files[snap.file] = snap.text;
      }
    },

    invert(op) {
      if (op.kind === 'set') return { ...op, before: op.after, after: op.before, media: undefined };
      if (op.kind === 'seo' || op.kind === 'price' || op.kind === 'shared') return { ...op, before: op.after, after: op.before } as Op;
      if (op.kind === 'file') {
        if (op.before == null) throw new Error(`Annuler la création de ${op.path} demande l’agence (suppression de fichier).`);
        return { ...op, before: op.after, after: op.before };
      }
      if (op.kind === 'create_post') return { kind: 'delete_post', url: op.url, snapshot: null };
      return { kind: 'restore_page', url: op.url, snapshot: (op as any).snapshot } as any;
    },

    highlight(content, op): Highlight {
      const h: Highlight = { url: op.url, texts: [], images: [] };
      const first = (v: unknown) => Array.isArray(v) ? stripTags(String(v[0] ?? '')) : stripTags(String(v ?? ''));
      if (op.kind === 'set') {
        if (op.field === 'src') h.images.push(path.parse(String(op.after)).name);
        else if (op.field === 'alt' || op.field === 'href') {
          const el = adapter.readPage(content, op.url)?.elements.find(e => e.id === op.elementId);
          if (el?.type === 'image') h.images.push(path.parse(el.src || '').name); else if (el) h.texts.push(el.text || '');
        } else h.texts.push(first(op.after).slice(0, 80));
      }
      if (op.kind === 'shared') h.texts.push(op.after.slice(0, 80));
      return h;
    },

    mediaPath(fileName, date, near) {
      const p = datedMediaPath(cfg.mediaPrefix, fileName, date);
      // pages that point to their photos relative to their own file (Astro's image()) get a relative address too
      const m = near ? pages(near.content).find(x => x.url === near.url) : null;
      const rel = m && elementsOf(m).some(x => x.el.type === 'image' && relative(x.el.src || ''));
      return { src: rel ? toRelative(path.posix.dirname(m!.file), mediaRepo(p)) : p, path: p };
    },

    mediaFile(dir, p) { return path.join(dir, adapter.mediaRepoPath(p)); },

    postUrl(_content, slug) {
      const c = postCollection();
      if (!c) throw new Error('Ce site n’a pas de dossier d’articles.');
      return ('/' + c.url.replace('{path}', slug).replace('{slug}', slug)).replace(/\/{2,}/g, '/');
    },

    build: dir => runBuild(dir, cfg.build, cfg.buildEnv, cfg.outDir),

    listShared: content => shared.list(content.shared),
  };
  return adapter;
}
