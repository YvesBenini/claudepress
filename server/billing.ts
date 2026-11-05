// Plans, Claude and fal.ai keys and the AI credit included in a plan.
// Each account either brings its own Claude API key (it then pays Anthropic directly) or uses the key of this
// ClaudePress instance within the monthly credit of its plan. Its own key always wins when both exist.
// Images and videos work the same way with fal.ai: the account's own fal.ai key, else this instance's within the credit.
// A self-hosted server has one plan with nothing limited; a hosted service's plans and credit come from its extension
// (server/extension.ts).
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { DATA, db, monthKey, newId, notify, now } from './db.ts';
import { siteAnyState } from './sites.ts';
import { checkFalKey, falConfigured } from './fal.ts';
import { SELF_HOSTED, extension, type Plan } from './extension.ts';

export type { Plan };

/** The plans of this server, the first one for new accounts: the extension's, else the self-hosted one. */
export const allPlans = (): Plan[] => { const p = extension().plans?.(); return p?.length ? p : [SELF_HOSTED]; };
export const planById = (id: string) => allPlans().find(p => p.id === id);

/** Costs are counted in USD (API prices); credits are in EUR. */
export const EUR_PER_USD = Number(process.env.CLAUDEPRESS_EUR_PER_USD || 0.9);

/**
 * What people see: credits. 1 credit = €0.001 of Claude at Anthropic's list price (PRICE in agent.ts), with no margin
 * on top, so anyone can recompute a change's credits from its tokens. Plans still state their credit in EUR.
 */
export const CREDITS_PER_EUR = 1000;
export const toCredits = (eur: number) => Number.isFinite(eur) ? Math.round(eur * CREDITS_PER_EUR) : null;
const fmt = (n: number) => n.toLocaleString('fr-FR');

/** Before there is enough history, an edit is counted at 100 credits (a real one cost 73, longer ones cost more). */
const DEFAULT_PER_EDIT = 100;
let perEdit = { value: DEFAULT_PER_EDIT, at: 0 };

/** Average credits per change on this server (assistant edits, articles and page briefs), recomputed hourly from the last 200. */
export async function creditsPerEdit() {
  if (Date.now() - perEdit.at < 3600_000) return perEdit.value;
  const costs = (await db.find('changes', {})).filter(c => c.cost > 0).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 200).map(c => c.cost);
  const avg = costs.length >= 20 ? costs.reduce((t, c) => t + c, 0) / costs.length * EUR_PER_USD * CREDITS_PER_EUR : DEFAULT_PER_EDIT;
  perEdit = { value: Math.max(10, Math.round(avg / 10) * 10), at: Date.now() };
  return perEdit.value;
}

export interface Org { id: string; name: string; plan: string; ai_included: number; api_key_enc: string | null; api_key_last4: string | null;
  fal_key_enc?: string | null; fal_key_last4?: string | null; api_key_refused?: string | null; fal_key_refused?: string | null; brand?: Brand | null;
  monitor_site?: string | null }

/** White label: what the account's people see instead of ClaudePress. `logo` names a file in brand/, `mascot` false hides Nini. */
export interface Brand { name?: string; color?: string; logo?: string | null; icon?: string | null; mascot?: boolean }

export const orgOf = async (id: string | null | undefined) => id ? (await db.get<Org>('orgs', id)) ?? undefined : undefined;
export const orgOfSite = (siteId: string) => orgOf(siteAnyState(siteId)?.orgId);
export const planOf = (org: Org) => planById(org.plan) || allPlans()[0];

/** Uptime monitoring (server/monitor.ts): always on a self-hosted server, else included in the plan or bought on top of it. */
export const monitoringOn = (org: Org | undefined) => !!org && (planOf(org).monitoring || !!extension().addons?.(org).monitoring);
/** Security checks every day, alerts and backups (server/security.ts): the same way. */
export const securityOn = (org: Org | undefined) => !!org && (planOf(org).security || !!extension().addons?.(org).security);

/**
 * The account's white label as the app shows it, or null: none set, or a plan without white label (the settings are kept).
 * Without a name of its own, it shows the account's name.
 */
export function brandOf(org: Org | undefined) {
  const b = org?.brand;
  if (!b || !planOf(org!).whiteLabel || !(b.name || b.color || b.logo || b.icon || b.mascot === false)) return null;
  return { name: b.name || org!.name, color: b.color || null, logo: b.logo ? `/brand-logo/${b.logo}` : null, icon: b.icon ? `/brand-logo/${b.icon}` : null, mascot: b.mascot !== false };
}

// ---- keys are encrypted at rest (AES-256-GCM); the secret comes from the environment or a local file.
// An account's key is sealed to its place ("org:<id>:claude"): copied onto another account or field, it does not decrypt.
// While the secret is being changed, CLAUDEPRESS_SECRET_PREVIOUS still opens what the old one sealed; sealOldKeys moves
// the accounts' keys to the new one at start.

let secrets: Buffer[] | undefined;

/** The secret first, then the previous one. A server on Firestore (hosted) refuses to start without CLAUDEPRESS_SECRET:
 *  a secret made up on its passing disk would lose every key at the next restart. */
function secretKeys() {
  if (secrets) return secrets;
  const read = (b64: string, name: string) => {
    const k = Buffer.from(b64.trim(), 'base64');
    if (k.length !== 32) throw new Error(`${name} must be 32 bytes in base64 (openssl rand -base64 32)`);
    return k;
  };
  let current: Buffer;
  if (process.env.CLAUDEPRESS_SECRET) current = read(process.env.CLAUDEPRESS_SECRET, 'CLAUDEPRESS_SECRET');
  else if (config.storage?.type === 'firestore') throw new Error('CLAUDEPRESS_SECRET is required with Firestore storage: it encrypts the keys accounts bring');
  else {
    const file = path.join(DATA, 'secret.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    current = read(fs.readFileSync(file, 'utf8'), file);
  }
  const previous = process.env.CLAUDEPRESS_SECRET_PREVIOUS;
  return secrets = previous ? [current, read(previous, 'CLAUDEPRESS_SECRET_PREVIOUS')] : [current];
}
secretKeys();   // at start: a missing or malformed secret stops the server before it takes any key

/** `context` says where the value belongs; decrypt must be given the same. */
export function encrypt(text: string, context = '') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKeys()[0], iv);
  c.setAAD(Buffer.from(context));
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return ['v2', ...[iv, c.getAuthTag(), data].map(b => b.toString('base64'))].join('.');
}

/** `stale`: sealed before contexts (no "v2."), or with the previous secret, so worth sealing again. */
function open(blob: string, context: string) {
  const parts = blob.split('.');
  const v2 = parts[0] === 'v2';
  const [iv, tag, data] = parts.slice(v2 ? 1 : 0).map(s => Buffer.from(s, 'base64'));
  const keys = secretKeys();
  for (const [i, key] of keys.entries()) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      if (v2) d.setAAD(Buffer.from(context));
      d.setAuthTag(tag);
      return { text: Buffer.concat([d.update(data), d.final()]).toString('utf8'), stale: !v2 || i > 0 };
    } catch {}
  }
  throw new Error('Cannot decrypt: another secret, or a value moved from where it was sealed');
}

export const decrypt = (blob: string, context = '') => open(blob, context).text;

type KeyKind = 'claude' | 'fal';
const FIELD = { claude: 'api_key', fal: 'fal_key' } as const;
const keyContext = (orgId: string, kind: KeyKind) => `org:${orgId}:${kind}`;

/** An account's key in clear. Only sealed values are taken: an old unsealed one could have been copied from another account. */
function keyOf(org: Org, kind: KeyKind) {
  const blob: string = (org as any)[`${FIELD[kind]}_enc`];
  if (!blob.startsWith('v2.')) throw new Error(`The ${kind} key of ${org.id} is not sealed yet: sealOldKeys runs at start`);
  return open(blob, keyContext(org.id, kind)).text;
}

/** At start: seals the accounts' keys saved before contexts, or with the previous secret, with the current one. */
export async function sealOldKeys() {
  for (const org of await db.find<Org>('orgs', {})) {
    for (const kind of ['claude', 'fal'] as const) {
      const blob = (org as any)[`${FIELD[kind]}_enc`] as string | null | undefined;
      if (!blob) continue;
      const r = open(blob, keyContext(org.id, kind));
      if (r.stale) await db.update('orgs', org.id, { [`${FIELD[kind]}_enc`]: encrypt(r.text, keyContext(org.id, kind)) });
    }
  }
}

// ---- what happens to an account's keys is kept (key_events) and told to its administrators

type KeyAction = 'added' | 'replaced' | 'removed' | 'refused';
export interface KeyEvent { org_id: string; key: KeyKind; action: KeyAction; last4: string; user_id: string | null; user_name: string | null; at: string }
const KEY_NAME = { claude: 'Claude', fal: 'fal.ai' }, KEY_HOST = { claude: 'Anthropic', fal: 'fal.ai' };

/** The sentence for an event, the same in the notices and the history. */
export function keyEventText(e: KeyEvent) {
  const key = `la clé ${KEY_NAME[e.key]} (…${e.last4})`;
  return e.action === 'added' ? `${e.user_name} a ajouté ${key}.`
    : e.action === 'replaced' ? `${e.user_name} a remplacé la clé ${KEY_NAME[e.key]} (nouvelle clé …${e.last4}).`
    : e.action === 'removed' ? `${e.user_name} a retiré ${key}.`
    : `${KEY_HOST[e.key]} a refusé ${key} : elle a sans doute été révoquée. ${e.key === 'claude' ? 'L’assistant est' : 'Les images et vidéos sont'} en pause jusqu’à ce qu’un administrateur la remplace.`;
}

/** Records it and tells the account's administrators; whoever did it already knows. */
async function keyEvent(orgId: string, key: KeyKind, action: KeyAction, last4: string, by: { id: string; name: string } | null) {
  const e: KeyEvent = { org_id: orgId, key, action, last4, user_id: by?.id ?? null, user_name: by?.name ?? null, at: now() };
  await db.set('key_events', newId(14), e as any);
  const admins = (await db.find('users', { agency: 1, active: 1, org_id: orgId })).map(u => u.id).filter(id => id !== by?.id);
  await notify(admins, null, keyEventText(e), '#/admin/keys');
}

/** The last events of an account's keys, newest first. */
export async function keyEvents(orgId: string, n = 10) {
  return (await db.find<KeyEvent>('key_events', { org_id: orgId })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, n)
    .map(e => ({ at: e.at, key: e.key, action: e.action, text: keyEventText(e) }));
}

async function storeKey(orgId: string, kind: KeyKind, key: string, by: { id: string; name: string }) {
  const had = (await orgOf(orgId) as any)?.[`${FIELD[kind]}_enc`];
  await db.update('orgs', orgId, { [`${FIELD[kind]}_enc`]: encrypt(key, keyContext(orgId, kind)), [`${FIELD[kind]}_last4`]: key.slice(-4), [`${FIELD[kind]}_refused`]: null });
  await keyEvent(orgId, kind, had ? 'replaced' : 'added', key.slice(-4), by);
}

async function dropKey(orgId: string, kind: KeyKind, by: { id: string; name: string }) {
  const last4 = (await orgOf(orgId) as any)?.[`${FIELD[kind]}_last4`];
  await db.update('orgs', orgId, { [`${FIELD[kind]}_enc`]: null, [`${FIELD[kind]}_last4`]: null, [`${FIELD[kind]}_refused`]: null });
  if (last4) await keyEvent(orgId, kind, 'removed', last4, by);
}

/** Anthropic or fal.ai answered 401 to an account's own key (revoked, deleted): it is not tried again until replaced. Once. */
export async function keyRefused(orgId: string, kind: KeyKind) {
  const org = await orgOf(orgId) as any;
  if (!org?.[`${FIELD[kind]}_enc`] || org[`${FIELD[kind]}_refused`]) return;
  await db.update('orgs', orgId, { [`${FIELD[kind]}_refused`]: now() });
  await keyEvent(orgId, kind, 'refused', org[`${FIELD[kind]}_last4`], null);
}

const CLAUDE_REFUSED = 'Anthropic refuse la clé Claude de ce compte : elle a sans doute été révoquée. Votre administrateur doit la remplacer dans Administration → Clés IA (BYOK).';
const FAL_REFUSED = 'fal.ai refuse la clé fal.ai de ce compte : elle a sans doute été révoquée. Votre administrateur doit la remplacer dans Administration → Clés IA (BYOK).';

/** What to tell the person when a call to Claude failed: a refused own key is said as such; null for any other error. */
export async function aiProblem(siteId: string, e: unknown) {
  if (e instanceof AiUnavailable) return e;
  if (e instanceof Anthropic.AuthenticationError && (await orgOfSite(siteId))?.api_key_refused) return new AiUnavailable(CLAUDE_REFUSED, 'ai');
  return null;
}

/** Checks a Claude API key with a free call before saving it. */
export async function saveApiKey(orgId: string, key: string, by: { id: string; name: string }) {
  key = key.trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw new Error('Cette clé ne ressemble pas à une clé API Claude (elle commence par sk-ant-).');
  try {
    await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 15000 }).models.list({ limit: 1 });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new Error('Claude refuse cette clé : vérifiez-la dans la console Anthropic.');
    throw new Error('Impossible de vérifier la clé pour le moment. Réessayez dans un instant.');
  }
  await storeKey(orgId, 'claude', key, by);
}

export const removeApiKey = (orgId: string, by: { id: string; name: string }) => dropKey(orgId, 'claude', by);

/** Checks a fal.ai key (asking the status of a job that does not exist costs nothing) before saving it. */
export async function saveFalKey(orgId: string, key: string, by: { id: string; name: string }) {
  key = key.trim();
  if (!/^[\w-]{8,}:[\w-]{16,}$|^fal_[\w-]{20,}$/.test(key)) throw new Error('Cette clé ne ressemble pas à une clé fal.ai (fal.ai/dashboard/keys).');
  const ok = await checkFalKey(key).catch(() => { throw new Error('Impossible de vérifier la clé pour le moment. Réessayez dans un instant.'); });
  if (!ok) throw new Error('fal.ai refuse cette clé : vérifiez-la sur fal.ai/dashboard/keys.');
  await storeKey(orgId, 'fal', key, by);
}

export const removeFalKey = (orgId: string, by: { id: string; name: string }) => dropKey(orgId, 'fal', by);

/** Included credit used this calendar month, in EUR. */
export async function creditUsed(orgId: string) {
  return Number((await db.get('usage', `${orgId}:${monthKey()}`))?.credit || 0);
}

/**
 * Counts AI use: always its cost, and the part paid from the included credit. `mediaUsd`, the part of `costUsd` spent on
 * images and videos, is paid from the credit even with the account's own Claude key (see mediaFor).
 */
/** What one charge was for, as the usage page lists it. */
export interface UsageDetail {
  kind: 'edit' | 'post' | 'page_request' | 'scan';
  siteId?: string | null; changeId?: string | null; userId?: string | null;
  tokensIn?: number; tokensCached?: number; tokensOut?: number;
  /** images and seconds of video made with fal.ai; `mediaOwnKey` when the account's own fal.ai key paid for them */
  images?: number; videoSeconds?: number; mediaOwnKey?: boolean;
}

export async function recordUsage(orgId: string | null, costUsd: number, mode: 'own_key' | 'included', mediaUsd = 0, detail?: UsageDetail) {
  if (!orgId) return 0;
  const credit = (mode === 'included' ? costUsd : mediaUsd) * EUR_PER_USD;
  await db.increment('usage', `${orgId}:${monthKey()}`, { org_id: orgId, month: monthKey() }, { cost: costUsd, credit });
  // every charge, itemised: what Claude and fal.ai each cost, who paid them, and the credits it took
  if (detail) await db.set('usage_log', newId(12), { org_id: orgId, month: monthKey(), at: now(), kind: detail.kind,
    site_id: detail.siteId ?? null, change_id: detail.changeId ?? null, user_id: detail.userId ?? null,
    tokens_in: detail.tokensIn || 0, tokens_cached: detail.tokensCached || 0, tokens_out: detail.tokensOut || 0,
    claude_usd: Math.max(0, costUsd - mediaUsd), claude_paid_by: mode === 'included' ? 'credits' : 'own_key',
    images: detail.images || 0, video_seconds: detail.videoSeconds || 0, media_usd: mediaUsd, media_paid_by: detail.mediaOwnKey ? 'own_key' : 'credits', credit });
  if (credit) { const org = await orgOf(orgId); if (org) await extension().charged?.(org, credit); }
  return credit;
}

/** The plan's monthly AI credit for the account (EUR, Infinity: unlimited), 0 without AI included. */
export const monthlyCredit = (org: Org) => { const plan = planOf(org); return org.ai_included && plan.included ? plan.included.credit : 0; };

export async function aiStatus(org: Org) {
  const credit = monthlyCredit(org);
  const used = await creditUsed(org.id);
  const packs = await extension().reserve?.(org) ?? { eur: 0, until: null };
  return {
    keyRefused: !!(org.api_key_enc && org.api_key_refused), falKeyRefused: !!(org.fal_key_enc && org.fal_key_refused),
    mode: org.api_key_enc ? 'own_key' as const : credit || packs.eur > 0 ? 'included' as const : 'none' as const,
    credit, used, left: Math.max(0, credit - used) + packs.eur, keyLast4: org.api_key_last4,
    falKeyLast4: org.fal_key_last4 ?? null, falServer: falConfigured(),
    packs: packs.eur, packsUntil: packs.until,
  };
}

/** `need` says what the account's administrator can do about it: buy credits, or turn the assistant on. */
export class AiUnavailable extends Error {
  need: 'credits' | 'ai' | null;
  constructor(message: string, need: 'credits' | 'ai' | null = null) { super(message); this.need = need; }
}

let platformClient: Anthropic | null = null;

/**
 * The Claude client for a site: the account's own key, else the instance's key within the plan's credit.
 * A task that calls Claude several times asks `canGoOn(spent)` before each new call, `spent` being its cost so far
 * (USD, not recorded yet): so the credit is overrun by one call at most, never by a whole task.
 */
export async function aiFor(siteId: string): Promise<{ client: Anthropic; mode: 'own_key' | 'included'; canGoOn: (spentUsd: number) => Promise<boolean> }> {
  const org = await orgOfSite(siteId);
  if (!org) throw new AiUnavailable('Ce site n’est rattaché à aucun compte.');
  if (org.api_key_enc) {
    if (org.api_key_refused) throw new AiUnavailable(CLAUDE_REFUSED, 'ai');
    // a 401 is a revoked key: noted before the SDK throws, so the next calls stop here instead
    const watched: typeof fetch = async (url, init) => { const r = await fetch(url, init); if (r.status === 401) await keyRefused(org.id, 'claude'); return r; };
    return { client: new Anthropic({ apiKey: keyOf(org, 'claude'), fetch: watched }), mode: 'own_key', canGoOn: async () => true };
  }
  const s = await aiStatus(org);
  const hint = extension().hint;
  if (s.mode === 'none') throw new AiUnavailable(`L’assistant n’est pas encore activé : ${hint?.('ai') ?? 'votre administrateur doit ajouter une clé Claude'}.`, 'ai');
  if (s.left <= 0) throw new AiUnavailable(`Le crédit IA du mois est épuisé. ${hint?.('credits') ?? 'Votre administrateur peut ajouter une clé Claude'} pour continuer.`, 'credits');
  if (!process.env.ANTHROPIC_API_KEY) throw new AiUnavailable('L’IA incluse n’est pas configurée sur ce serveur.');
  platformClient ||= new Anthropic();
  return { client: platformClient, mode: 'included', canGoOn: async spent => (await aiStatus(org)).left - spent * EUR_PER_USD > 0 };
}

/**
 * Images and videos: with the account's own fal.ai key, paid to fal.ai directly and without limit; else with this server's
 * key, whatever Claude key the account uses, so paid from the plan's included AI credit. Returns why they cannot be made,
 * or the key and `canSpend(usd)`, asked before each one with what the task has taken from the credit so far plus this one (USD).
 */
export async function mediaFor(siteId: string): Promise<{ error: string } | { key: string; own: boolean; canSpend: (usd: number) => Promise<boolean>; refused?: () => Promise<void> }> {
  const org = await orgOfSite(siteId);
  if (!org) return { error: 'Ce site n’est rattaché à aucun compte.' };
  if (org.fal_key_enc) {
    if (org.fal_key_refused) return { error: FAL_REFUSED };
    return { key: keyOf(org, 'fal'), own: true, canSpend: async () => true, refused: () => keyRefused(org.id, 'fal') };
  }
  if (!falConfigured()) return { error: 'La création d’images demande une clé fal.ai : votre administrateur peut l’ajouter dans Administration → Compte.' };
  const s = await aiStatus(org);
  if (!s.credit && !s.packs) return { error: 'La création d’images demande des crédits IA, ou votre propre clé fal.ai (à ajouter par votre administrateur dans Administration → Clés IA).' };
  return { key: process.env.FAL_KEY!, own: false, canSpend: async usd => (await aiStatus(org)).left - usd * EUR_PER_USD > 0 };
}
