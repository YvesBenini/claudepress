// Blog posts and page requests: drafted by Claude as structured data, then edited in a form.
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { config, site } from './sites.ts';
import { db } from './db.ts';
import path from 'node:path';
import { MODEL, sanitize, usageOf } from './agent.ts';
import { aiFor, orgOfSite } from './billing.ts';
import type { NewPost } from './adapters/types.ts';


const POST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'slug', 'metaTitle', 'metaDescription', 'focusKeyword', 'coverAlt', 'blocks', 'note'],
  properties: {
    title: { type: 'string', description: 'H1 of the article, natural and specific, contains the focus keyword' },
    slug: { type: 'string', description: 'lowercase words separated by hyphens, no accents, 3-6 words, contains the keyword' },
    metaTitle: { type: 'string', description: 'title shown in Google, 45-60 characters' },
    metaDescription: { type: 'string', description: 'description shown in Google, 120-155 characters, contains the keyword, ends with a full stop' },
    focusKeyword: { type: 'string', description: 'the search phrase this article should rank for, 2-4 words' },
    coverAlt: { type: 'string', description: 'alt text for the cover photo' },
    blocks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'html', 'items'],
        properties: {
          type: { type: 'string', enum: ['h2', 'h3', 'p', 'ul', 'ol', 'quote'] },
          html: { type: 'string', description: 'text for h2/h3/p/quote; inline <strong>, <em> and <a href="/…"> allowed; "" for lists' },
          items: { type: 'array', items: { type: 'string' }, description: 'list items for ul/ol; [] otherwise' },
        },
      },
    },
    note: { type: 'string', description: 'one or two sentences to the author: what you assumed or what they should check (facts, figures). Same language as the article.' },
  },
} as const;

function siteContext(siteId: string) {
  const s = site(siteId);
  const pages = s.adapter_.listPages(s.content);
  const posts = pages.filter(p => p.kind === 'post').map(p => `- ${p.title} (${p.url})`).join('\n');
  const links = pages.filter(p => p.kind !== 'post').map(p => `- ${p.title}: ${p.url}`).join('\n');
  return { s, posts, links };
}

export interface PostDraft extends NewPost { note?: string }

async function ask(siteId: string, system: string, content: Anthropic.ContentBlockParam[]) {
  const { client, mode } = await aiFor(siteId);
  const res = await client.beta.messages.create({
    model: MODEL, max_tokens: 16000, system,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: POST_SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  } as any) as Anthropic.Beta.BetaMessage;
  if (res.stop_reason === 'refusal') throw new Error('Demande refusée par le modèle.');
  const text = res.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');
  return { data: JSON.parse(text), usage: { ...usageOf(res.usage), mode } };
}

const tidy = (d: any): PostDraft => ({
  title: d.title, slug: String(d.slug).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  metaTitle: d.metaTitle, metaDescription: d.metaDescription, focusKeyword: d.focusKeyword,
  cover: d.cover ?? { src: '', alt: d.coverAlt },
  blocks: d.blocks.map((b: any) => ({ type: b.type, ...(b.type === 'ul' || b.type === 'ol' ? { items: b.items.map(sanitize) } : { html: sanitize(b.html) }) })),
  published: d.published || new Date().toISOString().slice(0, 19) + '+00:00',
  note: d.note,
});

const WRITER = (siteId: string) => {
  const { s, posts, links } = siteContext(siteId);
  return `You write blog articles for ${s.name} (${s.liveUrl}), as the business itself ("nous").
Write for real readers first and for Google second: a clear structure (an intro paragraph, 3-5 H2 sections, short paragraphs, a list where it helps, a short conclusion with an invitation to visit or order),
600-900 words, the focus keyword in the title, the first paragraph and one H2, written naturally.
Add 2-3 internal links (<a href="…">) to the pages below where they genuinely help the reader. Never invent facts, figures, awards or quotes: use only what the author gives you and general knowledge, and say in "note" what they should check.
Do not repeat an existing article; take a new angle.

${s.adapter_.guide}

Existing articles:
${posts}

Pages you can link to:
${links}`;
};

export async function draftPost(siteId: string, brief: { topic: string; points: string; keyword: string; photos: { file: string; mediaType: string }[] }) {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const p of brief.photos.slice(0, 4)) {
    const data = await db.getFile(`uploads/${path.basename(p.file)}`);
    if (data) content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType as any, data: data.toString('base64') } });
  }
  content.push({ type: 'text', text: `Subject: ${brief.topic}\nKey points from the author: ${brief.points || '(none)'}\nFocus keyword wished: ${brief.keyword || '(choose the best one)'}\nWrite the article in the language of the subject.` });
  const { data, usage } = await ask(siteId, WRITER(siteId), content);
  return { post: tidy(data), usage };
}

export async function revisePost(siteId: string, post: PostDraft, instruction: string) {
  const { data, usage } = await ask(siteId, WRITER(siteId), [{ type: 'text', text:
    `Here is the current article as JSON:\n${JSON.stringify({ ...post, coverAlt: post.cover?.alt || '' })}\n\nApply this request from the author and return the whole article: ${instruction}\nKeep everything else as it is, including the author's own wording where the request does not touch it.` }]);
  return { post: { ...tidy({ ...data, published: post.published }), cover: post.cover ? { ...post.cover, alt: data.coverAlt } : undefined }, usage };
}

const PAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pageTitle', 'goal', 'sections', 'metaTitle', 'metaDescription', 'focusKeyword', 'slug', 'questions'],
  properties: {
    pageTitle: { type: 'string' }, goal: { type: 'string', description: 'what the page is for, one sentence' },
    sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['heading', 'content'],
      properties: { heading: { type: 'string' }, content: { type: 'string', description: 'what goes in this section, 1-3 sentences' } } } },
    metaTitle: { type: 'string' }, metaDescription: { type: 'string' }, focusKeyword: { type: 'string' }, slug: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' }, description: 'what the agency still needs from the client (photos, facts), 0-4 items' },
  },
} as const;

/** Turns a client's description of a new page into a brief the agency can build from. */
export async function pageBrief(siteId: string, text: string) {
  const { s, links } = siteContext(siteId);
  const { client, mode } = await aiFor(siteId);
  const res = await client.beta.messages.create({
    model: MODEL, max_tokens: 8000,
    system: `You prepare a brief for the web agency ${(await orgOfSite(siteId))?.name || config.agencyName}, from a client's description of a new page for ${s.name} (${s.liveUrl}).
Propose a clear structure and its SEO texts (meta title 45-60 characters, description 120-155 characters ending with a full stop). Write in the client's language. Existing pages:\n${links}`,
    messages: [{ role: 'user', content: text }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PAGE_SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  } as any) as Anthropic.Beta.BetaMessage;
  if (res.stop_reason === 'refusal') throw new Error('Demande refusée par le modèle.');
  const data = JSON.parse(res.content.filter(b => b.type === 'text').map(b => (b as any).text).join(''));
  return { brief: data, usage: { ...usageOf(res.usage), mode } };
}
