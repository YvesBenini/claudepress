// What a site's clients may change, kind by kind, as its agency decided: freely, once the agency approves it,
// or not at all (the agency does it, as included work or on a quote). The agency, and the people it trusts like
// itself (scope "full"), are not bound by it. Clients own what their site says; the agency owns how it looks and works.
import { db } from './db.ts';
import type { Op } from './adapters/types.ts';

export type Kind = 'content' | 'posts' | 'prices' | 'details' | 'site_texts';
export type Permission = 'allowed' | 'approval' | 'agency';
/** Kinds of change, plus pages that have their own permission for their texts and photos ("/x/", or "/blog/*" for a group). */
export type Policy = Record<Kind, Permission> & { pages: Record<string, Permission> };

export const KINDS: Kind[] = ['content', 'posts', 'prices', 'details', 'site_texts'];
export const PERMISSIONS: Permission[] = ['allowed', 'approval', 'agency'];

/** Business details and site-wide texts show on every page and are easy to get wrong: the agency looks first. */
export const DEFAULT_POLICY: Policy = { content: 'allowed', posts: 'allowed', prices: 'allowed', details: 'approval', site_texts: 'approval', pages: {} };

/** Each kind as the assistant reads it. */
export const KIND_NOTES: Record<Kind, string> = {
  content: 'texts, lists, buttons and photos of the pages, and their Google title and description',
  posts: 'blog articles: writing a new one, removing one',
  prices: 'product prices',
  details: 'the business details shown site-wide: address, phone, e-mail, opening hours',
  site_texts: 'the menu labels and the other texts shared by every page (labels, banners, footer)',
};

// A shared text is a business detail when it sits under a contact-like key ("contact.city"), or when its own key names
// one and it holds a digit or an @ ("phone": "+32 …", not "phone": "Téléphone", the label next to it).
const DETAILS_GROUP = /^(contacts?|coordonnees|coordinates|address(es)?|adresses?|business|hours|horaires?|opening_?hours)$/i;
const DETAILS_KEY = /^(phone|tel|telephone|mobile|gsm|fax|e?-?mail|address|adresse|street|rue|zip|postal_?code|postcode|city|ville|hours|horaires?|opening)$/i;

export function isDetail(path: (string | number)[], text: string) {
  const keys = path.filter((k): k is string => typeof k === 'string');
  if (keys.slice(0, -1).some(k => DETAILS_GROUP.test(k))) return true;
  return DETAILS_KEY.test(keys[keys.length - 1] || '') && /[\d@]/.test(text);
}

/** The kind of an operation; null for whole files, which only people trusted like the agency can make. */
export function kindOf(op: Op): Kind | null {
  switch (op.kind) {
    case 'set': case 'seo': return 'content';
    case 'create_post': case 'delete_post': return 'posts';
    case 'price': return 'prices';
    case 'shared': return isDetail(op.path, op.before) ? 'details' : 'site_texts';
    case 'file': return null;
  }
  return (op as { kind: string }).kind === 'restore_page' ? 'posts' : null;   // undoing a removed article
}

const PAGE = /^\/[^\s]*$/;   // an address, or a group of addresses ending with *

export async function policyOf(siteId: string): Promise<Policy> {
  const saved = await db.get<any>('policies', siteId);
  const pages = Object.fromEntries(Object.entries<string>(saved?.pages || {}).filter(([u, v]) => PAGE.test(u) && PERMISSIONS.includes(v as Permission)));
  return { ...Object.fromEntries(KINDS.map(k => [k, PERMISSIONS.includes(saved?.[k]) ? saved[k] : DEFAULT_POLICY[k]])), pages } as Policy;
}

/** Saves some of a site's permissions: kinds, and pages (null gives a page back to the kind "content"). */
export async function savePolicy(siteId: string, kinds: Partial<Record<Kind, Permission>>, pages: Record<string, Permission | null> = {}) {
  for (const [k, v] of Object.entries(kinds)) if (!KINDS.includes(k as Kind) || !PERMISSIONS.includes(v!)) throw new Error('Permission inconnue');
  for (const [u, v] of Object.entries(pages)) if (!PAGE.test(u) || (v !== null && !PERMISSIONS.includes(v))) throw new Error(`Page inconnue : ${u}`);
  const { id: _id, ...saved } = (await db.get<any>('policies', siteId)) || {};
  const merged = { ...(saved.pages || {}), ...pages };
  await db.set('policies', siteId, { ...saved, ...kinds, pages: Object.fromEntries(Object.entries(merged).filter(([, v]) => v)) });
}

export const setPermission = (siteId: string, kind: Kind, value: Permission) => savePolicy(siteId, { [kind]: value });

/** The page's own permission for its texts and photos: its address, else the longest group ("/blog/*") it falls in. */
export function pagePermission(policy: Policy, url: string): Permission | null {
  if (policy.pages[url]) return policy.pages[url];
  const group = Object.keys(policy.pages).filter(p => p.endsWith('*') && url.startsWith(p.slice(0, -1))).sort((a, b) => b.length - a.length)[0];
  return group ? policy.pages[group] : null;
}

/** What the policy says about one operation: a page's own permission wins over the kind "content". */
export function permissionOf(policy: Policy, op: Op): Permission {
  const kind = kindOf(op);
  if (!kind) return 'agency';
  return kind === 'content' ? pagePermission(policy, op.url) ?? policy.content : policy[kind];
}

/** Kinds of change among `ops` that are not freely allowed: the agency approves them before they go live. */
export function gatedKinds(policy: Policy, ops: Op[], extra: Kind[] = []): Kind[] {
  const gated = new Set<Kind>([...ops.filter(o => kindOf(o) && permissionOf(policy, o) !== 'allowed').map(o => kindOf(o)!),
    ...extra.filter(k => policy[k] !== 'allowed')]);
  return KINDS.filter(k => gated.has(k));
}
