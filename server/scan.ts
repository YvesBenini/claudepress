// The import scan: when a site is added (and again on request), ClaudePress reads its repository and tells the
// administrator what clients will be able to change, what is shared by every page, and what stays with the agency.
// It also proposes the site's settings and the notes for the assistant, so nobody has to guess them.
//   1. the repository's tree, then its configuration, build code and templates, and samples of its content files
//   2. Claude sorts it out (structured output), knowing what ClaudePress can edit today
//   3. the proposal is checked against the repository (files exist, the pages file reads, pages are counted)
// It also maps the site (each page, its zones, and whether a zone is content or fixed in the code) and proposes who may
// change what: the administrator reviews it and applies it, so the line between client and agency is drawn up front.
import Anthropic from '@anthropic-ai/sdk';
import { db, monthKey, notify, now } from './db.ts';
import * as GH from './github.ts';
import { MODEL, usageOf } from './agent.ts';
import { aiFor, recordUsage, toCredits } from './billing.ts';
import { siteAnyState } from './sites.ts';
import { KINDS, savePolicy, type Kind, type Permission } from './permissions.ts';

interface Area { what: string; where: string; detail: string }
/** A zone of a page: in the content files (clients change it), in a shared texts file, or fixed in the code. */
export interface Zone { name: string; source: 'content' | 'shared' | 'code'; where: string; note: string }
export interface MapPage { page: string; title: string; zones: Zone[]; proposed: Permission; why: string }
export interface ScanResult {
  framework: string;
  summary: string;
  supported: boolean;
  why: string;
  /** when not supported: the steps for the agency's developer (older scans have none) */
  convert?: string;
  /** when supported: what the developer could change once so clients edit more, without changing the design */
  improve?: string;
  /** what the agency should know about the repository: committed secrets, a build that overwrites edits… */
  red_flags?: { what: string; where: string; severity: 'high' | 'medium' | 'low'; fix: string }[];
  settings: { type: 'blocks-json' | 'markdown'; pagesFile: string; pricesFile: string; collections: string; lang: string; mediaDir: string; mediaPrefix: string; build: string; outDir: string; cacheDirs: string; sharedFiles: string } | null;
  editable: Area[];
  shared: Area[];
  locked: Area[];
  guide: string;
  site_map: MapPage[];
  permissions: { content: Permission; posts: Permission; prices: Permission; details: Permission; site_texts: Permission; why: string };
  /** the usual tasks of the site's clients, offered on the site's home (older scans have none) */
  tasks?: { label: string; prompt: string; kind: Kind }[];
  checks?: { ok: boolean; text: string }[];
  /** the proposed permissions were applied as they came, the site having none of its own yet */
  applied?: boolean;
}

const AREA = { type: 'object', additionalProperties: false, required: ['what', 'where', 'detail'], properties: {
  what: { type: 'string', description: 'what a client would call it, e.g. "Texts and photos of every page", "The « Envie de commander ? » band"' },
  where: { type: 'string', description: 'file and key, function or line where it lives, e.g. "build/build.py · T[\'fr\'][\'po_cta_text\']"' },
  detail: { type: 'string', description: 'editable: examples of what can be changed. shared: an example of the text and how the agency can make it editable. locked: why it stays with the agency' },
} } as const;

const PERMISSION = { type: 'string', enum: ['allowed', 'approval', 'agency'] } as const;

const ZONE = { type: 'object', additionalProperties: false, required: ['name', 'source', 'where', 'note'], properties: {
  name: { type: 'string', description: 'what a client would call it: "Main video and image", "Team photo", "Brand logos", "Opening hours"' },
  source: { type: 'string', enum: ['content', 'shared', 'code'], description: 'content: in the pages file (or the page\'s Markdown file) and shown as it is there, so ClaudePress changes it; shared: a string of a shared JSON file; code: written in a template or build script, or taken from the content in a way that ignores a change (a photo swapped by a mapping, a section picked by its position, a block the template never renders)' },
  where: { type: 'string', description: 'file and key, function or line, e.g. "build/build.py · HERO_POSTER", "pages.json · fr:/ · section 10 bg"' },
  note: { type: 'string', description: 'content/shared: what can be changed. code: why it is fixed and how the agency could make it editable' },
} } as const;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['framework', 'summary', 'supported', 'why', 'convert', 'improve', 'red_flags', 'settings', 'editable', 'shared', 'locked', 'guide', 'site_map', 'permissions', 'tasks'],
  properties: {
    framework: { type: 'string', description: 'how the site is made, in a few words, e.g. "Python build script → static HTML, Firebase Hosting"' },
    summary: { type: 'string', description: '2-3 plain sentences for the administrator, who may not code: what clients will be able to do, and the main limit. No file names, code, format or framework names: those go in framework and convert' },
    supported: { type: 'boolean', description: 'true when the page content is in a format ClaudePress edits: pages JSON, or Markdown files' },
    why: { type: 'string', description: 'when not supported: 1-2 plain sentences for the administrator, who may not code: why clients cannot edit the pages yet and what the agency would have to do, in everyday words: no file names, no code, nothing the summary already says; "" otherwise' },
    convert: { type: 'string', description: 'when not supported: the conversion for the agency\'s developer, as short numbered steps (1. … one per line), naming the files, the target format and the build command; "" otherwise' },
    improve: { type: 'string', description: 'when supported: what the agency\'s developer could change once so that clients can edit more, without changing what visitors see, as short numbered steps naming the files (e.g. move texts and photos hard-coded in templates into the content or a shared JSON file, give each page its own title and description, stop a build step from overwriting the content); never design, layout, styles, scripts or URLs; "" when not supported or when nothing is worth doing' },
    red_flags: { type: 'array', description: 'what the agency should know about the repository, worst first: secrets committed (API keys, tokens, passwords, private keys: name the file and the kind of secret, never copy the value), a build step that overwrites edits, content that cannot be edited safely, build pieces missing from the repository. [] when none; no opinions on style or code quality',
      items: { type: 'object', additionalProperties: false, required: ['what', 'where', 'severity', 'fix'], properties: {
        what: { type: 'string' }, where: { type: 'string', description: 'file, and line or key when useful' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'] }, fix: { type: 'string', description: 'what the agency should do, in one sentence' } } } },
    settings: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      required: ['type', 'pagesFile', 'pricesFile', 'collections', 'lang', 'mediaDir', 'mediaPrefix', 'build', 'outDir', 'cacheDirs', 'sharedFiles'],
      properties: {
        type: { type: 'string', enum: ['blocks-json', 'markdown'] },
        pagesFile: { type: 'string', description: 'pages JSON only, "" for Markdown' }, pricesFile: { type: 'string', description: 'pages JSON only; "" when there is none' },
        collections: { type: 'string', description: 'Markdown only, "" otherwise: one line per folder of pages, "<folder> <address pattern> <page|post>", most specific folders included, e.g. "src/content/blog /blog/{slug}/ post\nsrc/content/pages /{path}/ page"' },
        lang: { type: 'string', description: 'the language to edit, e.g. "fr" (pages JSON: the prefix of the page keys)' },
        mediaDir: { type: 'string', description: 'folder of the images in the repository where new photos go (Markdown with relative images, e.g. Astro image(): a folder under src/, like src/assets/uploads)' },
        mediaPrefix: { type: 'string', description: 'public URL prefix for that folder, e.g. "/wp-content/uploads/" or "/images/" (for public/images)' },
        build: { type: 'string', description: 'command that builds the site, run from the repository root, e.g. "python3 build/build.py"' },
        outDir: { type: 'string', description: 'folder the build writes the finished site to' },
        cacheDirs: { type: 'string', description: 'space-separated folders the build reuses between runs (resized images…), "" if none' },
        sharedFiles: { type: 'string', description: 'space-separated JSON files of texts shared by every page (menu, footer, labels) that already exist in the repository, "" if none' },
      } }] },
    editable: { type: 'array', items: AREA, description: 'what ClaudePress can change today' },
    shared: { type: 'array', items: AREA, description: 'texts or elements shown on many pages (header, menu, footer, banners, labels) that live outside the pages file' },
    locked: { type: 'array', items: AREA, description: 'what should stay with the agency (design, layout, forms, code, legal or contact data…)' },
    guide: { type: 'string', description: 'notes for the editing assistant, in English, 6-12 lines: what the business is, the language(s) to edit, what clients may change, what goes to the agency (name the shared texts precisely), the tone' },
    site_map: { type: 'array', description: 'the site as a client sees it: every main page one by one (home, about, contact, shop…), and pages of one kind as a group (blog articles, product pages, category pages); at most 25 entries', items: {
      type: 'object', additionalProperties: false, required: ['page', 'title', 'zones', 'proposed', 'why'], properties: {
        page: { type: 'string', description: 'the address as the content has it, e.g. "/" or "/contactez-nous/"; a group ends with *, e.g. "/project/*" (for blog posts at the root, the address of one post is not a group: list the blog index page, and the posts under the kind "posts")' },
        title: { type: 'string', description: 'the page as a client calls it: "Home", "Contact"' },
        zones: { type: 'array', items: ZONE, description: 'what the page shows, top to bottom, 3 to 10 zones; name every zone the build fixes in the code' },
        proposed: { ...PERMISSION, description: 'who should change this page\'s texts and photos: allowed for ordinary pages; approval for a page whose layout is fragile (content picked by position, many zones in code) or that matters most; agency for legal pages and pages mostly made in code' },
        why: { type: 'string', description: 'one short sentence' },
      } } },
    permissions: { type: 'object', additionalProperties: false, required: ['content', 'posts', 'prices', 'details', 'site_texts', 'why'],
      description: 'the permissions to propose for the site\'s clients. Usual: content allowed, posts allowed, prices allowed, details approval, site_texts approval. agency for a kind the site does not have or that ClaudePress cannot reach (no blog, no prices file, contact details written in the code)', properties: {
        content: PERMISSION, posts: PERMISSION, prices: PERMISSION, details: PERMISSION, site_texts: PERMISSION,
        why: { type: 'string', description: '1-2 sentences for the administrator' },
      } },
    tasks: { type: 'array', description: 'the 3 to 6 changes this business will most often ask for on its own site, read from what its content holds (a restaurant: this week\'s dishes, a holiday closure; a shop: a new product photo, a price). Only changes ClaudePress can make in content or shared zones; none for zones in code', items: {
      type: 'object', additionalProperties: false, required: ['label', 'prompt', 'kind'], properties: {
        label: { type: 'string', description: '2 to 5 words, in the language of the site\'s content, e.g. "Changer le plat du jour"' },
        prompt: { type: 'string', description: 'how the client\'s request starts, in that language, naming the page and the zone, and ending where they add their own details, e.g. "Sur la page Menu, remplace le plat du jour par "' },
        kind: { type: 'string', enum: ['content', 'posts', 'prices', 'details', 'site_texts'], description: 'the kind of change, for its permission' },
      } } },
  },
} as const;

const SYSTEM = `You examine the repository of a client website for ClaudePress, a tool that lets a web agency's clients change their site by asking in plain language. Websites are usually made with Claude Code as static sites built from content files.

What ClaudePress can edit today, in two formats:
1. "blocks-json" (pages JSON):
- one JSON file of pages: an object keyed "<lang>:<url>" (e.g. "fr:/boutique/"), each page holding title/SEO fields and sections → rows → columns → blocks, blocks having t = h (heading), p (paragraph), list, img (photo), btn (button), quote;
- optionally one prices file (JSON with "items");
- blog posts are pages of that same file.
ClaudePress edits texts, lists, buttons, photos, SEO title and description of those pages, prices, and creates blog posts.
2. "markdown": pages as Markdown or MDX files with a YAML or TOML front matter (Astro content collections or src/pages, Next.js, Hugo content/, Eleventy, Jekyll…), in folders ("collections") each published under an address pattern: {path} is the file's path in the folder without extension ("index" gives its folder), {slug} the front matter slug or the file name. List each folder of pages with its pattern and whether it holds pages or blog posts (one folder of posts at most); a more specific folder wins over its parent. Work out the pattern from the framework's routing (e.g. Astro src/pages/blog/[...slug].astro over the "blog" collection gives /blog/{slug}/; Hugo content/ gives /{path}/; mind trailingSlash settings).
ClaudePress edits the front matter title, description (and seo/meta title when there is one) and cover photo, and in the body: headings, paragraphs, simple lists, quotes, photos and link-only lines; it creates blog posts modelled on the latest one. Code blocks, tables, HTML, MDX components and shortcodes stay with the agency. No prices.
Texts written in templates, layouts or components (.astro, .tsx, .html) are not page content.
Clients also change the strings of shared JSON files listed as sharedFiles (menu labels, banners, labels; business details such as the address, phone or e-mail), within the site's permissions: by default the agency approves those before they go live.
People trusted like the agency ("full" level) change any text file of the repository (templates, styles, scripts), shown as a code diff with a staging preview.
So texts hard-coded in templates or build scripts are reachable only at the "full" level: moving them into a shared JSON file makes them editable by clients.

Your job, for the administrator who just connected the site:
1. Say how the site is built: the build command (from the repository root), the output folder, the caches the build reuses.
2. Say whether the content is in a supported format, and propose the settings (fill the fields of the other format with "").
3. List precisely what clients will be able to change (editable), what is shared by many pages but lives elsewhere (shared: quote a real example text and say where it lives and how the agency could make it editable, e.g. move those strings into a content file), and what should stay with the agency (locked: design, forms, scripts, legal pages, contact data...). Existing JSON files that hold shared texts go in sharedFiles and their texts under "shared", saying clients can change them (with the agency's approval by default).
4. Write the notes for the editing assistant.
5. Map the site (site_map): read the build code and templates to see, page by page, what really comes from the content and what the code fixes. A zone is "code" when changing the content would not change what visitors see: hard-coded texts or photos, a file name mapped to another image, a section picked by its position, a block the template skips. This is what the agency will show its client, so be exact.
6. Propose the permissions: per kind of change for the whole site, and per page in the site map. Both are for the site as it is today, so they apply as they are: when the content is not in a supported format, clients can change nothing yet and everything is "agency" (say in the permissions' why what to choose once it is converted).
7. Say what the agency's developer could do once so clients edit more without changing the design (convert, or improve), and what the agency should know (red_flags).
8. Name the client's usual tasks (tasks): the regular changes this business will make, from what its pages actually hold. They are the shortcuts on the client's home screen.
Rely only on the files you are given; when something is unclear, say so in the detail. Be concrete and short.`;

// dependencies, caches and archived copies of an old site (WordPress exports, Wayback snapshots) are not the site
const SKIP = /(^|\/)(\.git|node_modules|\.cache|\.next|\.astro|dist|vendor|__pycache__|coverage|wp-content|wp-includes|wp-admin|wayback|archives?|backups?|old)\/|\.min\.(js|css)$/i;
const BINARY = /\.(png|jpe?g|webp|gif|avif|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|pdf|zip|gz|lock)$/i;
const CONFIG = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|firebase\.json|netlify\.toml|vercel\.json|wrangler\.toml|README\.md|CLAUDE\.md|(astro|next|nuxt|vite|svelte|eleventy|tailwind)\.config\.\w+|\.eleventy\.js|_config\.yml|hugo\.(toml|ya?ml)|config\.toml|content\.config\.\w+|src\/content\/config\.\w+)$/i;
const CODE = /(^|\/)(build|scripts?|src\/(layouts|components|pages)|layouts|templates|_includes|partials|includes)\/.*\.(py|m?js|ts|tsx|jsx|astro|vue|svelte|html?|njk|liquid|hbs|ejs)$|^[^/]+\.(py|m?js)$|\.github\/workflows\/.*\.ya?ml$/i;
const CONTENT = /\.(json|ya?ml|md|mdx|toml)$/i;

/** What Claude reads: configuration and build code in full (up to a point), content as samples. */
export async function gather(repo: GH.Repo, sha: string, outDir?: string, onFile?: (read: number, total: number, path: string) => void) {
  const { files, truncated } = await GH.listTree(repo, sha);
  const kept = files.filter(f => !SKIP.test(f.path) && !(outDir && f.path.startsWith(outDir.replace(/\/?$/, '/'))));
  // the tree, with images and fonts summed up per folder
  const binaries = new Map<string, number>();
  const lines: string[] = [];
  for (const f of kept) {
    if (BINARY.test(f.path)) { const d = f.path.split('/').slice(0, -1).join('/') || '.'; binaries.set(d, (binaries.get(d) || 0) + 1); continue; }
    lines.push(`${f.path} (${Math.round(f.size / 1024 * 10) / 10} KB)`);
  }
  const tree = [...lines.slice(0, 600), ...(lines.length > 600 ? [`… and ${lines.length - 600} more text files`] : []),
    ...[...binaries].map(([d, n]) => `${d}/ : ${n} image/font/media files`), ...(truncated ? ['(GitHub truncated this tree)'] : [])].join('\n');

  const rank = (p: string) => CONFIG.test(p) ? 0 : CODE.test(p) ? 1 : CONTENT.test(p) && /(^|\/)(content|data|_data|posts|pages|src\/content)\//i.test(p) ? 2 : 9;
  const picked = kept.filter(f => !BINARY.test(f.path) && rank(f.path) < 9).sort((a, b) => rank(a.path) - rank(b.path) || a.size - b.size);
  let budget = 260_000;
  const parts: string[] = [];
  const total = Math.min(picked.length, 40);
  for (const f of picked) {
    if (budget < 2000 || parts.length >= 40) break;
    onFile?.(parts.length, total, f.path);
    const cap = Math.min(budget, rank(f.path) === 2 ? 8000 : 120_000);
    const text = await GH.readFile(repo, f.path, sha).catch(() => null);
    if (text == null) continue;
    let body = text.length > cap ? text.slice(0, cap) + `\n… (${Math.round(text.length / 1024)} KB in all, cut here)` : text;
    if (text.length > cap && /\.json$/i.test(f.path)) {
      try { const keys = Object.keys(JSON.parse(text)); body += `\nTop-level keys (${keys.length}): ${keys.slice(0, 40).join(', ')}${keys.length > 40 ? ', …' : ''}`; } catch { /* not JSON after all */ }
    }
    parts.push(`=== ${f.path} ===\n${body}`);
    budget -= body.length;
  }
  onFile?.(parts.length, parts.length, '');
  return { tree, files: parts.join('\n\n'), paths: new Set(files.map(f => f.path)) };
}

/** The proposal, held against the repository: does what it names exist, and does the pages file read? */
export async function check(repo: GH.Repo, sha: string, paths: Set<string>, r: ScanResult, en: boolean) {
  const t = (fr: string, english: string) => en ? english : fr;
  const out: { ok: boolean; text: string }[] = [];
  const st = r.settings;
  if (!r.supported || !st) return out;
  if (st.type === 'markdown') return checkMarkdown(paths, st, t);
  const pages = paths.has(st.pagesFile) ? await GH.readFile(repo, st.pagesFile, sha) : null;
  if (!pages) out.push({ ok: false, text: t(`Fichier des pages introuvable : ${st.pagesFile}`, `Pages file not found: ${st.pagesFile}`) });
  else {
    try {
      const keys = Object.keys(JSON.parse(pages));
      const mine = keys.filter(k => k.startsWith(`${st.lang}:`));
      const blocks = (pages.match(/"t"\s*:\s*"(h|p|list|img|btn|quote)"/g) || []).length;
      out.push({ ok: mine.length > 0, text: mine.length ? t(`${mine.length} pages en « ${st.lang} » (${blocks} blocs de contenu) dans ${st.pagesFile}`, `${mine.length} pages in “${st.lang}” (${blocks} content blocks) in ${st.pagesFile}`)
        : t(`Aucune page « ${st.lang}: » dans ${st.pagesFile}`, `No “${st.lang}:” page in ${st.pagesFile}`) });
      // pages that say part of them comes from the content must be in the pages file (pages made in code need not)
      const map = (r.site_map || []).filter(m => !m.page.endsWith('*') && m.zones.some(z => z.source === 'content'));
      const lost = map.filter(m => !keys.includes(`${st.lang}:${m.page}`)).map(m => m.page);
      if (map.length) out.push({ ok: !lost.length, text: lost.length ? t(`Pages de la carte absentes du fichier des pages : ${lost.join(', ')}`, `Pages of the map missing from the pages file: ${lost.join(', ')}`)
        : t(`Les ${map.length} pages de la carte existent dans ${st.pagesFile}`, `The ${map.length} pages of the map exist in ${st.pagesFile}`) });
      const other = [...new Set(keys.map(k => k.split(':')[0]).filter(l => l !== st.lang))];
      if (other.length) out.push({ ok: true, text: t(`Autres langues présentes, non modifiables pour l’instant : ${other.join(', ')}`, `Other languages present, not editable yet: ${other.join(', ')}`) });
    } catch { out.push({ ok: false, text: t(`${st.pagesFile} n’est pas un JSON lisible.`, `${st.pagesFile} is not readable JSON.`) }); }
  }
  if (st.pricesFile) out.push({ ok: paths.has(st.pricesFile), text: paths.has(st.pricesFile) ? t(`Prix : ${st.pricesFile}`, `Prices: ${st.pricesFile}`) : t(`Fichier des prix introuvable : ${st.pricesFile}`, `Prices file not found: ${st.pricesFile}`) });
  const script = st.build.split(/\s+/).find(w => /\.(py|m?js|ts|sh)$/.test(w));
  if (script) out.push({ ok: paths.has(script), text: paths.has(script) ? t(`Construction : ${st.build}`, `Build: ${st.build}`) : t(`Script de construction introuvable : ${script}`, `Build script not found: ${script}`) });
  const media = [...paths].some(p => p.startsWith(st.mediaDir.replace(/\/?$/, '/')));
  out.push({ ok: media, text: media ? t(`Images : ${st.mediaDir}`, `Images: ${st.mediaDir}`) : t(`Dossier des images vide ou introuvable : ${st.mediaDir}`, `Images folder empty or not found: ${st.mediaDir}`) });
  return out;
}

/** Markdown: do the folders exist, and how many pages does each hold? */
function checkMarkdown(paths: Set<string>, st: NonNullable<ScanResult['settings']>, t: (fr: string, en: string) => string) {
  const out: { ok: boolean; text: string }[] = [];
  const lines = st.collections.split('\n').map(l => l.trim().split(/\s+/)).filter(l => l[0]);
  if (!lines.length) out.push({ ok: false, text: t('Aucun dossier de pages Markdown proposé.', 'No folder of Markdown pages proposed.') });
  const dirs = lines.map(l => l[0].replace(/^\.?\/|\/$/g, '')).sort((a, b) => b.length - a.length);
  for (const [dir, url = '/{path}/', kind = 'page'] of lines) {
    const d = dir.replace(/^\.?\/|\/$/g, '');
    // files of this folder that no more specific folder takes
    const n = [...paths].filter(p => /\.(md|mdx|markdown)$/i.test(p) && dirs.find(x => !x || p.startsWith(x + '/')) === d).length;
    out.push({ ok: n > 0, text: n ? t(`${n} ${kind === 'post' ? 'article(s)' : 'page(s)'} Markdown dans ${d}/ → ${url}`, `${n} Markdown ${kind === 'post' ? 'post(s)' : 'page(s)'} in ${d}/ → ${url}`)
      : t(`Aucun fichier Markdown dans ${d}/`, `No Markdown file in ${d}/`) });
  }
  if (lines.filter(l => /^post/.test(l[2] || '')).length > 1) out.push({ ok: false, text: t('Un seul dossier d’articles est possible.', 'Only one folder of posts is possible.') });
  if (/^(npm|pnpm|yarn|npx)\b/.test(st.build)) out.push({ ok: paths.has('package.json'), text: paths.has('package.json') ? t(`Construction : ${st.build}`, `Build: ${st.build}`) : t('package.json introuvable', 'package.json not found') });
  return out;
}

const running = new Set<string>();

/** What the scan has done so far, shown live on the site's settings page. */
export interface ScanProgress {
  step: 'read' | 'think' | 'check';
  files: number; total: number; current: string;
  /** the part of the answer Claude is writing, by the schema's order */
  phase: string;
  framework: string; editable: string[]; shared: string[]; locked: string[]; pages: string[];
}

const ORDER = ['framework', 'summary', 'supported', 'why', 'convert', 'improve', 'red_flags', 'settings', 'editable', 'shared', 'locked', 'guide', 'site_map', 'permissions', 'tasks'];
const unq = (x: string) => { try { return JSON.parse(`"${x}"`) as string; } catch { return x; } };
const strings = (text: string, key: string) => [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map(m => unq(m[1]));

/** Reads Claude's answer while it is still being written: which part it is on, and what it has found so far. */
export function peek(text: string): Pick<ScanProgress, 'phase' | 'framework' | 'editable' | 'shared' | 'locked' | 'pages'> {
  const at: Record<string, number> = {};
  let from = 0;
  for (const k of ORDER) {   // structured output follows the schema's order: each key is searched after the one before
    const re = new RegExp(`"${k}"\\s*:`, 'g');
    re.lastIndex = from;
    const m = re.exec(text);
    if (!m) break;
    at[k] = from = m.index;
  }
  const keys = Object.keys(at);
  const part = (k: string, next: string) => at[k] == null ? '' : text.slice(at[k], at[next] ?? text.length);
  return {
    phase: keys[keys.length - 1] || '',
    framework: strings(part('framework', 'summary'), 'framework')[0] || '',
    editable: strings(part('editable', 'shared'), 'what'),
    shared: strings(part('shared', 'locked'), 'what'),
    locked: strings(part('locked', 'guide'), 'what'),
    pages: strings(part('site_map', 'permissions'), 'title'),
  };
}

/** Scans a site's repository in the background; the result is kept on the site and its administrators are told. */
export async function scanSite(siteId: string, by?: string, lang?: string) {
  const s = siteAnyState(siteId);
  if (!s || running.has(siteId)) return;
  running.add(siteId);
  const started = now();
  const progress: ScanProgress = { step: 'read', files: 0, total: 0, current: '', phase: '', framework: '', editable: [], shared: [], locked: [], pages: [] };
  // progress is written at most about once a second, in order, and always before the final state
  let writes: Promise<unknown> = db.update('sites', siteId, { scan: { state: 'running', started, progress } });
  let last = 0;
  const report = (force = false) => {
    if (!force && Date.now() - last < 1000) return;
    last = Date.now();
    const snap = { ...progress };
    writes = writes.then(() => db.update('sites', siteId, { scan: { state: 'running', started, progress: snap } })).catch(() => {});
  };
  // what Claude used, as changes show it: tokens read (some from the cache), tokens written, credits (null with the agency's own key)
  let usage: { tokens_in: number; tokens_cached: number; tokens_out: number; cost: number; credits: number | null } | undefined;
  try {
    const repo = GH.repoOf(s.repo) ?? (() => { throw new Error('L’analyse demande un dépôt github.com.'); })();
    const sha = await GH.headSha(repo, s.branch);
    // the report is written in the language the administrator reads ClaudePress in
    const en = (lang ?? (by ? (await db.get('users', by))?.lang : null)) === 'en';
    const { tree, files, paths } = await gather(repo, sha, s.adapter?.outDir, (read, total, path) => {
      Object.assign(progress, { files: read, total, current: path });
      report(!path);
    });
    progress.step = 'think';
    report(true);
    const { client, mode } = await aiFor(siteId);
    // streamed: with the site map, the answer can be long enough that the SDK asks for it; what it has found shows as it comes
    const stream = client.beta.messages.stream({
      model: MODEL, max_tokens: 24000, system: SYSTEM,
      messages: [{ role: 'user', content: `Site: ${s.name} (${s.liveUrl}), repository ${repo.owner}/${repo.name}, branch ${s.branch}.
Write framework, summary, why, the red flags' what and fix, what, detail, the site map's titles, names, notes and whys, and the permissions' why in ${en ? 'English' : 'French'} (the administrator's language); keep file names and code as they are; the guide, convert and improve stay in English (they go to Claude Code).\n\nFiles in the repository:\n${tree}\n\nFile contents:\n\n${files}` }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    } as any);
    stream.on('text', (_delta: string, snapshot: string) => {
      if (Date.now() - last < 1000) return;
      Object.assign(progress, peek(snapshot));
      report();
    });
    const res = await stream.finalMessage() as Anthropic.Beta.BetaMessage;
    // the answer is paid for as it arrives, whatever happens to it next
    const used = usageOf(res.usage);
    const credit = await recordUsage(s.orgId, used.cost, mode, 0, { kind: 'scan', siteId, userId: by ?? null, tokensIn: used.in, tokensCached: used.cached, tokensOut: used.out });
    usage = { tokens_in: used.in, tokens_cached: used.cached, tokens_out: used.out, cost: used.cost, credits: mode === 'included' ? toCredits(credit) : null };
    // and counted for the site, month by month, next to its changes
    await db.increment('scan_usage', `${siteId}:${monthKey()}`, { site_id: siteId, org_id: s.orgId, month: monthKey() }, { scans: 1, cost: used.cost, credit });
    if (res.stop_reason === 'refusal') throw new Error('Demande refusée par le modèle.');
    const result: ScanResult = JSON.parse(res.content.filter(b => b.type === 'text').map(b => (b as any).text).join(''));
    Object.assign(progress, peek(JSON.stringify(result)), { step: 'check' });
    report(true);
    result.checks = await check(repo, sha, paths, result, en);
    await writes;
    // a site nobody has set permissions on yet runs on the defaults, which may be more open than the scan advises:
    // its first proposal applies as it comes, and the administrator changes it from there
    // content ClaudePress cannot edit stays with the agency, page by page too, whatever the model proposed for later
    if (!result.supported) for (const m of result.site_map || []) m.proposed = 'agency';
    const p = result.permissions;
    if (p && !(await db.get('policies', siteId))) {
      result.applied = await savePolicy(siteId, Object.fromEntries(KINDS.map(k => [k, p[k]])),
        Object.fromEntries((result.site_map || []).filter(m => m.proposed !== p.content && /^\/\S*$/.test(m.page)).map(m => [m.page, m.proposed])))
        .then(() => true, () => false);   // a proposal the policy refuses leaves the defaults, shown as differing
    }
    await db.update('sites', siteId, { scan: { state: 'done', at: now(), sha: sha.slice(0, 7), cost: usage.cost, usage, result } });
    const admins = (await db.find('users', { agency: 1, active: 1, org_id: s.orgId })).map(u => u.id);
    await notify(by ? [by] : admins, null, en
      ? `${s.name} scanned: ${result.editable.length} editable area(s), ${result.shared.length} text(s) shared by several pages, ${result.locked.length} kept for the agency.`
      : `Analyse de ${s.name} prête : ${result.editable.length} zone(s) modifiable(s), ${result.shared.length} texte(s) commun(s) à plusieurs pages, ${result.locked.length} réservée(s) à l’agence.`,
      `#/admin/site/${siteId}`);
  } catch (e) {
    await writes;
    await db.update('sites', siteId, { scan: { state: 'failed', at: now(), error: String((e as Error).message).slice(0, 1000), usage } });
  } finally {
    running.delete(siteId);
  }
}

export async function scanOf(siteId: string) {
  return (await db.get('sites', siteId))?.scan ?? null;
}
