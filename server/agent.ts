// The assistant: Claude with a few content tools. It can read the site and propose edits to text,
// lists, buttons, photos, SEO texts and prices. Everything it does lands in the change's draft
// operations; nothing reaches the site before someone publishes.
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { config, site, applyAll, type Site } from './sites.ts';
import { db } from './db.ts';
import type { Content, Op, Price } from './adapters/types.ts';
import { stripTags } from './adapters/blocks-json.ts';
import { aiFor, mediaFor, orgOfSite, toCredits, EUR_PER_USD } from './billing.ts';
import { extension } from './extension.ts';
import { FAL_PRICE, FalKeyRefused, generateImage, generateVideo, ASPECT_RATIOS, type AspectRatio } from './fal.ts';
import { forWeb, sizeOf, closestRatio } from './images.ts';
import * as Files from './repofiles.ts';
import { unseen } from './visible.ts';
import { DEFAULT_POLICY, KIND_NOTES, KINDS, isDetail, pagePermission, type Kind, type Permission, type Policy } from './permissions.ts';
import type { MapPage } from './scan.ts';

/** How far a person may change a site: its pages, also what every page shares, or everything like the agency. */
export type Scope = 'page' | 'site' | 'full';

export const MODEL = process.env.CLAUDEPRESS_MODEL || config.model || 'claude-opus-5-5';
export const PRICE = { in: 4 / 1e6, out: 20 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 5 / 1e6 };   // Claude Opus 5.5, USD per token

export function costOf(u: Anthropic.Beta.BetaUsage) {
  return (u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out
    + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite;
}

/** Tokens of one response, shown to people as they are billed: new input, input read from or written to the cache, output. */
export const usageOf = (u: Anthropic.Beta.BetaUsage) => ({
  in: u.input_tokens || 0, cached: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens || 0, cost: costOf(u),
});

/** Inline HTML the site accepts in texts: emphasis, line breaks, links, the accent span. Everything else is dropped. */
export function sanitize(html: string) {
  return String(html ?? '')
    .replace(/<(script|style|iframe|object)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name: string, attrs: string) => {
      name = name.toLowerCase();
      const closing = tag.startsWith('</');
      if (['strong', 'em', 'b', 'i'].includes(name)) return closing ? `</${name}>` : `<${name}>`;
      if (name === 'br') return '<br>';
      if (name === 'span') return closing ? '</span>' : (/class="accent"/.test(attrs) ? '<span class="accent">' : '<span>');
      if (name === 'a') {
        if (closing) return '</a>';
        const href = attrs.match(/href="([^"]*)"/)?.[1] || '';
        return /^(https?:|mailto:|tel:|\/)/.test(href) ? `<a href="${href.replace(/"/g, '&quot;')}">` : '<a>';
      }
      return '';
    });
}

const FULL_NOTES = `This person works for the agency or is trusted like it: besides pages and shared texts, you may change any file of the site (templates, styles, scripts) with list_files, read_file, search_files, edit_file and write_file, the way a developer would.
- Read the file before editing it; make the smallest change that does the job; keep the site's code style.
- Never touch secrets or deployment workflows (the tools refuse). Content stays in the content files: use the content tools for texts, prices and shared texts.
- A full edit can break the build: tell them to check the staging site (Staging site tab) before publishing.
- You may use technical words with this person when useful, but stay brief.`;

const PERMISSION_NOTES = { allowed: 'yes', approval: 'yes, but the agency approves it before it goes live', agency: 'no, the agency does it' };

/** What this person may change: everything like the agency, or what the agency allows on this site, kind by kind. */
function permissionNotes(scope: Scope, policy: Policy) {
  if (scope === 'full') return FULL_NOTES;
  return `The agency decided what this person may change on this site:
${KINDS.map(k => `- ${KIND_NOTES[k]}: ${PERMISSION_NOTES[policy[k]]}`).join('\n')}
${Object.entries(policy.pages).map(([u, v]) => `- the texts and photos of the page ${u}${u.endsWith('*') ? ' (every page under it)' : ''}: ${PERMISSION_NOTES[v]}`).join('\n')}
- anything else (layout, new sections, adding or removing cards such as a team member, a product or a brand, forms, design, code): no, the agency does it.
When a change needs the agency's approval, make it, then say in one short sentence that the agency checks it before it goes live.
When it is the agency's, do not try it or approximate it: call request_agency with its kind, and tell them the agency will get back to them.
Texts shared by every page (edit_site_text) show on many pages at once: say so when you change one. Keep links, placeholders like {phone} and the length of short labels.`;
}

/** The agency's map of the site, read from its code: what each page shows and what the code fixes. */
function siteMap(map: MapPage[] | undefined) {
  if (!map?.length) return '';
  return `\nThe site's map, from the agency's reading of its code (zones marked "code" are fixed in the code: changing the content would not change them, so hand them to the agency):
${map.map(m => `- ${m.page} (${m.title}): ${m.zones.map(z => `${z.name} [${z.source}]`).join('; ')}`).join('\n')}\n`;
}

const SYSTEM = (s: Site, agency: string, scope: Scope, policy: Policy, map?: MapPage[]) => `You are the website assistant of ${s.name} (${s.liveUrl}), working for the agency ${agency}.
The people writing to you run the business; they are not technical. You help them change the content of their website.

How you work:
- Find what they mean first (search_site, read_page) before changing anything. Never guess an element id.
- Change what the person sees. read_page marks elements the live page does not show (not_on_live_page): never pick one when another element matches. If only such an element matches (a placeholder photo, for example), make the change, but say the site may not show it and ask them to check the staging site before publishing.
- The site's layout may place things in another order than read_page lists them: never tell the person where something sits on the page from that order.
- Make the change with the edit tools. Each edit becomes a proposal they see as a before/after, then publish or send for approval. Nothing goes live from here.
- Keep the site's tone and style. Change only what was asked; do not rewrite the surrounding text.
- Never invent facts: prices, dates, opening hours, product details, names. If something is missing, ask for it in one short question.
- If they attach a photo and want it on the site, use its reference (upload:…) with edit_image, and write a short, concrete alt text describing the photo.
- With several photos, or photos with a document: match each photo to its place by what it shows and by its file name. If you cannot tell where a photo goes, or it could go to two places, ask. A photo for something the site does not have yet (a new product) goes to the agency with that request: give its reference in request_agency's attachments.
- If they attach a document (a price list, a menu, a flyer, opening hours), it is the source: go through it line by line against the site and change everything that differs, not only the first match. Match by what each line describes (product, weight, size), not by the exact wording. Then answer in three short lists: what you changed (old → new), what was already right, and what the document has that the site does not (a new product is the agency's: request_agency), or the site has that the document does not mention (left as it is). If a line is unclear or matches two things, ask rather than guess.
- Today is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}. If they say a change applies from a later date ("from the 9th", "à partir du 9/11"), prepare it now and note that day with set_publish_date: the publish button then offers to schedule it for that day (it goes live at midnight on its own), and whoever approves it sees the date too. Tell them so in one sentence. Without a date, whatever is published goes live at once.
- If a request is outside what your tools can do (layout, new sections, menus, the footer, contact details that are not page text, forms, design, anything technical), do not try to approximate it: call request_agency with a clear summary and its kind, and tell them the agency will take it from there.
- When they say "no", "put it back" or similar, use undo_edit.

Images and videos:
- When they ask for an image they do not have (an illustration, a background, a variant or retouch of a site photo), make it with generate_image. For their own products, premises and team, a real photo is better: say so once, then make it if they still want it.
- Write the prompt in English: subject, setting, light, framing, and a style matching the site. No text, logos or real people's faces unless asked. To change an existing photo, give it as a source and say what to change and what to keep.
- When it is for a photo of the site, give that photo as spot: the image is then made in the shape of that spot. Otherwise choose the aspect ratio yourself. Look at the result: if it is not what was asked, try once more. Then put it in place with edit_image if they said where; otherwise show it and ask.
- Each image takes about ${toCredits(FAL_PRICE.image * EUR_PER_USD)} credits, a video about ${toCredits(FAL_PRICE.videoSecond * EUR_PER_USD)} per second: one at a time, no variants unless asked.
- Make a video only when they explicitly ask for one. Your tools cannot place a video on the site: it stays in the conversation, and if they want it on the site, hand it to the agency with request_agency, giving its link.

How you answer:
- In the language they write in, in short plain sentences. No technical words (no "JSON", "element id", "block", "HTML").
- After making changes, say in one line per change what you changed and where, then tell them they can check the preview on the right.
- The conversation shows plain text: no Markdown (no **, #, tables). For a list, start each line with "- "; put a title on its own line, ending with a colon.

What this person may change:
${permissionNotes(scope, policy)}

What this site lets you change:
${s.adapter_.guide || '(no particular notes)'}
${siteMap(map)}`;

const str = { type: 'string' } as const;
const tool = (name: string, description: string, properties: Record<string, any>): Anthropic.Beta.BetaTool => ({
  name, description, strict: true,
  input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});
// The API takes at most 20 strict tools: tools that only read are not strict, so every scope stays under it.
const reader: typeof tool = (...args) => ({ ...tool(...args), strict: false });

const TOOLS: Anthropic.Beta.BetaTool[] = [
  reader('list_pages', 'List the pages of the site with their address and title. kind filters by page type.',
       { kind: { type: 'string', enum: ['all', 'page', 'post', 'product', 'product_category'] } }),
  reader('read_page', 'Read the editable elements of one page (headings, texts, lists, photos, buttons) with their ids, plus its SEO title and description.',
       { url: { ...str, description: 'Page address, e.g. "/" or "/boutique/"' } }),
  reader('search_site', 'Find a word or sentence across all pages. Returns where it appears.', { query: str }),
  tool('edit_text', 'Replace the text of a heading, paragraph or quote. Inline <strong>, <em>, <br> and <a href> are allowed.',
       { url: str, element_id: str, html: str }),
  tool('edit_list', 'Replace all items of a list.', { url: str, element_id: str, items: { type: 'array', items: str } }),
  tool('edit_button', 'Change the label and/or link of a button. Pass the current value for what stays the same.',
       { url: str, element_id: str, text: str, href: str }),
  tool('edit_image', 'Change a photo and/or its alt text. image is "upload:<reference>" for a photo the person attached, an existing image path, or "" to keep the current photo.',
       { url: str, element_id: str, image: str, alt: str }),
  tool('set_seo', 'Change the SEO title (max 60 characters) and meta description (70 to 160 characters, ending with a full stop) Google shows for a page. Pass the current value for what stays the same.',
       { url: str, title: str, description: str }),
  tool('set_price', 'Set the price of a product (prices include VAT). per_kg: price per kg, sold in pieces of about `kg`. per_piece: fixed price. on_request: no price shown.',
       { url: str, mode: { type: 'string', enum: ['per_kg', 'per_piece', 'on_request'] }, amount: { type: ['number', 'null'] }, kg: { type: ['number', 'null'] } }),
  tool('generate_image', 'Create an image with an image model; it is shown to the person in the conversation and returned as an upload reference for edit_image. sources: images to start from ("upload:<reference>" or a site image path), [] for a new image. aspect_ratio "auto" keeps the shape of the first source. spot: the photo it is meant to replace, as "<page url>#<element id>", or "" when it is for no particular photo; its shape then wins over aspect_ratio.',
       { prompt: str, aspect_ratio: { type: 'string', enum: [...ASPECT_RATIOS, 'auto'] }, sources: { type: 'array', items: str }, spot: str }),
  tool('generate_video', 'Create a short silent video (takes a few minutes); it is shown to the person in the conversation. start_image: "upload:<reference>" or a site image path to bring to life, "" for none (aspect_ratio is then ignored).',
       { prompt: str, aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] }, seconds: { type: 'integer', enum: [5, 10] }, start_image: str }),
  tool('undo_edit', 'Withdraw one of the changes proposed in this conversation (number as listed by list_my_edits).', { number: { type: 'integer' } }),
  reader('list_my_edits', 'List the changes proposed so far in this conversation.', {}),
  tool('set_publish_date', 'Note the day the person wants these changes to go live, as YYYY-MM-DD (today or later), so the publish button offers to schedule them. "" when they want them live as soon as published.', { date: str }),
  tool('request_agency', 'Hand a request over to the agency: what the tools cannot do, or what this person may not change. kind: one of the kinds of change this person was told about, or structure (new sections, adding or removing cards such as a team member, product or brand, layout), design, forms, technical, other. attachments: the "upload:<reference>" of the photos and documents the person attached that this request needs ([] for none).',
       { summary: str, details: str, kind: { type: 'string', enum: [...KINDS, 'structure', 'design', 'forms', 'technical', 'other'] }, attachments: { type: 'array', items: str } }),
];

// site-wide changes: texts shared by every page
const SITE_TOOLS: Anthropic.Beta.BetaTool[] = [
  reader('list_site_texts', 'List the texts shared by every page (menu, footer, banners, labels), with their ids. query filters them ("" for all).', { query: str }),
  tool('edit_site_text', 'Replace one text shared by every page. Plain text: no HTML; keep {placeholders} as they are.', { id: str, text: str }),
];

// full edits, agency style: any text file of the repository
const FULL_TOOLS: Anthropic.Beta.BetaTool[] = [
  reader('list_files', 'List the text files of the site\'s repository under a folder ("" for all).', { prefix: str }),
  reader('read_file', 'Read a file of the repository, with line numbers. start_line from 1; max_lines up to 800.', { path: str, start_line: { type: 'integer' }, max_lines: { type: 'integer' } }),
  reader('search_files', 'Find a text in the repository\'s files (case-insensitive). prefix limits it to a folder ("" for all).', { query: str, prefix: str }),
  tool('edit_file', 'Replace old_text by new_text in a file. old_text must appear exactly once (include enough surrounding lines), unless replace_all is true.',
       { path: str, old_text: str, new_text: str, replace_all: { type: 'boolean' } }),
  tool('write_file', 'Create a new file, or replace a whole file, with the given content.', { path: str, content: str }),
];

const CONTENT_TOOLS = ['edit_text', 'edit_list', 'edit_button', 'edit_image', 'set_seo'];
/** Tools for what this person may change: a kind left to the agency has no tool, so the assistant hands it over. */
const toolsFor = (scope: Scope, policy: Policy) => scope === 'full' ? [...TOOLS, ...SITE_TOOLS, ...FULL_TOOLS] : [
  ...TOOLS.filter(t => !(policy.content === 'agency' && !Object.values(policy.pages).some(v => v !== 'agency') && CONTENT_TOOLS.includes(t.name)) && !(policy.prices === 'agency' && t.name === 'set_price')),
  ...(policy.details !== 'agency' || policy.site_texts !== 'agency' ? SITE_TOOLS : []),
];

/** What the person sent: their text, photos, and documents (PDFs) to read. */
export interface TurnInput { text: string; images: { file: string; name: string; mediaType: string }[]; files?: { file: string; name: string }[] }
/** `cost` includes `media`, the part spent on images and videos (USD). */
export interface Usage { in: number; cached: number; out: number; cost: number; media: number; mode: 'own_key' | 'included'; images: number; videoSeconds: number; mediaOwnKey: boolean }
export interface Media { type: 'image' | 'video'; url: string }
export interface TurnResult { reply: string; ops: Op[]; messages: Anthropic.Beta.BetaMessageParam[]; usage: Usage; media: Media[]; agencyRequests: { summary: string; details: string; kind: string; attachments: string[] }[]; need?: 'credits'; publishOn?: string | null }

/** A tool result with more than text, e.g. an image the assistant should look at. */
class Blocks { blocks: Anthropic.Beta.BetaToolResultBlockParam['content']; constructor(blocks: Blocks['blocks']) { this.blocks = blocks; } }

const IMAGE_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** What a step shown while the AI works carries besides its line: a pause to think, or the image it just made. */
export type StepMore = { thinking?: boolean; image?: string };

/** One turn of the conversation: the person's message, the tool calls, the final answer. */
export async function turn(siteId: string, history: Anthropic.Beta.BetaMessageParam[], opsIn: Op[], input: TurnInput,
                           progress: (line: string, more?: StepMore) => void, scope: Scope = 'page', policy: Policy = DEFAULT_POLICY): Promise<TurnResult> {
  const s = site(siteId);
  const { client, mode, canGoOn } = await aiFor(siteId);
  const map: MapPage[] | undefined = (await db.get('sites', siteId))?.scan?.result?.site_map;
  const system = SYSTEM(s, (await orgOfSite(siteId))?.name || config.agencyName, scope, policy, map);
  const tools = toolsFor(scope, policy);
  const allowed = new Set(tools.map(t => t.name));
  const ops: Op[] = structuredClone(opsIn);
  const draft = (): Content => { const c = structuredClone(s.content); applyAll(s, c, ops); return c; };
  let content = draft();
  const agencyRequests: TurnResult['agencyRequests'] = [];   // one per thing handed over, several in one turn
  let publishOn: string | null | undefined;   // the day noted with set_publish_date, if it was called

  const user: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const img of input.images) {
    user.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as any, data: ((await db.getFile(`uploads/${path.basename(img.file)}`)) ?? Buffer.alloc(0)).toString('base64') } });
    user.push({ type: 'text', text: `(Photo attached: upload:${img.file}, file name "${img.name}")` });
  }
  for (const f of input.files || []) {
    const data = await db.getFile(`uploads/${path.basename(f.file)}`);
    if (!data || path.extname(f.file) !== '.pdf') continue;
    user.push({ type: 'document', title: f.name, source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } });
    user.push({ type: 'text', text: `(Document attached: upload:${f.file}, file name "${f.name}")` });
  }
  user.push({ type: 'text', text: input.text || (input.files?.length ? '(see the document)' : '(see the photo)') });
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: 'user', content: user }];
  const usage: Usage = { in: 0, cached: 0, out: 0, cost: 0, media: 0, mode, images: 0, videoSeconds: 0, mediaOwnKey: false };
  const media: Media[] = [];
  let mediaCheck: Awaited<ReturnType<typeof mediaFor>> | undefined;
  /** Says why an image or video of `usd` cannot be made now, or null when it can. */
  const cannotMake = async (usd: number) => {
    mediaCheck ??= await mediaFor(siteId);
    if ('error' in mediaCheck) return mediaCheck.error;
    if (mediaCheck.own) return null;   // the account's own fal.ai key: paid to fal.ai directly
    // with the account's own Claude key, only images and videos come out of the credit
    return await mediaCheck.canSpend((mode === 'included' ? usage.cost : usage.media) + usd) ? null : 'Le crédit IA du mois ne suffit plus pour cela.';
  };

  /** Bytes of an image given as "upload:<reference>" or as a path on the site (this conversation's edits first, then the live site). */
  const imageOf = async (ref: string): Promise<{ data: Buffer; mediaType: string } | null> => {
    let file = ref.startsWith('upload:') ? path.basename(ref.slice(7)) : null;
    file ??= ops.flatMap(o => o.kind === 'set' && o.media && (o.media.path === ref || o.after === ref) ? [o.media.upload] : []).pop() ?? null;
    if (file) {
      const data = await db.getFile(`uploads/${file}`);
      return data && IMAGE_EXT[path.extname(file).toLowerCase()] ? { data, mediaType: IMAGE_EXT[path.extname(file).toLowerCase()] } : null;
    }
    const live = new URL(s.liveUrl), url = new URL(ref, live);
    if (url.origin !== live.origin) return null;
    try {
      const local = s.adapter_.mediaFile(s.base, url.pathname);   // sites previewed locally have a checkout
      if (fs.existsSync(local) && IMAGE_EXT[path.extname(local).toLowerCase()]) return { data: fs.readFileSync(local), mediaType: IMAGE_EXT[path.extname(local).toLowerCase()] };
    } catch {}
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    const type = res?.headers.get('content-type')?.split(';')[0] || '';
    return res?.ok && Object.values(IMAGE_EXT).includes(type) ? { data: Buffer.from(await res.arrayBuffer()), mediaType: type } : null;
  };
  /** The key images and videos are made with, once cannotMake has said they can be. */
  const falKey = () => (mediaCheck as { key: string }).key;
  /** The account's own fal.ai key refused (revoked): noted, so its administrators hear of it and it is not tried again. */
  const falFailed = async (e: unknown): Promise<never> => {
    if (e instanceof FalKeyRefused) await (mediaCheck as { refused?: () => Promise<void> }).refused?.();
    throw e;
  };
  // made on the account's own fal.ai key, they are paid to fal.ai directly: nothing to count here but how many
  const spent = (usd: number, images: number, videoSeconds: number) => {
    usage.images += images; usage.videoSeconds += videoSeconds;
    if ((mediaCheck as { own: boolean }).own) { usage.mediaOwnKey = true; return; }
    usage.cost += usd; usage.media += usd;
  };

  /** Records an edit. Several edits of the same field collapse into one, and an edit back to the original disappears. */
  const record = (op: Op) => {
    const same = (o: Op) => o.kind === op.kind && o.url === op.url &&
      (op.kind === 'set' ? (o as any).elementId === op.elementId && (o as any).field === op.field :
       op.kind === 'seo' ? (o as any).field === op.field :
       op.kind === 'shared' ? (o as any).file === op.file && JSON.stringify((o as any).path) === JSON.stringify(op.path) :
       op.kind === 'file' ? (o as any).path === op.path : true);
    const i = ops.findIndex(same);
    if (i >= 0) (op as any).before = (ops[i] as any).before, ops.splice(i, 1);
    if (JSON.stringify((op as any).before ?? null) !== JSON.stringify((op as any).after ?? null)) ops.push(op);
    content = draft();
  };

  /** The price a product shows now (this conversation's edits included), as set_price takes it; undefined on a site without prices. */
  const priceOf = (url: string, p: Price | null | undefined = content.prices?.items?.[url]) => !content.prices ? undefined
    : !p ? { mode: 'on_request' } : p.per_piece ? { mode: 'per_piece', amount: p.per_piece } : { mode: 'per_kg', amount: p.per_kg, kg: p.kg };
  const sharedText = (id: string) => (s.adapter_.listShared?.(content) || []).find(t => t.id === id);
  /** What this person may do with a kind of change: the agency's own people may do anything. */
  const may = (kind: Kind) => scope === 'full' ? 'allowed' : policy[kind];
  const sharedKind = (t: { id: string; text: string }): Kind => isDetail(JSON.parse(t.id.slice(t.id.indexOf('#') + 1)), t.text) ? 'details' : 'site_texts';
  /** Said with an edit the agency approves before it goes live. */
  const approval = (kind: Kind) => may(kind) === 'approval' ? { needs_agency_approval: true } : {};
  const theAgencys = (kind: Kind) => ({ error: `This person may not change ${KIND_NOTES[kind]}: the agency does it. Use request_agency (kind "${kind}").` });
  /** A page's texts and photos: its own permission, else the kind "content". */
  const mayOnPage = (url: string): Permission => scope === 'full' ? 'allowed' : pagePermission(policy, url) ?? policy.content;
  const pageApproval = (url: string) => mayOnPage(url) === 'approval' ? { needs_agency_approval: true } : {};

  const run = async (name: string, a: any): Promise<unknown> => {
    const ad = s.adapter_;
    if (!allowed.has(name)) return { error: `${name} is not allowed for this person.` };
    switch (name) {
      case 'list_pages': progress('Je parcours les pages du site…'); return ad.listPages(content, a.kind).map(p => p.kind === 'product' ? { ...p, price: priceOf(p.url) } : p);
      case 'read_page': {
        progress(`Je lis la page ${a.url}…`);
        const page = ad.readPage(content, a.url);
        if (!page) return { error: `No page at ${a.url}. Use list_pages.` };
        const hidden = await unseen(s, a.url);
        const may_change = mayOnPage(a.url);
        const price = page.kind === 'product' ? { price: priceOf(a.url) } : {};
        if (!hidden.size) return { ...page, ...price, may_change };
        return {
          ...page, ...price, may_change, elements: page.elements.map(e => hidden.has(e.id) ? { ...e, not_on_live_page: true } : e),
          note: 'Elements marked not_on_live_page are kept in the content, but the live page does not show them as they are: the site may not display them at all, or display something else in their place.',
        };
      }
      case 'search_site': {
        progress(`Je cherche « ${a.query} »…`);
        // texts shared by every page are found too, so the assistant can tell where something lives
        const q = stripTags(a.query).toLowerCase();
        const shared = (ad.listShared?.(content) || []).filter(t => !t.link && t.text.toLowerCase().includes(q)).slice(0, 20)
          .map(t => ({ shared: true, may_change: may(sharedKind(t)), id: t.id, key: t.key, text: t.text }));
        return [...ad.search(content, a.query), ...shared];
      }
      case 'list_site_texts': {
        progress('Je regarde les textes communs à tout le site…');
        const q = String(a.query || '').toLowerCase();
        return (ad.listShared?.(content) || []).filter(t => (scope === 'full' || !t.link) && (!q || t.text.toLowerCase().includes(q) || t.key.toLowerCase().includes(q)))
          .slice(0, 200).map(t => ({ id: t.id, key: t.key, text: t.text, may_change: may(sharedKind(t)) }));
      }
      case 'edit_site_text': {
        const t = sharedText(a.id);
        if (!t) return { error: 'Unknown id: use list_site_texts.' };
        if (t.link && scope !== 'full') return { error: 'Links of the menu and footer are changed by the agency.' };
        const kind = sharedKind(t);
        if (may(kind) === 'agency') return theAgencys(kind);
        const text = String(a.text);
        const holes = (x: string) => (x.match(/\{\w+\}/g) || []).sort().join();
        if (holes(text) !== holes(t.text)) return { error: `Keep the placeholders exactly: ${holes(t.text) || '(none)'}.` };
        if (!/[<>]/.test(t.text) && /[<>]/.test(text)) return { error: 'Plain text only, no HTML.' };
        if (!t.text.includes('"') && text.includes('"')) return { error: 'Use typographic quotes « » or “ ” instead of ".' };
        progress('Je modifie un texte commun à tout le site…');
        record({ kind: 'shared', url: '/', file: t.file, path: JSON.parse(a.id.slice(a.id.indexOf('#') + 1)), before: t.text, after: text });
        return { ok: true, note: 'Shown on every page that uses this text.', ...approval(kind) };
      }
      case 'list_files': progress('Je parcours les fichiers du site…'); return (await Files.listFiles(s, a.prefix)).slice(0, 400);
      case 'read_file': {
        progress(`Je lis ${a.path}…`);
        const text = await Files.draftText(s, ops, a.path);
        if (text == null) return { error: `${a.path} does not exist, is not a text file or is too big. Use list_files.` };
        const lines = text.split('\n'), from = Math.max(1, a.start_line || 1), n = Math.min(800, Math.max(1, a.max_lines || 400));
        return { total_lines: lines.length, text: lines.slice(from - 1, from - 1 + n).map((l, i) => `${from + i}\t${l}`).join('\n') };
      }
      case 'search_files': progress(`Je cherche « ${a.query} » dans le code…`); return Files.searchFiles(s, ops, a.query, a.prefix);
      case 'edit_file': case 'write_file': {
        const why = Files.lockedPath(s, a.path);
        if (why) return { error: why };
        const cur = await Files.draftText(s, ops, a.path);
        let after: string;
        if (name === 'edit_file') {
          if (cur == null) return { error: `${a.path} does not exist: use write_file to create it.` };
          const n = cur.split(a.old_text).length - 1;
          if (!a.old_text || n === 0) return { error: 'old_text not found: read the file again and copy it exactly.' };
          if (n > 1 && !a.replace_all) return { error: `old_text appears ${n} times: add surrounding lines, or set replace_all.` };
          after = a.replace_all ? cur.split(a.old_text).join(a.new_text) : cur.replace(a.old_text, () => a.new_text);
        } else {
          if (cur == null && await Files.exists(s, a.path)) return { error: `${a.path} is too big or not a text file.` };
          after = String(a.content);
        }
        if (after.length > 300_000 || JSON.stringify(ops).length > 700_000) return { error: 'Too big for one change: split it, or leave it to the agency.' };
        progress(`Je modifie ${a.path}…`);
        const first = ops.find(o => o.kind === 'file' && o.path === a.path) as any;
        record({ kind: 'file', url: '/', path: a.path, before: first ? first.before : await Files.repoText(s, a.path), after });
        return { ok: true };
      }
      case 'edit_text': case 'edit_list': case 'edit_button': case 'edit_image': {
        const page = ad.readPage(content, a.url);
        const el = page?.elements.find(e => e.id === a.element_id);
        if (!el) return { error: `No element ${a.element_id} on ${a.url}. Read the page first.` };
        if (mayOnPage(a.url) === 'agency') return { error: `This person may not change the page ${a.url}: the agency does it. Use request_agency (kind "content").` };
        progress(`Je modifie ${el.label.toLowerCase()} sur ${page!.title}…`);
        let note: string | undefined;
        if (name === 'edit_text') {
          if (!('html' in el)) return { error: `${el.label} is not a text. Use the tool for its type.` };
          record({ kind: 'set', url: a.url, elementId: el.id, field: 'html', before: el.html, after: sanitize(a.html) });
        } else if (name === 'edit_list') {
          if (el.type !== 'list') return { error: 'Not a list.' };
          record({ kind: 'set', url: a.url, elementId: el.id, field: 'items', before: el.items, after: a.items.map(sanitize) });
        } else if (name === 'edit_button') {
          if (el.type !== 'button') return { error: 'Not a button.' };
          record({ kind: 'set', url: a.url, elementId: el.id, field: 'text', before: el.text, after: stripTags(a.text) });
          record({ kind: 'set', url: a.url, elementId: el.id, field: 'href', before: el.href, after: a.href });
        } else {
          if (el.type !== 'image') return { error: 'Not a photo.' };
          if (a.image) {
            let src = a.image, media;
            if (a.image.startsWith('upload:')) {
              const file = path.basename(a.image.slice(7));
              if (!(await db.getFile(`uploads/${file}`))) return { error: 'Unknown upload reference.' };
              // sized for the photo it replaces and compressed as WebP
              const current = el.src ? await imageOf(el.src) : null;
              const spot = current && await sizeOf(current.data);
              const placed = await forWeb(file, spot);
              const m = ad.mediaPath(placed.file.replace(/^[a-z0-9]+-/, ''), new Date(), { content, url: a.url });
              src = m.src;
              media = { upload: placed.file, path: m.path };
              const off = spot && Math.abs(Math.log((placed.width / placed.height) / (spot.width / spot.height))) > 0.15;
              note = `Placed at ${placed.width}×${placed.height} px, WebP.` + (off ? ` Its shape differs from the photo it replaces (${spot.width}×${spot.height}): the site may crop it or change the layout. Tell the person.` : '');
            }
            record({ kind: 'set', url: a.url, elementId: el.id, field: 'src', before: el.src, after: src, media });
          }
          if ('alt' in el) record({ kind: 'set', url: a.url, elementId: el.id, field: 'alt', before: el.alt, after: stripTags(a.alt) });   // backgrounds have none
        }
        return { ok: true, edits_in_conversation: ops.length, ...(note ? { note } : {}), ...pageApproval(a.url) };
      }
      case 'set_seo': {
        const page = ad.readPage(content, a.url);
        if (!page) return { error: `No page at ${a.url}.` };
        if (mayOnPage(a.url) === 'agency') return { error: `This person may not change the page ${a.url}: the agency does it. Use request_agency (kind "content").` };
        progress(`J’adapte le référencement de ${page.title}…`);
        const warn: string[] = [];
        if (a.title.length > 60) warn.push(`title is ${a.title.length} characters (max 60): Google cuts it and the site may ignore it`);
        if (a.description.length < 70 || a.description.length > 160) warn.push(`description is ${a.description.length} characters (70-160)`);
        if (!/[.!?…]$/.test(a.description.trim())) warn.push('description must end with a full stop');
        if (warn.length) return { error: 'Not saved: ' + warn.join('; ') };
        record({ kind: 'seo', url: a.url, field: 'title', before: page.seo.title, after: a.title });
        record({ kind: 'seo', url: a.url, field: 'description', before: page.seo.description, after: a.description });
        return { ok: true, ...pageApproval(a.url) };
      }
      case 'set_price': {
        if (!content.prices) return { error: 'This site has no prices.' };
        const page = ad.readPage(content, a.url);
        if (!page || page.kind !== 'product') return { error: `${a.url} is not a product page.` };
        progress(`Je mets à jour le prix de ${page.title}…`);
        const before = content.prices.items?.[a.url] ?? null;
        const notes = Object.fromEntries(Object.entries(before || {}).filter(([k]) => k.startsWith('_')));   // keep the agency's notes
        let after: Price | null = null;
        if (a.mode === 'per_kg') { if (!a.amount || !a.kg) return { error: 'per_kg needs amount and kg' }; after = { per_kg: a.amount, kg: a.kg, ...notes }; }
        if (a.mode === 'per_piece') { if (!a.amount) return { error: 'per_piece needs amount' }; after = { per_piece: a.amount, ...notes }; }
        record({ kind: 'price', url: a.url, before, after });
        return { ok: true, was: priceOf(a.url, before), ...approval('prices') };
      }
      case 'generate_image': {
        const why = await cannotMake(FAL_PRICE.image);
        if (why) return { error: why, note: 'Tell the person, in their words.' };
        const sources = [];
        for (const ref of a.sources) sources.push((await imageOf(ref)) ?? null);
        if (sources.includes(null)) return { error: `Image not found: ${a.sources[sources.indexOf(null)]}` };
        // made in the shape of the photo it is for, when it says which
        let ratio = a.aspect_ratio as AspectRatio | 'auto', shaped = '';
        const [spotUrl, spotId] = a.spot ? [a.spot.slice(0, a.spot.lastIndexOf('#')), a.spot.slice(a.spot.lastIndexOf('#') + 1)] : [];
        const spotEl = spotUrl !== undefined ? ad.readPage(content, spotUrl)?.elements.find(e => e.id === spotId) : null;
        const spotImg = spotEl?.type === 'image' && spotEl.src ? await imageOf(spotEl.src) : null;
        const spot = spotImg && await sizeOf(spotImg.data);
        if (spot) { ratio = closestRatio(spot, ASPECT_RATIOS); shaped = ` Made in ${ratio}, the shape of that photo (${spot.width}×${spot.height}).`; }
        progress(sources.length ? 'Je retouche l’image… (une vingtaine de secondes)' : 'Je crée l’image… (une vingtaine de secondes)');
        const img = await generateImage(falKey(), a.prompt, ratio, sources as { data: Buffer; mediaType: string }[]).catch(falFailed);
        spent(img.cost, 1, 0);
        media.push({ type: 'image', url: `/api/uploads/${img.file}` });
        progress('L’image est prête.', { image: `/api/uploads/${img.file}` });
        const data = (await db.getFile(`uploads/${img.file}`))!;
        return new Blocks([
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: data.toString('base64') } },
          { type: 'text', text: JSON.stringify({ image: `upload:${img.file}`, note: 'Shown to the person. Not on the site until you use edit_image.' + shaped }) },
        ]);
      }
      case 'generate_video': {
        const why = await cannotMake(FAL_PRICE.videoSecond * a.seconds);
        if (why) return { error: why, note: 'Tell the person, in their words.' };
        const start = a.start_image ? await imageOf(a.start_image) : null;
        if (a.start_image && !start) return { error: `Image not found: ${a.start_image}` };
        progress('Je crée la vidéo… (cela prend quelques minutes)');
        const vid = await generateVideo(falKey(), a.prompt, a.aspect_ratio, a.seconds, start).catch(falFailed);
        spent(vid.cost, 0, a.seconds);
        media.push({ type: 'video', url: `/api/uploads/${vid.file}` });
        progress('La vidéo est prête.');
        return { ok: true, link: `/api/uploads/${vid.file}`, note: 'Shown to the person in the conversation, where they can download it. It is not on the site.' };
      }
      case 'list_my_edits': return ops.map((o, i) => ({ number: i + 1, ...describe(s, o) }));
      case 'undo_edit': {
        if (!ops[a.number - 1]) return { error: 'No such edit.' };
        progress('Je retire une modification…');
        ops.splice(a.number - 1, 1);
        content = draft();
        return { ok: true };
      }
      case 'set_publish_date': {
        if (!a.date) { publishOn = null; return { ok: true }; }
        const day = /^\d{4}-\d{2}-\d{2}$/.test(a.date) && !Number.isNaN(Date.parse(a.date)) ? a.date : null;
        if (!day) return { error: 'date must be YYYY-MM-DD' };
        if (day < new Date().toISOString().slice(0, 10)) return { error: 'That day is past: ask which day they mean.' };
        progress(`Je note la date de mise en ligne : ${new Date(day + 'T12:00:00').toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' })}…`);
        publishOn = day;
        return { ok: true, note: 'The person (or whoever approves it) schedules it with one click; nothing goes live before.' };
      }
      case 'request_agency':
        progress('Je transmets la demande à l’agence…');
        // only files really uploaded: the agency downloads them from the request
        const attachments: string[] = [];
        for (const ref of a.attachments || []) {
          const file = path.basename(String(ref).replace(/^upload:/, ''));
          if (!(await db.getFile(`uploads/${file}`))) return { error: `Unknown attachment ${ref}: give the upload:<reference> of a photo or document attached in this conversation.` };
          if (!attachments.includes(file)) attachments.push(file);
        }
        agencyRequests.push({ summary: a.summary, details: a.details, kind: a.kind, attachments });
        return { ok: true, note: 'The agency receives it with this conversation.' };
    }
    return { error: `Unknown tool ${name}` };
  };

  for (let i = 0; i < 25; i++) {
    // the credit was checked before the first call; check it again before each further call, counting this turn's cost
    if (i > 0 && !(await canGoOn(usage.cost)))
      return { reply: `Le crédit IA du mois est épuisé : je me suis arrêté ici. Ce qui est déjà modifié est gardé. ${extension().hint?.('credits') ?? 'Votre administrateur peut ajouter une clé Claude'} pour continuer.`, ops, messages, usage, media, agencyRequests, publishOn, need: 'credits' };
    // the screen says so while the AI decides what to do next, so the last step does not look stuck
    if (i > 0) progress('Je réfléchis à la suite…', { thinking: true });
    const res = await client.beta.messages.create({
      model: MODEL, max_tokens: 16000, system, tools, messages,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    } as any) as Anthropic.Beta.BetaMessage;
    const used = usageOf(res.usage);
    usage.in += used.in; usage.cached += used.cached; usage.out += used.out; usage.cost += used.cost;
    messages.push({ role: 'assistant', content: res.content as any });

    if (res.stop_reason === 'refusal')
      return { reply: 'Je ne peux pas traiter cette demande. Reformulez-la ou contactez l’agence.', ops, messages, usage, media, agencyRequests, publishOn };
    if (res.stop_reason === 'pause_turn') continue;
    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) {
      const reply = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map(b => b.text).join('\n').trim();
      return { reply: reply || 'C’est fait.', ops, messages, usage, media, agencyRequests, publishOn };
    }
    // tools run one after the other: an edit must see the edits made just before it
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const c of calls) {
      try {
        const out = await run(c.name, c.input);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: out instanceof Blocks ? out.blocks : JSON.stringify(out) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: c.id, content: String((e as Error).message), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: 'Je n’ai pas pu terminer : la demande demande trop d’étapes. Essayez de la découper.', ops, messages, usage, media, agencyRequests, publishOn };
}

/** Plain-language view of an operation, for the assistant and the screens. */
export function describe(s: Site, op: Op) {
  const content = s.content;
  const page = s.adapter_.readPage(content, op.url);
  const pageTitle = page?.title || (op.kind === 'create_post' ? op.post.title : op.url);
  if (op.kind === 'set') {
    const label = page?.elements.find(e => e.id === op.elementId)?.label || 'Élément';
    const what = { html: label, items: label, src: page?.elements.find(e => e.id === op.elementId)?.type === 'image' ? label : 'Photo', alt: 'Description de la photo', text: 'Texte du bouton', href: 'Lien du bouton' }[op.field];
    return { pageTitle, what, field: op.field, before: op.before, after: op.after };
  }
  if (op.kind === 'seo') return { pageTitle, what: op.field === 'title' ? 'Titre dans Google' : 'Description dans Google', field: 'seo', before: op.before, after: op.after };
  if (op.kind === 'price') {
    const fmt = (p: Price | null) => !p ? 'Prix sur demande' : p.per_piece ? `${p.per_piece} € la pièce` : `${p.per_kg} €/kg (pièce d’environ ${p.kg} kg)`;
    return { pageTitle, what: 'Prix', field: 'price', before: fmt(op.before), after: fmt(op.after) };
  }
  if (op.kind === 'create_post') return { pageTitle, what: 'Nouvel article', field: 'post', before: null, after: op.post.title };
  if (op.kind === 'shared') return { pageTitle: 'Tout le site', what: `Texte commun · ${op.path.slice(op.path[0] === (s.adapter as any).lang ? 1 : 0).join('.')}`, field: 'shared', before: op.before, after: op.after };
  if (op.kind === 'file') return { pageTitle: op.path, what: op.before == null ? 'Nouveau fichier' : 'Fichier du site', field: 'file', before: null, after: null, patch: Files.patchOf(op.before, op.after) };
  return { pageTitle, what: 'Article retiré', field: 'post', before: pageTitle, after: null };
}
