// Adapter for sites whose content is one JSON file of pages made of sections → rows → columns → blocks
// (the shape a WordPress/Divi export leaves behind), built by a script into a static folder.
//
// Config (config/claudepress.json → sites[].adapter):
//   { "type": "blocks-json", "pagesFile": "source/content/pages.json", "pricesFile": "source/content/prices.json",
//     "lang": "fr", "mediaDir": "source/media", "mediaPrefix": "/wp-content/uploads/",
//     "build": ["python3", "build/build.py"], "outDir": "site", "guide": "…" }

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Content, Element, Highlight, Match, NewPost, Op, PageSummary, Price, SiteAdapter } from './types.ts';
import { sharedJson } from './shared-json.ts';

export interface BlocksJsonConfig {
  type: 'blocks-json';
  pagesFile: string;
  pricesFile?: string;
  lang: string;
  mediaDir: string;
  mediaPrefix: string;
  build: string[];
  buildEnv?: Record<string, string>;
  outDir: string;
  guide?: string;
  sharedFiles?: string[];   // JSON files of texts shared by every page (labels, banners, menu), keyed by language or not
}

type Block = Record<string, any>;

const LABELS: Record<string, string> = { h: 'Titre', p: 'Paragraphe', list: 'Liste', img: 'Photo', btn: 'Bouton', quote: 'Citation' };
const TYPES: Record<string, Element['type']> = { h: 'heading', p: 'text', list: 'list', img: 'image', btn: 'button', quote: 'quote' };

export const stripTags = (h: string) => (h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export const fold = (s: string) => stripTags(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'").toLowerCase();
export const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Public path of a new photo under the site's media prefix: <prefix>yyyy/mm/<name>-xxxx.<ext>. */
export function datedMediaPath(prefix: string, fileName: string, date: Date) {
  const ext = path.extname(fileName).toLowerCase() || '.jpg';
  const base = fold(path.basename(fileName, path.extname(fileName))).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'photo';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${prefix}${date.getFullYear()}/${mm}/${base}-${Date.now().toString(36).slice(-4)}${ext}`;
}

/** Runs the site's own build command in a checkout, after installing its npm packages the first time (as Cloud Build does). */
export async function runBuild(dir: string, command: string[], env: Record<string, string> | undefined, outDir: string): Promise<{ ok: boolean; log: string; outDir: string }> {
  const run = (cmd: string, args: string[]) => new Promise<{ ok: boolean; log: string }>(resolve => {
    const child = spawn(cmd, args, { cwd: dir, env: { ...process.env, ...env } });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);
    child.on('error', e => resolve({ ok: false, log: log + String(e) }));
    child.on('close', code => resolve({ ok: code === 0, log }));
  });
  let log = '';
  if (fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    const i = await run('npm', fs.existsSync(path.join(dir, 'package-lock.json')) ? ['ci', '--silent'] : ['install', '--silent']);
    if (!i.ok) return { ok: false, log: i.log, outDir: path.join(dir, outDir) };
    log = i.log;
  }
  const [cmd, ...args] = command;
  const b = await run(cmd, args);
  return { ok: b.ok, log: log + b.log, outDir: path.join(dir, outDir) };
}

export function blocksJson(cfg: BlocksJsonConfig): SiteAdapter {
  const key = (url: string) => `${cfg.lang}:${url}`;

  function pageOf(content: Content, url: string) {
    const p = content.pages[key(url)];
    if (!p) throw new Error(`Page introuvable : ${url}`);
    return p;
  }

  function pageTitle(p: any) {
    // "Page title - Brand": keep the page part when the tail is short enough to be the site's name
    const t = (p.seo?.title || '').replace(/\s+[-–|]\s+[^-–|]{2,30}$/, '').trim();
    return t || stripTags(p.h1 || '') || p.url;
  }

  /**
   * Every block of a page with its address, nested "body" blocks included. A section's background photo
   * comes first, as a photo of its own ("s2.bg"), so it can be changed like the others.
   */
  function walk(p: any): [string, Block][] {
    const out: [string, Block][] = [];
    const visit = (blocks: Block[], prefix: string) => blocks.forEach((b, i) => {
      const id = `${prefix}.b${i}`;
      if (b.t === 'body') visit(b.blocks || [], id);
      else out.push([id, b]);
    });
    (p.sections || []).forEach((s: any, si: number) => {
      if (typeof s.bg === 'string' && s.bg) out.push([`s${si}.bg`, { t: 'bg', src: s.bg }]);
      (s.rows || []).forEach((r: any[], ri: number) => r.forEach((c: any, ci: number) => visit(c.blocks || [], `s${si}.r${ri}.c${ci}`)));
    });
    return out;
  }

  /** The section of a background photo address ("s2.bg"), or null for any other address. */
  function bgSection(p: any, id: string) {
    const m = id.match(/^s(\d+)\.bg$/);
    if (!m) return null;
    const s = p.sections?.[+m[1]];
    if (typeof s?.bg !== 'string' || !s.bg) throw new Error(`Élément inconnu : ${id}`);
    return s;
  }

  function blockAt(p: any, id: string): Block {
    const m = id.match(/^s(\d+)\.r(\d+)\.c(\d+)((?:\.b\d+)+)$/);
    if (!m) throw new Error(`Élément inconnu : ${id}`);
    let blocks: Block[] = p.sections?.[+m[1]]?.rows?.[+m[2]]?.[+m[3]]?.blocks;
    let b: Block | undefined;
    for (const part of m[4].slice(1).split('.')) {
      if (!blocks) break;
      b = blocks[+part.slice(1)];
      blocks = b?.blocks;
    }
    if (!b || !(b.t in TYPES)) throw new Error(`Élément inconnu : ${id}`);
    return b;
  }

  function toElement(id: string, b: Block): Element {
    if (b.t === 'bg') return { id, type: 'image', label: 'Photo de fond', src: b.src };   // no alt text: a background is decoration
    const e: Element = { id, type: TYPES[b.t], label: LABELS[b.t] + (b.t === 'h' ? ` (niveau ${b.level})` : '') };
    if (b.t === 'h' || b.t === 'p' || b.t === 'quote') e.html = b.html;
    if (b.t === 'list') e.items = b.items;
    if (b.t === 'img') { e.src = b.src; e.alt = b.alt; if (b.href) e.href = b.href; }
    if (b.t === 'btn') { e.text = b.text; e.href = b.href; }
    return e;
  }

  const elementText = (b: Block) => b.t === 'list' ? b.items.join(' · ') : b.t === 'btn' ? b.text : b.t === 'img' ? (b.alt || '') : (b.html || '');

  function postPage(post: NewPost, template: any) {
    const conv = post.blocks.map(b =>
      b.type === 'h2' || b.type === 'h3' ? { t: 'h', level: b.type === 'h2' ? 2 : 3, html: b.html } :
      b.type === 'ul' || b.type === 'ol' ? { t: 'list', ordered: b.type === 'ol', items: b.items || [] } :
      b.type === 'quote' ? { t: 'quote', html: b.html } : { t: 'p', html: b.html });
    return {
      url: `/${post.slug}/`, lang: cfg.lang, kind: 'post', h1: template?.h1 || post.title,
      seo: {
        title: post.metaTitle, description: post.metaDescription,
        robots: 'index, follow, max-snippet:-1, max-video-preview:-1, max-image-preview:large',
        og_image: post.cover?.src || null, og_type: 'article', published: post.published, modified: post.published, schema: [],
      },
      sections: [{ tone: 'light', bg: null, rows: [[{ w: '4_4', blocks: [{ t: 'p', html: post.title }, { t: 'body', blocks: conv }] }]] }],
    };
  }

  /** prices.json is laid out by hand (one product per line): change only the product's line. */
  function pricesText(original: string, content: Content) {
    let text = original;
    const before = JSON.parse(text).items || {};
    const after = content.prices.items || {};
    for (const url of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (same(before[url], after[url])) continue;
      const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const line = new RegExp(`^(\\s*)"${esc}":\\s*\\{[^\\n]*?\\}(,?)[ \\t]*$`, 'm');
      const value = (p: Price) => '{ ' + Object.entries(p).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ') + ' }';
      if (after[url] && line.test(text)) {
        text = text.replace(line, (_m, ind, comma) => `${ind}"${url}": ${value(after[url])}${comma}`);
      } else if (!after[url]) {
        text = text.replace(line, '').replace(/\n\s*\n/g, '\n').replace(/,(\s*\n\s*\})/, '$1');
      } else {
        text = text.replace(/("items"\s*:\s*\{)/, `$1\n    "${url}": ${value(after[url])},`);
      }
    }
    JSON.parse(text);   // never write a broken file
    return text;
  }

  const shared = sharedJson(cfg.sharedFiles || [], cfg.lang);

  const readFrom = (dir: string) => (p: string) => fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p), 'utf8') : null;

  const adapter: SiteAdapter = {
    guide: cfg.guide || '',
    contentFiles: [cfg.pagesFile, ...(cfg.pricesFile ? [cfg.pricesFile] : []), ...shared.files, cfg.mediaDir],
    textFiles: () => [cfg.pagesFile, ...(cfg.pricesFile ? [cfg.pricesFile] : []), ...shared.files],
    owns: p => [cfg.pagesFile, cfg.pricesFile, ...shared.files].includes(p),
    sharedFiles: shared.files,
    postUrl: (_content, slug) => `/${slug}/`,

    parse(read) {
      const pages = read(cfg.pagesFile);
      if (pages == null) throw new Error(`Fichier de contenu introuvable : ${cfg.pagesFile}`);
      const prices = cfg.pricesFile ? read(cfg.pricesFile) : null;
      return { pages: JSON.parse(pages), prices: prices ? JSON.parse(prices) : null, shared: shared.parse(read) };
    },

    render(content, read) {
      // same layout as the extractor writes (indent 1, no trailing newline), so commits only show what changed
      const out: Record<string, string | null> = {};
      const pages = JSON.stringify(content.pages, null, 1);
      if (pages !== read(cfg.pagesFile)) out[cfg.pagesFile] = pages;
      if (content.prices && cfg.pricesFile) {
        const orig = read(cfg.pricesFile);
        if (orig != null) { const t = pricesText(orig, content); if (t !== orig) out[cfg.pricesFile] = t; }
      }
      shared.render(content.shared, read, out);
      return out;
    },

    load(dir) { return adapter.parse(readFrom(dir), []); },

    save(dir, content) {
      for (const [p, text] of Object.entries(adapter.render(content, readFrom(dir)))) if (text != null) fs.writeFileSync(path.join(dir, p), text);
    },

    mediaRepoPath(publicPath) {
      if (!publicPath.startsWith(cfg.mediaPrefix)) throw new Error(`Chemin média inattendu : ${publicPath}`);
      return path.posix.join(cfg.mediaDir, publicPath.slice(cfg.mediaPrefix.length));
    },

    listPages(content, kind) {
      const out: PageSummary[] = [];
      for (const [k, p] of Object.entries<any>(content.pages)) {
        if (!k.startsWith(cfg.lang + ':')) continue;
        if (kind && kind !== 'all' && p.kind !== kind) continue;
        out.push({ url: p.url, kind: p.kind, title: pageTitle(p) });
      }
      return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url));
    },

    readPage(content, url) {
      const p = content.pages[key(url)];
      if (!p) return null;
      return {
        title: pageTitle(p), kind: p.kind,
        seo: { title: p.seo?.title || '', description: p.seo?.description || '' },
        elements: walk(p).filter(([, b]) => b.t in TYPES || b.t === 'bg').map(([id, b]) => toElement(id, b)),
      };
    },

    search(content, query) {
      const q = fold(query);
      if (!q) return [];
      const out: Match[] = [];
      for (const [k, p] of Object.entries<any>(content.pages)) {
        if (!k.startsWith(cfg.lang + ':')) continue;
        for (const [id, b] of walk(p)) {
          if (!(b.t in TYPES)) continue;
          const text = stripTags(elementText(b));
          const at = fold(text).indexOf(q);
          if (at < 0) continue;
          out.push({ url: p.url, pageTitle: pageTitle(p), elementId: id, label: LABELS[b.t],
                     snippet: (at > 60 ? '…' : '') + text.slice(Math.max(0, at - 60), at + q.length + 80) });
          if (out.length >= 40) return out;
        }
      }
      return out;
    },

    apply(content, op) {
      if (op.kind === 'set') {
        const sec = bgSection(pageOf(content, op.url), op.elementId);
        if (sec) {
          if (op.field !== 'src') throw new Error(`Une photo de fond n’a que sa photo (${op.url}, ${op.elementId})`);
          if (!same(sec.bg, op.before)) throw new Error(`Le contenu a changé depuis (${op.url}, ${op.elementId})`);
          sec.bg = op.after;
          return;
        }
        const b = blockAt(pageOf(content, op.url), op.elementId);
        if (!same(b[op.field], op.before)) throw new Error(`Le contenu a changé depuis (${op.url}, ${op.elementId})`);
        b[op.field] = op.after;
      } else if (op.kind === 'seo') {
        const p = pageOf(content, op.url);
        if (!same(p.seo?.[op.field] ?? '', op.before)) throw new Error(`Le référencement a changé depuis (${op.url})`);
        p.seo = { ...p.seo, [op.field]: op.after };
      } else if (op.kind === 'price') {
        if (!content.prices) throw new Error('Ce site n’a pas de prix');
        const items = content.prices.items ||= {};
        if (!same(items[op.url], op.before)) throw new Error(`Le prix a changé depuis (${op.url})`);
        if (op.after) items[op.url] = op.after; else delete items[op.url];
      } else if (op.kind === 'create_post') {
        if (content.pages[key(op.url)]) throw new Error(`Une page existe déjà à l’adresse ${op.url}`);
        const template = Object.values<any>(content.pages).find(p => p.kind === 'post' && p.lang === cfg.lang);
        content.pages[key(op.url)] = postPage(op.post, template);
      } else if (op.kind === 'delete_post') {
        delete content.pages[key(op.url)];
      } else if (op.kind === 'shared') {
        shared.apply(content.shared, op);
      } else if (op.kind === 'file') {
        // whole files are written by ClaudePress itself, next to the content (see changeFiles)
      } else if ((op as any).kind === 'restore_page') {
        content.pages[key((op as any).url)] = structuredClone((op as any).snapshot);
      }
    },

    invert(op) {
      if (op.kind === 'set') return { ...op, before: op.after, after: op.before, media: undefined };
      if (op.kind === 'seo') return { ...op, before: op.after, after: op.before };
      if (op.kind === 'price') return { ...op, before: op.after, after: op.before };
      if (op.kind === 'shared') return { ...op, before: op.after, after: op.before };
      if (op.kind === 'file') {
        if (op.before == null) throw new Error(`Annuler la création de ${op.path} demande l’agence (suppression de fichier).`);
        return { ...op, before: op.after, after: op.before };
      }
      if (op.kind === 'create_post') return { kind: 'delete_post', url: op.url, snapshot: null };
      return { kind: 'restore_page', url: op.url, snapshot: (op as any).snapshot } as any;
    },

    highlight(content, op): Highlight {
      const h: Highlight = { url: op.url, texts: [], images: [] };
      const textOf = (v: unknown) => Array.isArray(v) ? stripTags(String(v[0] ?? '')) : stripTags(String(v ?? ''));
      if (op.kind === 'set') {
        if (op.field === 'src') h.images.push(path.parse(String(op.after)).name);
        else if (op.field === 'alt' || op.field === 'href') {
          const b = blockAt(pageOf(content, op.url), op.elementId);
          if (b.t === 'img') h.images.push(path.parse(b.src).name); else h.texts.push(textOf(b.text));
        } else h.texts.push(textOf(op.after).slice(0, 80));
      }
      if (op.kind === 'shared') h.texts.push(op.after.slice(0, 80));
      // a new page is new everywhere: nothing to outline
      return h;
    },

    mediaPath(fileName, date) {
      const p = datedMediaPath(cfg.mediaPrefix, fileName, date);
      return { src: p, path: p };
    },

    mediaFile(dir, publicPath) {
      if (!publicPath.startsWith(cfg.mediaPrefix)) throw new Error(`Chemin média inattendu : ${publicPath}`);
      return path.join(dir, cfg.mediaDir, publicPath.slice(cfg.mediaPrefix.length));
    },

    build: dir => runBuild(dir, cfg.build, cfg.buildEnv, cfg.outDir),

    listShared: content => shared.list(content.shared),

    products(content) {
      return adapter.listPages(content, 'product').map(p => ({ url: p.url, title: p.title }));
    },
  };
  return adapter;
}
