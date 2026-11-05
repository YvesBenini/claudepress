import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db, monthKey, newChange, newId, notify, now, transcript, type ChangeRow } from './db.ts';
import { readPreviewFile } from './cloudbuild.ts';
import * as GHApp from './githubapp.ts';
import { scanOf, scanSite, type ScanResult } from './scan.ts';
import { allSites, buildPreview, checkPreview, config, dropPreview, freshen, initSites, shareToken, siteByShareToken, previewDir, publish, removeSite, saveSite, setupSite, site, siteAnyState, type SiteConfig } from './sites.ts';
import { AiUnavailable, CREDITS_PER_EUR, EUR_PER_USD, aiProblem, aiStatus, allPlans, brandOf, creditsPerEdit, keyEvents, monitoringOn, orgOf, securityOn, planOf, recordUsage, removeApiKey, type UsageDetail, removeFalKey, saveApiKey, saveFalKey, sealOldKeys, toCredits } from './billing.ts';
import { loadExtension, type RouteKit } from './extension.ts';
import { mailOn, sendAccess, sendInvite } from './mail.ts';
import { livePeek } from './livepeek.ts';
import * as Insights from './insights.ts';
import * as GoLive from './golive.ts';
import * as Security from './security.ts';
import { dropMonitor, forgetAccount, monitorCoverage, monitorOverview, monitorState, monitorView, setMonitor, startMonitor, tick } from './monitor.ts';
import { INVITE_DAYS, verifyFirebaseToken, checkPassword, currentDevice, devicesOf, endAllSessions, endSession, hashPassword, newInvite, newPairCode, pairDevice, passwordProblem, recordFailure, startSession, tooManyAttempts, userByInvite, userOf, type User } from './auth.ts';
import { PRICE, describe, sanitize, turn, type Scope, type StepMore } from './agent.ts';
import { FAL_PRICE } from './fal.ts';
import { gatedKinds, KINDS, pagePermission, policyOf, savePolicy, setPermission, type Kind, type Permission, type Policy } from './permissions.ts';
import QRCode from 'qrcode';
import { stripTags } from './adapters/blocks-json.ts';
import type { MarkdownConfig } from './adapters/markdown.ts';
import { draftPost, pageBrief, revisePost } from './blog.ts';
import { forWeb, iconForWeb, logoForWeb } from './images.ts';
import type { NewPost, Op } from './adapters/types.ts';

// a hosted service's plans, payment and screens (server/extension.ts), loaded before anything reads them
const ext = await loadExtension();
const EXT_WEB = ext.web ? path.resolve(ext.web) : null;

const WEB = path.resolve('web');
const PORT = Number(process.env.PORT || config.port || 4400);
const HOST = config.host || 'localhost';
const origin = () => (config.publicUrl || `http://${HOST}:${PORT}`).replace(/\/$/, '');
/** The hosting provider's own address (…hosted.app) leads to the public one, so people sign in and bookmark one place. */
const PUBLIC_HOST = config.publicUrl ? new URL(config.publicUrl).host : null;

// ------------------------------------------------------------------ users and access

type Role = 'agency' | 'approver' | 'editor' | null;
const orgIdOfSite = (siteId: string) => siteAnyState(siteId)?.orgId ?? null;
const memberId = (siteId: string, userId: string) => `${siteId}:${userId}`;
/** Administrators manage the sites of their own account; clients reach the sites they were given. */
async function roleOn(u: User, siteId: string): Promise<Role> {
  if (u.agency && u.org_id && u.org_id === orgIdOfSite(siteId)) return 'agency';
  return ((await db.get('members', memberId(siteId, u.id)))?.role as Role) ?? null;
}
/** How far a person may change a site: administrators everything, clients what their administrator allowed. */
async function scopeOn(u: User, siteId: string): Promise<Scope> {
  if (u.agency && u.org_id && u.org_id === orgIdOfSite(siteId)) return 'full';
  const s = (await db.get('members', memberId(siteId, u.id)))?.scope;
  return s === 'site' || s === 'full' ? s : 'page';
}
const SCOPES = ['page', 'site', 'full'];
const scopeOf = (v: unknown): Scope => SCOPES.includes(v as string) ? v as Scope : 'page';
async function agencyUsers(siteId: string) {
  const org = orgIdOfSite(siteId);
  return org ? (await db.find('users', { agency: 1, active: 1, org_id: org })).map(r => r.id) : [];
}
async function approversOf(siteId: string) {
  const ids: string[] = [];
  for (const m of await db.find('members', { site_id: siteId, role: 'approver' })) if ((await db.get('users', m.user_id))?.active) ids.push(m.user_id);
  return [...ids, ...await agencyUsers(siteId)];
}
/** Names looked up once per request. */
function names() {
  const cache = new Map<string, Promise<string>>();
  return (id: string | null) => {
    if (!id) return Promise.resolve(null);
    if (!cache.has(id)) cache.set(id, db.get('users', id).then(u => u?.name || '?'));
    return cache.get(id)!;
  };
}

/** Admins and clients allowed to publish put changes online themselves; other clients send them for review. */
const canPublishRole = (role: Role) => role === 'agency' || role === 'approver';

/**
 * Kinds of change in `c` that the site's permissions send to the agency for approval, for this person: none for the
 * agency and the people it trusts like itself. A client who may publish still sends these for review.
 */
async function agencyApproval(c: ChangeRow, u: User, role: Role): Promise<Kind[]> {
  if (role === 'agency' || await scopeOn(u, c.site_id) === 'full') return [];
  return gatedKinds(await policyOf(c.site_id), JSON.parse(c.ops), c.type === 'post' ? ['posts'] : []);
}

// ------------------------------------------------------------------ http helpers

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

async function bodyOf(req: http.IncomingMessage, limit = 1 << 20): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) fail(413, 'Fichier trop lourd');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const json = async (req: http.IncomingMessage) => { const b = await bodyOf(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.pdf': 'application/pdf', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function serveFile(res: http.ServerResponse, file: string, extraHtml = '', status = 200) {
  const ext = path.extname(file).toLowerCase();
  let body: Buffer | string = fs.readFileSync(file);
  if (ext === '.html' && extraHtml) {
    const s = body.toString('utf8');
    body = s.includes('</head>') ? s.replace('</head>', extraHtml + '</head>') : s.includes('</body>') ? s.replace('</body>', extraHtml + '</body>') : s + extraHtml;
  }
  res.writeHead(status, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

/** Rewrites root-relative URLs of a built page so it works under /preview/…/ on ClaudePress's own address. */
function rebase(text: string, prefix: string, css = false) {
  const fix = (u: string) => u.startsWith('/') && !u.startsWith('//') ? prefix + u : u;
  text = text.replace(/url\((['"]?)\/(?!\/)/g, `url($1${prefix}/`);
  if (css) return text;
  return text
    .replace(/(\s(?:href|src|poster|action|data-[a-z0-9-]+)=)(["'])\/(?!\/)/gi, `$1$2${prefix}/`)
    .replace(/(\s(?:srcset|imagesrcset)=)(["'])([^"']*)\2/gi, (_m, a, q, v) => a + q + v.split(',').map((part: string) => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [fix(u), ...rest].join(' ');
    }).join(', ') + q);
}

/** Serves a built site the way static hosts do (/x/ → /x/index.html, unknown → 404.html), rebased under `prefix`. */
function serveSite(res: http.ServerResponse, root: string, prefix: string, urlPath: string, fallback?: (p: string) => string | null) {
  const p = path.normalize(decodeURIComponent(urlPath || '/')).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(root, p);
  if (!file.startsWith(root)) return send(res, 403, { error: 'forbidden' });
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  let status = 200;
  if (!fs.existsSync(file)) {
    const alt = fallback?.(p);
    if (alt && fs.existsSync(alt)) file = alt;
    else { file = path.join(root, '404.html'); status = 404; }
  }
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(status, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  if (ext === '.html') {
    const html = rebase(fs.readFileSync(file, 'utf8'), prefix);
    const tag = '<script src="/highlight.js"></script>';
    return res.end(html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag);
  }
  if (ext === '.css') return res.end(rebase(fs.readFileSync(file, 'utf8'), prefix, true));
  fs.createReadStream(file).pipe(res);
}

/** Serves a preview built by ClaudePress (in the preview bucket) under `prefix`, like a static host would. */
async function serveBuilt(res: http.ServerResponse, folder: string, prefix: string, rest: string, banner = false) {
  const p = path.posix.normalize(decodeURIComponent(rest || '/')).replace(/^(\.\.\/)+/, '').replace(/^\//, '');
  const tries = p === '' || p.endsWith('/') ? [`${p}index.html`] : [p, `${p}/index.html`, `${p}.html`];
  let file = null, name = '', status = 200;
  for (const t of tries) { file = await readPreviewFile(`${folder}/${t}`); if (file) { name = t; break; } }
  if (!file) { file = await readPreviewFile(`${folder}/404.html`); name = '404.html'; status = 404; }
  if (!file) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Cet aperçu n’existe plus.'); }
  const ext = path.extname(name).toLowerCase();
  res.writeHead(status, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' });
  if (ext === '.html') {
    let html = rebase(file.toString('utf8'), prefix);
    const tag = banner
      ? '<div style="position:fixed;z-index:2147483647;left:12px;bottom:12px;background:#1d2127;color:#fff;font:600 13px/1.3 system-ui,sans-serif;padding:9px 13px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.25)">Aperçu · pas encore en ligne</div>'
      : '<script src="/highlight.js"></script>';
    return res.end(html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag);
  }
  if (ext === '.css') return res.end(rebase(file.toString('utf8'), prefix, true));
  res.end(file);
}

/** Shows a page of a site hosted elsewhere (live site, preview channel) as if it were served here. */
async function proxySite(res: http.ServerResponse, origin: string, prefix: string, rest: string) {
  const up = await fetch(origin.replace(/\/$/, '') + rest, { redirect: 'follow', headers: { 'user-agent': 'ClaudePress preview' } });
  const type = up.headers.get('content-type') || 'application/octet-stream';
  res.writeHead(up.status, { 'content-type': type, 'cache-control': 'no-store' });
  if (type.includes('text/html')) {
    const html = rebase(await up.text(), prefix);
    const tag = '<script src="/highlight.js"></script>';
    return res.end(html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag);
  }
  if (type.includes('text/css')) return res.end(rebase(await up.text(), prefix, true));
  res.end(Buffer.from(await up.arrayBuffer()));
}

// ------------------------------------------------------------------ change views

async function changeOf(id: string, u: User) {
  const c = (await db.get<ChangeRow>('changes', id)) ?? fail(404, 'Modification introuvable');
  const role = await roleOn(u, c.site_id);
  if (!role) fail(403, 'Accès refusé');
  return { c, role };
}

async function view(c: ChangeRow, u: User, role: Role) {
  const s = site(c.site_id);
  const ops: Op[] = JSON.parse(c.ops);
  const outRel = path.relative(s.base, s.baseOut);
  const items = ops.map((op, index) => {
    let hlAfter = { url: op.url, texts: [] as string[], images: [] as string[] }, hlBefore = hlAfter;
    try { hlAfter = s.adapter_.highlight(s.content, op); } catch {}
    try { if (op.kind !== 'create_post') hlBefore = s.adapter_.highlight(s.content, s.adapter_.invert(op)); } catch {}
    const media = op.kind === 'set' && op.media ? `/api/uploads/${op.media.upload}` : null;
    return { index, kind: op.kind, url: op.url, ...describe(s, op), afterMedia: media, hlBefore, hlAfter };
  });
  const name = names();
  const mine = c.author_id === u.id;
  const open = c.status === 'draft' || c.status === 'changes_requested';
  const hasWork = ops.length > 0 || (c.type === 'post' && !!c.post);
  const gated = await agencyApproval(c, u, role);
  const paused = await pausedReason(c.site_id);
  const publisher = canPublishRole(role) && !gated.length && !paused;
  const scheduled = c.status === 'scheduled';
  return {
    ...c, ops: undefined, live_expect: undefined, credits: toCredits(c.credit_used || 0), live: GoLive.liveOfChange(c),
    chat: JSON.parse(c.chat), post: c.post ? JSON.parse(c.post) : null, request: c.request ? JSON.parse(c.request) : null,
    items, author: await name(c.author_id), reviewer: await name(c.reviewer_id), scheduledBy: await name(c.scheduled_by ?? null),
    site: { id: s.id, name: s.name, liveUrl: s.liveUrl, postUrl: c.type === 'post' ? (() => { try { return s.adapter_.postUrl(s.content, '{slug}'); } catch { return null; } })() : null },
    liveOrigin: `/preview/live/${s.id}`, previewOrigin: `/preview/c/${c.id}`,
    previewReady: c.preview === 'ready' && (s.previews === 'github' ? !!c.preview_url : s.previews === 'claudepress' ? s.staging.change === c.id
      : fs.existsSync(path.join(previewDir(s.id, c.id), outRel))),
    // the site's preview address shows one change at a time: another change may have taken it since
    previewReplaced: s.previews === 'claudepress' && c.preview === 'ready' && s.staging.change !== c.id,
    previewLink: s.previews === 'github' ? c.preview_url
      : s.previews === 'claudepress' && c.preview === 'ready' && s.staging.change === c.id ? `${origin()}/s/${await shareToken(s.id)}/` : null,
    previewBy: s.previews, previewStarted: (c as any).preview_started ?? null,
    previewProgress: c.preview === 'building' ? (c as any).preview_progress ?? null : null,
    // what the staging frame can show for this change, even while a newer version is being built
    stagingVersion: s.previews === 'claudepress' ? (s.staging.change === c.id ? s.staging.build : null)
      : s.previews === 'github' ? (c.preview_url ? c.preview_sha : null)
      : c.preview === 'ready' ? String(c.updated) : null,
    can: {
      edit: open && (mine || role === 'agency') && !paused,
      publish: open && hasWork && (mine || role === 'agency') && publisher,
      submit: open && hasWork && mine && !publisher && !paused,
      approve: c.status === 'pending' && publisher,
      // a scheduled change is locked: taken off the schedule (back where it was), or published now, by who could publish it
      unschedule: scheduled && publisher && (mine || role === 'agency' || c.scheduled_by === u.id || c.author_id !== c.scheduled_by),
      discard: (open || c.status === 'pending' || scheduled) && (mine || role === 'agency'),
      undo: c.status === 'published' && c.type !== 'request' && !!role,
      close: c.status === 'agency' && role === 'agency',
      checkLive: c.status === 'published' && role === 'agency' && !!c.live && !['live', 'local'].includes(c.live),
    },
    paused,
    agencyApproval: gated,   // kinds of change the agency approves first: why this person cannot publish them
    showCost: role === 'agency',
  };
}

async function summaries(list: ChangeRow[]) {
  const name = names();
  return Promise.all(list.map(async c => ({
    id: c.id, type: c.type, title: c.title || 'Sans titre', status: c.status, author: await name(c.author_id),
    updated: c.updated, published: c.published, publish_at: c.publish_at ?? null, count: JSON.parse(c.ops).length, review_comment: c.review_comment,
    live: c.live ?? null,
  })));
}

const touch = (id: string, patch: Partial<ChangeRow>) => db.update('changes', id, { ...patch, updated: now() });

/** Saves the edits of a change. A first preview is built on request; once there is one, it follows every edit. */
async function saveOps(c: ChangeRow, ops: Op[]) {
  await touch(c.id, { ops: JSON.stringify(ops) });
  if (!ops.length) { await db.update('changes', c.id, { preview: 'none', pr_number: null, preview_url: null }); await dropPreview(c.site_id, c.id, c.pr_number); return; }
  const s = siteAnyState(c.site_id);
  if (s?.previews === 'local') { buildPreview(c.site_id, c.id); return; }   // built here in a few seconds: keep it automatic
  // whoever asked for the staging site wants to see the change as it now is: a build already running takes the new edits next
  if (c.preview !== 'none') buildPreview(c.site_id, c.id);
}

async function addCost(c: ChangeRow, u: { in: number; cached: number; out: number; cost: number; media?: number; mode: 'own_key' | 'included'; images?: number; videoSeconds?: number; mediaOwnKey?: boolean },
                       kind: UsageDetail['kind'], userId: string) {
  const credit = await recordUsage(c.org_id ?? orgIdOfSite(c.site_id), u.cost, u.mode, u.media, { kind, siteId: c.site_id, changeId: c.id, userId,
    tokensIn: u.in, tokensCached: u.cached, tokensOut: u.out, images: u.images, videoSeconds: u.videoSeconds, mediaOwnKey: u.mediaOwnKey });
  const cur = (await db.get<ChangeRow>('changes', c.id))!;
  await db.update('changes', c.id, { tokens_in: cur.tokens_in + u.in, tokens_cached: (cur.tokens_cached || 0) + u.cached, tokens_out: cur.tokens_out + u.out, cost: cur.cost + u.cost, credit_used: (cur.credit_used || 0) + credit });
}

const inFlight = new Set<string>();

async function doPublish(c: ChangeRow, u: User) {
  if (c.type === 'post') {
    // a post saved in the editor but not yet turned into its operation
    const post: NewPost = JSON.parse(c.post!);
    await db.update('changes', c.id, { ops: JSON.stringify([{ kind: 'create_post', url: site(c.site_id).adapter_.postUrl(site(c.site_id).content, post.slug), post }]) });
  }
  // the live pages are read while the commit is made, before any deploy: what the change will show is looked for there after
  const s = site(c.site_id);
  const expect = GoLive.expectations(s, JSON.parse((await db.get<ChangeRow>('changes', c.id))!.ops));
  expect.catch(() => {});
  const { sha, full, steps } = await publish(c.site_id, c.id, c.title || 'Modification', u);
  await touch(c.id, { status: 'published', commit_sha: sha, published: now(), reviewer_id: c.reviewer_id ?? (c.author_id !== u.id ? u.id : null) });
  GoLive.follow(c.id, s, full ?? null, expect).catch(e => console.error(`[golive] ${c.id}:`, e));
  dropPreview(c.site_id, c.id);
  if (c.author_id !== u.id) await notify([c.author_id], c.id, `${u.name} a publié « ${c.title} ».`);
  return { sha, steps };
}

/** A moment given by the screen, as an ISO date, or a 400. */
const isoAt = (v: unknown) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : fail(400, 'Date invalide.'); };
/** "lundi 9 novembre à 00:00", in the time zone of the person who chose it. */
const dateFr = (iso: string, tz?: string) => {
  const d = new Date(iso), o = (x: Intl.DateTimeFormatOptions) => { try { return d.toLocaleString('fr-BE', { ...x, timeZone: tz }); } catch { return d.toLocaleString('fr-BE', x); } };
  return `${o({ weekday: 'long', day: 'numeric', month: 'long' })} à ${o({ hour: '2-digit', minute: '2-digit' })}`;
};

/** Takes a change off the schedule: back to the author's draft, or to the approver's list when someone else approved it. */
async function unschedule(c: ChangeRow, error: string | null = null) {
  await touch(c.id, { status: c.scheduled_by === c.author_id ? 'draft' : 'pending', publish_at: null, scheduled_by: null, schedule_error: error });
}

/** Publishes the scheduled changes that are due, as the person who scheduled each, if they still may. Never two runs at once. */
let publishing: Promise<number> | null = null;
function publishDue() {
  return publishing ??= (async () => {
    let n = 0;
    try {
      const due = (await db.find<ChangeRow>('changes', { status: 'scheduled' })).filter(c => Date.parse(c.publish_at || '') <= Date.now());
      for (const c of due) {
        const u = c.scheduled_by ? await db.get<User>('users', c.scheduled_by) : null;
        const role = u?.active ? await roleOn(u, c.site_id) : null;
        const why = !u || !role || !canPublishRole(role) ? 'la personne qui l’a programmée ne peut plus publier sur ce site'
          : await pausedReason(c.site_id) ?? ((await agencyApproval(c, u, role)).length ? 'ces changements doivent d’abord être validés par l’agence' : null);
        try {
          if (why) throw new Error(why);
          await doPublish(c, u!);
          n++;
          if (u!.id !== c.author_id) await notify([u!.id], c.id, `« ${c.title} » a été publié comme prévu.`);
        } catch (e) {
          // left as it was before scheduling, with the reason, so someone can fix it and publish
          console.error(`[schedule] ${c.id}:`, e);
          const msg = (e as Error).message;
          await unschedule(c, msg);
          const to = [c.author_id, ...(c.scheduled_by ? [c.scheduled_by] : []), ...(await agencyUsers(c.site_id))];
          await notify(to, c.id, `La publication programmée de « ${c.title} » n’a pas pu se faire : ${msg}`);
        }
      }
      return n;
    } finally { publishing = null; }
  })();
}

// ------------------------------------------------------------------ routes

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, u: User, p: string[]) => Promise<unknown> | unknown;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), h]);

/** Sites a person can open, with their role on each. */
async function sitesOf(u: User) {
  const out: { s: ReturnType<typeof allSites>[number]; role: Role }[] = [];
  if (u.agency && u.org_id) for (const s of allSites()) if (s.orgId === u.org_id) out.push({ s, role: 'agency' });
  for (const m of await db.find('members', { user_id: u.id })) {
    const s = siteAnyState(m.site_id);
    if (s && !out.some(o => o.s.id === s.id)) out.push({ s, role: m.role });
  }
  return out.sort((a, b) => a.s.name.localeCompare(b.s.name));
}

/**
 * The white label a person sees: their own account's for administrators, else that of the first of their sites whose
 * account has one (a client usually works with one agency).
 */
async function brandFor(u: { id: string; agency?: number; org_id?: string | null }) {
  if (u.agency && u.org_id) return brandOf(await orgOf(u.org_id));
  for (const m of await db.find('members', { user_id: u.id })) {
    const b = brandOf(await orgOf(orgIdOfSite(m.site_id)));
    if (b) return b;
  }
  return null;
}

route('GET', '/api/me', async (_q, _r, u) => ({
  user: u,
  brand: await brandFor(u),
  sites: await Promise.all((await sitesOf(u)).map(async ({ s, role }) => ({
    id: s.id, name: s.name, liveUrl: s.liveUrl, role, status: s.status, paused: !!(await pausedReason(s.id)),
    pending: role !== 'editor' ? await db.count('changes', { site_id: s.id, status: 'pending' }) : 0,
  }))),
  notices: (await db.find('notices', { user_id: u.id })).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 20),
}));

/** How a site looks online (its share image) and when it last changed: published here, else as its host says. */
route('GET', '/api/sites/:id/peek', async (_q, _r, u, [id]) => {
  if (!(await roleOn(u, id))) fail(403, 'Accès refusé');
  const s = siteAnyState(id) ?? fail(404, 'Site introuvable.');
  const published = (await db.find('changes', { site_id: id, status: 'published' })).map(c => c.published || c.updated).filter(Boolean).sort().pop() || null;
  const peek = await livePeek(s.liveUrl);
  return { image: peek.image, title: peek.title, description: peek.description, published, modified: peek.modified };
});

/** Interface language of the person (French or English), remembered across devices. */
route('POST', '/api/me/lang', async (req, _r, u) => {
  const { lang } = await json(req);
  if (lang !== 'fr' && lang !== 'en') fail(400, 'Langue inconnue.');
  await db.update('users', u.id, { lang });
  return { ok: true };
});

// ---- connected phones (the iPhone app)

/** A code (and its QR) to connect the app: the QR carries this server's address, so self-hosted servers work too. */
route('POST', '/api/devices/pair-code', async (_q, _r, u) => {
  const { code, expires } = await newPairCode(u.id);
  const link = `claudepress://pair?server=${encodeURIComponent(origin())}&code=${code}`;
  return { code, expires, link, qr: await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
});

route('GET', '/api/devices', async (req, _r, u) => {
  const current = currentDevice(req);
  return (await devicesOf(u.id)).map(d => ({ ...d, current: d.id === current }));
});

route('POST', '/api/devices/:id/remove', async (_q, _r, u, [id]) => {
  const d = await db.get('devices', id);
  if (!d || d.user_id !== u.id) fail(404, 'Appareil introuvable');
  await db.remove('devices', id);
  return { ok: true };
});

route('POST', '/api/notices/read', async (_q, _r, u) => {
  for (const n of await db.find('notices', { user_id: u.id, read: 0 })) await db.update('notices', n.id, { read: 1 });
  return { ok: true };
});

/** Shortcuts on a site's home: the usual tasks its scan found, else its main pages; only what this person may change. */
function homeTasks(scan: ScanResult | undefined, policy: Policy, trusted: boolean) {
  if (!scan) return [];
  if (scan.tasks?.length) return scan.tasks.filter(t => trusted || policy[t.kind] !== 'agency').map(({ label, prompt }) => ({ label, prompt }));
  return (scan.site_map || []).filter(m => !m.page.endsWith('*') && m.zones.some(z => z.source === 'content')
      && (trusted || (pagePermission(policy, m.page) ?? policy.content) !== 'agency'))
    .slice(0, 6).map(m => ({ label: m.title, prompt: `${m.title} (${m.page}) : `, page: true }));
}

route('GET', '/api/sites/:id', async (_q, _r, u, [id]) => {
  const role = (await roleOn(u, id)) ?? fail(403, 'Accès refusé');
  const s = site(id);
  await freshen(s).catch(e => console.error(`[${id}] ${e.message}`));
  const changes = (await db.find<ChangeRow>('changes', { site_id: id })).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 200);
  const approver = canPublishRole(role);
  const trusted = role === 'agency' || await scopeOn(u, id) === 'full';
  const policy = await policyOf(id);
  const pending = changes.filter(c => c.status === 'pending');
  const reviewable = trusted ? pending : pending.filter(c => !gatedKinds(policy, JSON.parse(c.ops), c.type === 'post' ? ['posts'] : []).length);
  return {
    site: { id: s.id, name: s.name, liveUrl: s.liveUrl, liveOrigin: `/preview/live/${s.id}`, push: s.push }, role,
    insights: await seesInsights(role, id),
    may: Object.fromEntries(KINDS.map(k => [k, trusted ? 'allowed' : policy[k]])),
    tasks: homeTasks((await scanOf(id))?.result, policy, trusted),
    toReview: approver ? await summaries(reviewable) : [],
    // an edit opened and left before the first message is not work in progress
    mine: await summaries(changes.filter(c => c.author_id === u.id && ['draft', 'changes_requested', 'pending'].includes(c.status)
      && (c.type === 'post' ? c.post || c.title : c.type !== 'edit' || c.chat !== '[]' || c.ops !== '[]'))),
    requests: await summaries(changes.filter(c => c.type === 'request' && (c.author_id === u.id || approver)).slice(0, 20)),
    scheduled: await summaries(changes.filter(c => c.status === 'scheduled').sort((a, b) => a.publish_at!.localeCompare(b.publish_at!))),
    history: await summaries(changes.filter(c => c.status === 'published').slice(0, 30)),
    monitor: await monitorView(id),
    // changes published but not on the live site yet: the administrators see it here
    golive: role === 'agency' ? await GoLive.liveState(id) : null,
  };
});

route('GET', '/api/sites/:id/images', async (_q, _r, u, [id]) => {
  (await roleOn(u, id)) ?? fail(403, 'Accès refusé');
  const s = site(id);
  const seen = new Set<string>();
  for (const p of s.adapter_.listPages(s.content)) {
    for (const e of s.adapter_.readPage(s.content, p.url)?.elements || []) if (e.src && /\.(jpe?g|png|webp)$/i.test(e.src) && /^(\/|https?:)/.test(e.src)) seen.add(e.src);
  }
  return [...seen].slice(0, 120);
});

route('POST', '/api/sites/:id/changes', async (req, _r, u, [id]) => {
  (await roleOn(u, id)) ?? fail(403, 'Accès refusé');
  const { type } = await json(req);
  if (!['edit', 'post', 'request'].includes(type)) fail(400, 'Type inconnu');
  const paused = await pausedReason(id); if (paused) fail(402, paused);
  if (type === 'post' && (await policyOf(id)).posts === 'agency' && (await roleOn(u, id)) !== 'agency' && await scopeOn(u, id) !== 'full')
    fail(403, 'Les articles du blog sont rédigés par l’agence sur ce site : demandez-le-lui.');
  const cid = newId();
  await db.set('changes', cid, newChange({ site_id: id, org_id: orgIdOfSite(id), type, author_id: u.id }));
  return { id: cid };
});

route('GET', '/api/changes/:id', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  return view((await checkPreview(c.id)) as ChangeRow ?? c, u, role);
});

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

// photos, and PDFs for the conversation (a price list, a menu, a flyer): the assistant reads them, they never go on the site
route('POST', '/api/uploads', async (req, _r, u) => {
  const name = decodeURIComponent(String(req.headers['x-file-name'] || 'photo.jpg'));
  const type = String(req.headers['content-type'] || '');
  const pdf = type === 'application/pdf';
  if (!IMAGE_TYPES[type] && !pdf) fail(400, 'Seules les images JPEG, PNG, WebP et GIF et les documents PDF sont acceptés');
  const data = await bodyOf(req, (pdf ? 30 : 15) << 20);
  if (pdf && data.subarray(0, 5).toString() !== '%PDF-') fail(400, 'Ce fichier n’est pas un PDF lisible.');
  const base = path.basename(name, path.extname(name)).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 50) || (pdf ? 'document' : 'photo');
  const file = `${newId(8)}-${base}${pdf ? '.pdf' : IMAGE_TYPES[type]}`;
  await db.putFile(`uploads/${file}`, data);
  return { file, name, mediaType: type, url: `/api/uploads/${file}`, by: u.id };
});

route('POST', '/api/changes/:id/message', async (req, res, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.edit) fail(403, 'Cette modification ne peut plus être changée');
  if (inFlight.has(id)) fail(409, 'Une demande est déjà en cours');
  const { text, images = [], files = [] } = await json(req);
  inFlight.add(id);
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const out = (o: unknown) => res.write(JSON.stringify(o) + '\n');
  const chat = JSON.parse(c.chat);
  chat.push({ role: 'user', text, images: images.map((i: any) => `/api/uploads/${i.file}`),
    ...(files.length ? { files: files.map((f: any) => ({ name: f.name, url: `/api/uploads/${f.file}` })) } : {}), at: now(), by: u.name });
  // the steps the AI took, with how long each lasted, are kept with its answer; pauses to think are only shown live
  const steps: { text: string; s: number }[] = [];
  let open: { text: string; at: number } | null = null;
  const close = () => { if (open) steps.push({ text: open.text, s: Math.round((Date.now() - open.at) / 1000) }); open = null; };
  const step = (line: string, more: StepMore = {}) => {
    close();
    if (!more.thinking) open = { text: line, at: Date.now() };
    out({ progress: line, ...more });
  };
  try {
    const r = await turn(c.site_id, await transcript.get(id), JSON.parse(c.ops), { text, images, files }, step, await scopeOn(u, c.site_id), await policyOf(c.site_id));
    close();
    chat.push({ role: 'assistant', text: r.reply, at: now(), ...(r.need ? { need: r.need } : {}), ...(steps.length ? { steps } : {}),
      ...(r.media.length ? { images: r.media.filter(m => m.type === 'image').map(m => m.url), videos: r.media.filter(m => m.type === 'video').map(m => m.url) } : {}) });
    await transcript.set(id, r.messages);
    await touch(id, { chat: JSON.stringify(chat), title: c.title || text.replace(/\s+/g, ' ').slice(0, 90), ...(r.publishOn !== undefined ? { suggested_at: r.publishOn } : {}) });
    await addCost(c, r.usage, 'edit', u.id);
    if (JSON.stringify(r.ops) !== c.ops) await saveOps(c, r.ops);
    for (const ar of r.agencyRequests) {
      // each request goes to the agency as its own item, with the conversation for context
      const rid = newId();
      await db.set('changes', rid, newChange({ site_id: c.site_id, org_id: c.org_id ?? orgIdOfSite(c.site_id), type: 'request', title: ar.summary,
        status: 'agency', author_id: u.id, chat: JSON.stringify(chat), request: JSON.stringify({ details: ar.details, kind: ar.kind, from: id, ...(ar.attachments.length ? { attachments: ar.attachments } : {}) }) }));
      await notify(await agencyUsers(c.site_id), rid, `${u.name} (${site(c.site_id).name}) : ${ar.summary}`);
    }
    out({ done: true });
  } catch (e) {
    console.error(e);
    const ai = await aiProblem(c.site_id, e);
    const msg = ai ? ai.message : 'Désolé, une erreur est survenue. Réessayez dans un instant.';
    chat.push({ role: 'assistant', text: msg, error: String((e as Error).message), at: now(), ...(ai?.need ? { need: ai.need } : {}) });
    await touch(id, { chat: JSON.stringify(chat) });
    out({ error: (e as Error).message });
  } finally {
    inFlight.delete(id);
    res.end();
  }
  return undefined;
});

route('POST', '/api/changes/:id/preview', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  // a scheduled change stays locked, but who can take it off the schedule can still see it whole before it goes live
  const scheduled = c.status === 'scheduled' && (await view(c, u, role)).can.unschedule;
  if (!scheduled && !['draft', 'changes_requested', 'pending'].includes(c.status)) fail(403, 'Action impossible');
  if (!JSON.parse(c.ops).length && !(c.type === 'post' && c.post)) fail(400, 'Rien à prévisualiser pour l’instant.');
  if (c.preview === 'building') return { ok: true };
  buildPreview(c.site_id, c.id);
  return { ok: true };
});

route('POST', '/api/sites/:id/share', async (req, _r, u, [id]) => {
  const role = (await roleOn(u, id)) ?? fail(403, 'Accès refusé');
  const { renew } = await json(req);
  if (renew && !canPublishRole(role)) fail(403, 'Action impossible');
  return { link: `${origin()}/s/${await shareToken(id, !!renew)}/` };
});

route('POST', '/api/changes/:id/remove', async (req, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.edit) fail(403, 'Cette modification ne peut plus être changée');
  const { index } = await json(req);
  const ops: Op[] = JSON.parse(c.ops);
  ops.splice(index, 1);
  await saveOps(c, ops);
  return { ok: true };
});

route('POST', '/api/changes/:id/post/draft', async (req, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (c.type !== 'post' || !(await view(c, u, role)).can.edit) fail(403, 'Action impossible');
  const brief = await json(req);
  const { post, usage } = await draftPost(c.site_id, brief);
  const cover = brief.photos?.[0];
  if (cover) {
    const m = site(c.site_id).adapter_.mediaPath(cover.file.replace(/^[a-z0-9]+-/, ''), new Date());
    post.cover = { src: m.src, alt: post.cover?.alt || '', media: { upload: cover.file, path: m.path } };
  }
  await addCost(c, usage, 'post', u.id);
  await touch(id, { post: JSON.stringify(post), title: post.title, request: JSON.stringify(brief) });
  return { post };
});

route('POST', '/api/changes/:id/post/revise', async (req, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (c.type !== 'post' || !(await view(c, u, role)).can.edit || !c.post) fail(403, 'Action impossible');
  const { instruction, post: current } = await json(req);
  const { post, usage } = await revisePost(c.site_id, current || JSON.parse(c.post!), instruction);
  await addCost(c, usage, 'post', u.id);
  await touch(id, { post: JSON.stringify(post), title: post.title });
  return { post };
});

route('POST', '/api/changes/:id/post', async (req, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (c.type !== 'post' || !(await view(c, u, role)).can.edit) fail(403, 'Action impossible');
  const { post } = await json(req) as { post: NewPost };
  const s = site(c.site_id);
  if (post.cover?.media && !post.cover.media.path) {
    post.cover.media.upload = (await forWeb(path.basename(post.cover.media.upload), null)).file;   // sized and compressed as WebP
    const m = s.adapter_.mediaPath(post.cover.media.upload.replace(/^[a-z0-9]+-/, ''), new Date());
    post.cover.media.path = m.path;
    post.cover.src = m.src;
  }
  post.blocks = post.blocks.map(b => b.items ? { type: b.type, items: b.items.map(sanitize) } : { type: b.type, html: sanitize(b.html || '') });
  post.title = stripTags(post.title);
  post.slug = post.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!post.slug) fail(400, 'Adresse de l’article manquante');
  const url = s.adapter_.postUrl(s.content, post.slug);
  if (s.adapter_.readPage(s.content, url)) fail(400, `L’adresse ${url} est déjà utilisée sur le site`);
  await touch(id, { post: JSON.stringify(post), title: post.title });
  await saveOps({ ...c, preview: c.preview }, [{ kind: 'create_post', url, post }]);
  return { ok: true };
});

route('POST', '/api/changes/:id/request', async (req, _r, u, [id]) => {
  const { c } = await changeOf(id, u);
  if (c.type !== 'request' || c.author_id !== u.id || c.status !== 'draft') fail(403, 'Action impossible');
  const { text } = await json(req);
  const { brief, usage } = await pageBrief(c.site_id, text);
  await addCost(c, usage, 'page_request', u.id);
  await touch(id, { request: JSON.stringify({ text, brief }), title: `Nouvelle page : ${brief.pageTitle}` });
  return { brief };
});

route('POST', '/api/changes/:id/send-request', async (_q, _r, u, [id]) => {
  const { c } = await changeOf(id, u);
  if (c.type !== 'request' || c.author_id !== u.id || c.status !== 'draft') fail(403, 'Action impossible');
  await touch(id, { status: 'agency' });
  await notify(await agencyUsers(c.site_id), id, `${u.name} (${site(c.site_id).name}) demande : ${c.title}`);
  return { ok: true };
});

route('POST', '/api/changes/:id/submit', async (req, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.submit) fail(403, 'Action impossible');
  const { note, at } = await json(req);
  await touch(id, { status: 'pending', review_comment: note || null, ...(at !== undefined ? { suggested_at: at ? isoAt(at) : null } : {}) });
  // what the site's permissions leave to the agency's approval goes to the agency only
  const reviewers = (await agencyApproval(c, u, role)).length ? await agencyUsers(c.site_id) : await approversOf(c.site_id);
  await notify(reviewers.filter(x => x !== u.id), id, `${u.name} demande à publier « ${c.title} ».`);
  return { ok: true };
});

route('POST', '/api/changes/:id/publish', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  const can = (await view(c, u, role)).can;
  if (!can.publish && !can.unschedule) fail(403, 'Vous ne pouvez pas publier directement');
  return doPublish(c, u);
});

/** Publishes on a date: the change waits, locked, and goes live then as the person who scheduled it. */
route('POST', '/api/changes/:id/schedule', async (req, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  const can = (await view(c, u, role)).can;
  if (!can.publish && !can.approve) fail(403, 'Action impossible');
  const body = await json(req), at = isoAt(body.at);
  if (Date.parse(at) < Date.now() + 60_000) fail(400, 'Choisissez un moment à venir.');
  if (Date.parse(at) > Date.now() + 400 * 86_400_000) fail(400, 'Choisissez une date dans les douze prochains mois.');
  await touch(id, { status: 'scheduled', publish_at: at, scheduled_by: u.id, schedule_error: null, ...(can.approve ? { reviewer_id: u.id } : {}) });
  if (c.author_id !== u.id) await notify([c.author_id], id, `${u.name} a programmé « ${c.title} » pour le ${dateFr(at, body.tz)}.`);
  return { ok: true, publish_at: at };
});

route('POST', '/api/changes/:id/unschedule', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.unschedule) fail(403, 'Action impossible');
  await unschedule(c);
  return { ok: true };
});

route('POST', '/api/changes/:id/approve', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.approve) fail(403, 'Action impossible');
  return doPublish({ ...c, reviewer_id: u.id }, u);
});

route('POST', '/api/changes/:id/request-changes', async (req, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.approve) fail(403, 'Action impossible');
  const { comment } = await json(req);
  await touch(id, { status: 'changes_requested', reviewer_id: u.id, review_comment: comment || '' });
  await notify([c.author_id], id, `${u.name} demande une correction sur « ${c.title} » : ${comment}`);
  return { ok: true };
});

route('POST', '/api/changes/:id/discard', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.discard) fail(403, 'Action impossible');
  await touch(id, { status: 'discarded' });
  await dropPreview(c.site_id, id, c.pr_number);
  return { ok: true };
});

route('POST', '/api/changes/:id/undo', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.undo) fail(403, 'Action impossible');
  const s = site(c.site_id);
  const ops = (JSON.parse(c.ops) as Op[]).map(o => s.adapter_.invert(o)).reverse();
  if (c.type === 'post') ops.forEach(o => { if (o.kind === 'delete_post') o.snapshot = null; });
  const nid = newId();
  await db.set('changes', nid, newChange({ site_id: c.site_id, org_id: c.org_id ?? orgIdOfSite(c.site_id), type: 'edit', title: `Annuler : ${c.title}`,
    author_id: u.id, ops: JSON.stringify(ops), undoes: id,
    chat: JSON.stringify([{ role: 'assistant', text: `Voici l’annulation de « ${c.title} ». Vérifiez l’aperçu, puis publiez-la ou demandez sa validation.`, at: now() }]) }));
  if (siteAnyState(c.site_id)?.previews === 'local') buildPreview(c.site_id, nid);
  return { id: nid };
});

/** Checks now whether a published change shows on the live site. */
route('POST', '/api/changes/:id/live', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.checkLive) fail(403, 'Action impossible');
  return { state: await GoLive.check(id) };
});

route('POST', '/api/changes/:id/close', async (_q, _r, u, [id]) => {
  const { c, role } = await changeOf(id, u);
  if (!(await view(c, u, role)).can.close) fail(403, 'Action impossible');
  await touch(id, { status: 'done' });
  await notify([c.author_id], id, `L’agence a traité votre demande « ${c.title} ».`);
  return { ok: true };
});

// ---- admin screens (each administrator sees only their own account)

const adminOnly = (u: User) => { if (!u.agency || !u.org_id) fail(403, 'Réservé aux administrateurs'); return u.org_id!; };
const inviteUrl = (token: string) => `${origin()}/#/invite/${token}`;
const activeAdmins = async (orgId: string) => (await db.find('users', { agency: 1, active: 1, org_id: orgId })).map(r => r.id);
const mySites = (orgId: string) => allSites().filter(s => s.orgId === orgId);
const ownSite = (orgId: string, id: string) => { const s = siteAnyState(id); if (!s || s.orgId !== orgId) fail(404, 'Site introuvable.'); return s!; };

/**
 * Refuses one more client on a site that already has as many as the account's plan allows (invitations included;
 * administrators reach every site and do not count). People already there keep their access when a plan gets smaller.
 */
async function checkClientSeat(orgId: string, siteId: string, userId?: string) {
  const plan = planOf((await orgOf(orgId))!);
  if (!Number.isFinite(plan.clients)) return;
  const there = await db.find('members', { site_id: siteId });
  if (userId && there.some(m => m.user_id === userId)) return;
  if (there.length < plan.clients) return;
  const more = allPlans().filter(p => !Number.isFinite(p.clients)).map(p => p.name);
  fail(402, `La formule ${plan.name} permet ${plan.clients} client${plan.clients > 1 ? 's' : ''} par site.${more.length ? ` Passez à la formule ${more.join(' ou ')} pour en inviter davantage.` : ''}`);
}
/**
 * Refuses one more administrator when the account has as many as its plan allows (invitations included).
 * Administrators already there keep their access when a plan gets smaller.
 */
async function checkAdminSeat(orgId: string) {
  const plan = planOf((await orgOf(orgId))!);
  if ((await activeAdmins(orgId)).length < plan.admins) return;
  const more = allPlans().filter(p => p.admins > plan.admins).map(p => p.name);
  fail(402, `La formule ${plan.name} permet ${plan.admins} administrateur${plan.admins > 1 ? 's' : ''}.${more.length ? ` Passez à la formule ${more.join(' ou ')} pour inviter votre équipe.` : ''}`);
}
/**
 * Sites beyond the plan's limit, the newest first: an account that ended up with more (a subscription that ended, a
 * smaller plan) keeps them, but they are paused, nothing is changed or published there until it moves up or removes some.
 */
async function pausedSites(orgId: string) {
  const org = await orgOf(orgId);
  const plan = org && planOf(org), mine = mySites(orgId);
  if (!plan || !Number.isFinite(plan.sites) || mine.length <= plan.sites) return new Set<string>();
  const created = await Promise.all(mine.map(async s => [s.id, String((await db.get('sites', s.id))?.created || '')] as const));
  return new Set(created.sort((a, b) => a[1].localeCompare(b[1])).slice(plan.sites).map(([id]) => id));
}
/** Why a site is paused, for the people who try to change it, or null. */
async function pausedReason(siteId: string) {
  const orgId = siteAnyState(siteId)?.orgId;
  if (!orgId || !(await pausedSites(orgId)).has(siteId)) return null;
  const plan = planOf((await orgOf(orgId))!);
  return `Ce site est en pause : la formule ${plan.name} permet ${plan.sites} site${plan.sites > 1 ? 's' : ''}. Un administrateur peut passer à une formule supérieure ou retirer un site.`;
}
const userView = (x: any) => ({ id: x.id, email: x.email, name: x.name, agency: x.agency ? 1 : 0, active: x.active ? 1 : 0,
  joined: x.password_hash || x.firebase_uid ? 1 : 0, last_login: x.last_login || null });
/** People an administrator may see and manage: their account's admins and the clients of their sites. */
async function peopleOf(orgId: string) {
  const ids = new Set([...(await db.find('users', { org_id: orgId })).map(u => u.id), ...(await db.find('members', { org_id: orgId })).map(m => m.user_id)]);
  const people = (await Promise.all([...ids].map(id => db.get('users', id)))).filter(Boolean).map(userView);
  return people.sort((a, b) => b.agency - a.agency || a.name.localeCompare(b.name));
}
const ownPerson = async (orgId: string, id: string) => (await peopleOf(orgId)).find(p => p.id === id) ?? fail(404, 'Personne introuvable.');

/** Credits used each of the last six months, oldest first: the plan's and the packs' together (own Claude key not included). */
async function creditHistory(orgId: string) {
  const used = Object.fromEntries((await db.find('usage', { org_id: orgId })).map(u => [u.month, Number(u.credit) || 0]));
  const d = new Date(); d.setUTCDate(1);
  return Array.from({ length: 6 }, (_, i) => {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5 + i, 1)).toISOString().slice(0, 7);
    return { month: m, credits: toCredits(used[m] || 0) };
  });
}

async function accountView(orgId: string) {
  const org = (await orgOf(orgId))!;
  const plan = planOf(org);
  return {
    id: org.id, name: org.name, plan: plan.id, aiIncluded: !!org.ai_included,
    whiteLabel: plan.whiteLabel, brand: { name: org.brand?.name || '', color: org.brand?.color || '', mascot: org.brand?.mascot !== false,
      logo: org.brand?.logo ? `/brand-logo/${org.brand.logo}` : null, icon: org.brand?.icon ? `/brand-logo/${org.brand.icon}` : null },
    plans: allPlans().map(p => ({ ...p, sites: Number.isFinite(p.sites) ? p.sites : null, clients: Number.isFinite(p.clients) ? p.clients : null, admins: Number.isFinite(p.admins) ? p.admins : null, included: p.included && { ...p.included, credits: toCredits(p.included.credit) } })),
    sitesUsed: mySites(orgId).length, sitesLimit: Number.isFinite(plan.sites) ? plan.sites : null,
    clientsPerSite: Number.isFinite(plan.clients) ? plan.clients : null,
    adminsUsed: (await activeAdmins(orgId)).length, adminsLimit: Number.isFinite(plan.admins) ? plan.admins : null,
    // the dashboard: clients of each site, and the credits of the last six months
    siteClients: await Promise.all(mySites(orgId).map(async s => ({ id: s.id, name: s.name, clients: await db.count('members', { site_id: s.id }) }))),
    history: await creditHistory(orgId),
    ai: await aiStatus(org).then(s => ({ ...s, credits: { total: toCredits(s.credit), used: toCredits(s.used), left: toCredits(s.left), packs: toCredits(s.packs) } })),
    keyEvents: await keyEvents(orgId),
    creditsPerEur: CREDITS_PER_EUR, creditsPerEdit: await creditsPerEdit(),
    monitoring: { on: monitoringOn(org), included: plan.monitoring },
    security: { on: securityOn(org), included: plan.security },
    // a hosted service adds what the account pays and can buy
    ...(await ext.account?.(org)),
  };
}

// the usage page: every charge of a month, what Claude and fal.ai each cost, who paid them, and the prices behind the credits
route('GET', '/api/admin/usage', async (req, _r, u) => {
  const orgId = adminOnly(u);
  const asked = new URL(req.url!, 'http://x').searchParams.get('month') || '';
  const month = /^\d{4}-\d{2}$/.test(asked) ? asked : monthKey();
  const log = (await db.find('usage_log', { org_id: orgId, month })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const people = await peopleOf(orgId);
  const titles = new Map<string, string>();
  for (const id of new Set(log.map(e => e.change_id).filter(Boolean))) titles.set(id, (await db.get<ChangeRow>('changes', id))?.title || '');
  const first = (await db.find('usage_log', { org_id: orgId })).reduce((m, e) => !m || e.at < m ? e.at : m, '' as string);
  return {
    month, since: first || null, history: await creditHistory(orgId),
    prices: { claude: { in: PRICE.in * 1e6, out: PRICE.out * 1e6, cacheRead: PRICE.cacheRead * 1e6, cacheWrite: PRICE.cacheWrite * 1e6 }, fal: FAL_PRICE,
      eurPerUsd: EUR_PER_USD, creditsPerEur: CREDITS_PER_EUR },
    entries: log.map(e => ({ at: e.at, kind: e.kind, site: e.site_id ? siteAnyState(e.site_id)?.name || e.site_id : null, siteId: e.site_id,
      change: e.change_id ? { id: e.change_id, title: titles.get(e.change_id) || '' } : null, who: people.find(p => p.id === e.user_id)?.name || null,
      tokensIn: e.tokens_in, tokensCached: e.tokens_cached, tokensOut: e.tokens_out, claudeUsd: e.claude_usd, claudePaidBy: e.claude_paid_by,
      images: e.images, videoSeconds: e.video_seconds, mediaUsd: e.media_usd, mediaPaidBy: e.media_paid_by,
      // the credits of each part: Claude's when the plan's credit paid it, fal.ai's when it was not the account's own fal.ai key
      claudeCredits: e.claude_paid_by === 'credits' ? toCredits(e.claude_usd * EUR_PER_USD) : 0,
      mediaCredits: e.media_paid_by === 'credits' ? toCredits(e.media_usd * EUR_PER_USD) : 0, credits: toCredits(e.credit) })),
  };
});

route('GET', '/api/admin', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  const members = await db.find('members', { org_id: orgId });
  const people = await peopleOf(orgId);
  const nameOf = (id: string) => people.find(p => p.id === id);
  const monthStart = new Date().toISOString().slice(0, 7);
  const orgChanges = await db.find<ChangeRow>('changes', { org_id: orgId });
  const paused = await pausedSites(orgId);
  return {
    me: u.id,
    previewModes: [...(config.previewBuild ? ['claudepress'] : []), 'github', ...(config.githubOnly ? [] : ['local'])],
    account: await accountView(orgId),
    mail: mailOn(),
    users: people.map(x => ({ ...x, sites: members.filter(m => m.user_id === x.id).map(m => ({ siteId: m.site_id, role: m.role, scope: m.scope || 'page' })) })),
    sites: await Promise.all(mySites(orgId).map(async s => {
      const month = orgChanges.filter(c => c.site_id === s.id && c.created >= monthStart);
      const scans = await db.get('scan_usage', `${s.id}:${monthKey()}`);
      return {
        id: s.id, name: s.name, liveUrl: s.liveUrl, repo: s.repo, branch: s.branch, push: s.push, previews: s.previews, cacheDirs: s.cacheDirs, adapter: s.adapter,
        status: s.status, error: s.error, paused: paused.has(s.id), monitor: await monitorState(s.id), golive: await GoLive.liveState(s.id),
        security: await Security.securityState(s.id),
        members: members.filter(m => m.site_id === s.id).map(m => ({ id: m.user_id, name: nameOf(m.user_id)?.name || '?', email: nameOf(m.user_id)?.email || '', role: m.role, scope: m.scope || 'page', alerts: !!m.alerts }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        pending: orgChanges.filter(c => c.site_id === s.id && c.status === 'pending').length,
        policy: await policyOf(s.id),
        usage: { changes: month.length, published: month.filter(c => c.status === 'published').length,
                 scans: scans?.scans || 0, cost: month.reduce((t, c) => t + (c.cost || 0), 0) + (scans?.cost || 0),
                 credits: toCredits(month.reduce((t, c) => t + (c.credit_used || 0), 0) + (scans?.credit || 0)) },
      };
    })),
    requests: await Promise.all(orgChanges.filter(c => c.type === 'request' && c.status === 'agency').sort((a, b) => b.updated.localeCompare(a.updated))
      .map(async c => ({ ...(await summaries([c]))[0], site: siteAnyState(c.site_id)?.name || c.site_id, siteId: c.site_id,
        kind: c.request ? JSON.parse(c.request).kind ?? null : null }))),
  };
});

/**
 * What the site's clients may change: one kind ({kind, value}), one page ({page, value}, "inherit" gives it back to
 * the kind "content"), or a whole proposal of the import scan ({kinds, pages}).
 */
route('POST', '/api/admin/sites/:id/policy', async (req, _r, u, [id]) => {
  const orgId = adminOnly(u);
  if (orgIdOfSite(id) !== orgId) fail(403, 'Accès refusé');
  const { kind, page, value, kinds, pages } = await json(req) as { kind?: Kind; page?: string; value?: Permission | 'inherit'; kinds?: Partial<Record<Kind, Permission>>; pages?: Record<string, Permission | null> };
  const saving = kinds || pages ? savePolicy(id, kinds || {}, pages || {})
    : page ? savePolicy(id, {}, { [page]: value === 'inherit' ? null : value as Permission })
    : setPermission(id, kind!, value as Permission);
  await saving.catch(e => fail(400, e.message));
  return policyOf(id);
});

route('POST', '/api/admin/account', async (req, _r, u) => {
  const orgId = adminOnly(u);
  const { name } = await json(req);
  if (name !== undefined) {
    if (!String(name).trim()) fail(400, 'Le nom du compte est requis.');
    await db.update('orgs', orgId, { name: String(name).trim().slice(0, 80) });
  }
  return accountView(orgId);
});

/** Monitoring, all the account's sites in one list; a hosted service adds what it can offer to buy. */
route('GET', '/api/admin/monitoring', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  const org = (await orgOf(orgId))!;
  return { ...(await monitorOverview(orgId)), included: planOf(org).monitoring, ...(await ext.offer?.(org, 'monitoring')) };
});

route('GET', '/api/admin/sites/:id/monitor', async (_q, _r, u, [id]) => {
  const orgId = adminOnly(u);
  ownSite(orgId, id);
  // a site the free monitoring does not cover: which one it covers, to move it here or buy the add-on
  return (await monitorView(id)) ?? { off: true, ...(await monitorCoverage(orgId)) };
});

/** How a site goes live: what deploys it, how long changes take to show, and its last changes. */
route('GET', '/api/admin/sites/:id/golive', async (_q, _r, u, [id]) => {
  ownSite(adminOnly(u), id);
  return GoLive.liveView(id);
});

/** Reads again what deploys the site (once the agency has set it up), and checks its changes still waiting. */
route('POST', '/api/admin/sites/:id/golive', async (_q, _r, u, [id]) => {
  ownSite(adminOnly(u), id);
  await GoLive.redetect(siteAnyState(id)!);
  for (const c of await db.find('changes', { site_id: id, live_watch: 1 })) await GoLive.check(c.id).catch(() => {});
  return GoLive.liveView(id);
});

/** Security, every site of the account with its grade, then the advisories that affect them (server/security.ts). */
route('GET', '/api/admin/security', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  const org = (await orgOf(orgId))!;
  return { ...(await Security.securityOverview(orgId)), included: planOf(org).security, ...(await ext.offer?.(org, 'security')) };
});

// findings come in the language the screen shows
route('GET', '/api/admin/sites/:id/security', async (req, _r, u, [id]) => {
  ownSite(adminOnly(u), id);
  return Security.securityView(id, new URL(req.url!, 'http://x').searchParams.get('lang') || u.lang || 'fr');
});

/** A check now ({check: true}), or a finding accepted or counted again ({accept: key, on}). */
route('POST', '/api/admin/sites/:id/security', async (req, _r, u, [id]) => {
  ownSite(adminOnly(u), id);
  const { check, accept, on, lang } = await json(req);
  try {
    if (check) await Security.askCheck(id);
    if (accept) await Security.acceptFinding(id, String(accept), !!on, u.id);
  } catch (e) { fail(429, (e as Error).message); }
  return Security.securityView(id, lang || u.lang || 'fr');
});

/** A backup of the site's files, as a .tar.gz. */
route('GET', '/api/admin/sites/:id/backups/:backup', async (_q, res, u, [id, backup]) => {
  ownSite(adminOnly(u), id);
  const f = (await Security.backupFile(id, backup)) ?? fail(404, 'Sauvegarde introuvable.');
  res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'private, no-store' });
  res.end(f.data);
});

/** A site's monitoring: paused or not, its clients told or not. */
route('POST', '/api/admin/sites/:id/monitor', async (req, _r, u, [id]) => {
  const orgId = adminOnly(u);
  ownSite(orgId, id);
  const { paused, free } = await json(req);
  return setMonitor(id, { paused, free }).catch(e => fail(402, (e as Error).message));
});


/** Every key checked counts, accepted or not: at most 10 per account and per address every 15 minutes, so these
 *  routes cannot be used to sort stolen keys. */
function keyCheck(req: http.IncomingMessage, orgId: string) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const keys = [`key-check:org:${orgId}`, `key-check:ip:${ip}`];
  if (tooManyAttempts(...keys)) fail(429, 'Trop de tentatives. Réessayez dans un quart d’heure.');
  recordFailure(...keys);
}

route('POST', '/api/admin/account/key', async (req, _r, u) => {
  const orgId = adminOnly(u);
  const { key } = await json(req);
  if (key) {
    keyCheck(req, orgId);
    try { await saveApiKey(orgId, String(key), u); } catch (e) { fail(400, (e as Error).message); }
  } else await removeApiKey(orgId, u);
  return accountView(orgId);
});

route('POST', '/api/admin/account/fal-key', async (req, _r, u) => {
  const orgId = adminOnly(u);
  const { key } = await json(req);
  if (key) {
    keyCheck(req, orgId);
    try { await saveFalKey(orgId, String(key), u); } catch (e) { fail(400, (e as Error).message); }
  } else await removeFalKey(orgId, u);
  return accountView(orgId);
});

// ---- white label: the account's name, colour and logo instead of ClaudePress's, for plans that include it

async function whiteLabelOrg(orgId: string) {
  const org = (await orgOf(orgId))!;
  if (!planOf(org).whiteLabel) {
    const names = allPlans().filter(p => p.whiteLabel).map(p => p.name);
    fail(402, names.length ? `La marque blanche est comprise dans ${names.length > 1 ? 'les formules' : 'la formule'} ${names.join(' et ')}.` : 'La marque blanche n’est pas proposée sur ce serveur.');
  }
  return org;
}

route('POST', '/api/admin/account/brand', async (req, _r, u) => {
  const orgId = adminOnly(u);
  const org = await whiteLabelOrg(orgId);
  const { name, color, mascot } = await json(req);
  const brand = { ...org.brand };
  if (name !== undefined) brand.name = String(name).trim().slice(0, 40);
  if (color !== undefined) {
    if (color && !/^#[0-9a-f]{6}$/i.test(String(color))) fail(400, 'Choisissez une couleur au format #rrggbb.');
    brand.color = String(color).toLowerCase();
  }
  if (mascot !== undefined) brand.mascot = !!mascot;
  await db.update('orgs', orgId, { brand });
  return accountView(orgId);
});

/**
 * The logo and the tab icon arrive as images (PNG, JPEG or WebP; no SVG, which could carry scripts): the logo is kept as a
 * small WebP, the icon as a square PNG. A JSON body removes them.
 */
for (const [kind, ext, convert, wrong] of [['logo', 'webp', logoForWeb, 'Le logo doit être une image PNG, JPEG ou WebP.'],
  ['icon', 'png', iconForWeb, 'L’icône doit être une image PNG, JPEG ou WebP.']] as const) {
  route('POST', `/api/admin/account/brand/${kind}`, async (req, _r, u) => {
    const orgId = adminOnly(u);
    const org = await whiteLabelOrg(orgId);
    const type = String(req.headers['content-type'] || '');
    const old = org.brand?.[kind];
    let file: string | null = null;
    if (type !== 'application/json') {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) fail(400, wrong);
      const data = await convert(await bodyOf(req, 5 << 20)).catch(() => fail(400, 'Cette image ne peut pas être lue.'));
      file = `${orgId}-${newId(8)}.${ext}`;
      await db.putFile(`brand/${file}`, data);
    }
    await db.update('orgs', orgId, { brand: { ...org.brand, [kind]: file } });
    if (old) await db.removeFile(`brand/${old}`);
    return accountView(orgId);
  });
}

const userByEmail = async (mail: string) => (await db.find('users', { email: mail }))[0];

/** Who the e-mails come from: the account's name (or its white label), replies going to the administrator who sent them. */
async function mailFrom(orgId: string, u: User, lang: unknown) {
  const org = (await orgOf(orgId))!, b = brandOf(org);
  return { agency: b?.name || org.name, color: b?.color, replyTo: u.email, lang: lang === 'en' ? 'en' as const : 'fr' as const, whiteLabel: !!b };
}

route('POST', '/api/admin/users', async (req, _r, u) => {
  const orgId = adminOnly(u);
  const { email, name, admin, siteId, role, scope, send, lang } = await json(req);
  const mail = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(mail) || !String(name || '').trim()) fail(400, 'Nom et e-mail requis.');
  const site = siteId ? ownSite(orgId, siteId) : null;
  const r = role === 'approver' ? 'approver' : 'editor';
  // the e-mail goes out unless the administrator prefers to pass the link on themselves
  const emailing = send !== false && mailOn();
  const siteName = site?.name || (await mailFrom(orgId, u, lang)).agency;
  const existing = await userByEmail(mail);
  if (existing) {
    // someone who already has a ClaudePress account: give access, no new account
    if (admin || existing.agency) fail(400, 'Cette personne a déjà un compte administrateur.');
    if (!siteId) fail(400, 'Cette personne a déjà un compte : choisissez le site auquel lui donner accès.');
    await checkClientSeat(orgId, siteId, existing.id);
    await db.set('members', memberId(siteId, existing.id), { site_id: siteId, user_id: existing.id, org_id: orgId, role: r, scope: scopeOf(scope) });
    if (existing.password_hash || existing.firebase_uid) {
      const emailed = emailing && await sendAccess(existing, siteName, `${origin()}/#/site/${siteId}`, await mailFrom(orgId, u, lang));
      return { id: existing.id, inviteUrl: null, existing: true, emailed };
    }
    const url = inviteUrl(await newInvite(existing.id));
    const emailed = emailing && await sendInvite(existing, siteName, url, INVITE_DAYS, await mailFrom(orgId, u, lang));
    return { id: existing.id, inviteUrl: url, existing: true, emailed };
  }
  if (siteId && !admin) await checkClientSeat(orgId, siteId);
  if (admin) await checkAdminSeat(orgId);
  const id = newId();
  await db.set('users', id, { email: mail, name: String(name).trim(), agency: admin ? 1 : 0, org_id: admin ? orgId : null, platform: 0, active: 1,
    firebase_uid: null, password_hash: null, invite_token: null, invite_expires: null, last_login: null, created: now() });
  if (siteId && !admin) await db.set('members', memberId(siteId, id), { site_id: siteId, user_id: id, org_id: orgId, role: r, scope: scopeOf(scope) });
  const url = inviteUrl(await newInvite(id));
  const emailed = emailing && await sendInvite({ email: mail, name: String(name).trim() }, siteName, url, INVITE_DAYS, await mailFrom(orgId, u, lang));
  return { id, inviteUrl: url, emailed };
});

route('POST', '/api/admin/users/:id', async (req, _r, u, [id]) => {
  const orgId = adminOnly(u);
  const target = await ownPerson(orgId, id);
  const { name, admin, active } = await json(req);
  if (name !== undefined && String(name).trim()) await db.update('users', id, { name: String(name).trim() });

  if (target.agency) {
    // an administrator of this account
    const keepAdmin = admin === undefined ? true : !!admin;
    const keepActive = active === undefined ? !!target.active : !!active;
    if (id === u.id && (!keepAdmin || !keepActive)) fail(400, 'Vous ne pouvez pas retirer vos propres droits.');
    if ((!keepAdmin || !keepActive) && (await activeAdmins(orgId)).length <= 1) fail(400, 'Il faut au moins un administrateur.');
    if (keepActive && !target.active) await checkAdminSeat(orgId);
    await db.update('users', id, { agency: keepAdmin ? 1 : 0, org_id: keepAdmin ? orgId : null, active: keepActive ? 1 : 0 });
    if (!keepActive) await endAllSessions(id);
    return { ok: true };
  }

  // a client: their account may also be used by other agencies, so changes stay within this account's sites
  const theirs = await db.find('members', { user_id: id });
  if (active === false) {
    for (const m of theirs.filter(m => m.org_id === orgId)) await db.remove('members', m.id);
    return { ok: true };
  }
  if (admin) {
    if (theirs.some(m => m.org_id !== orgId)) fail(400, 'Cette personne a aussi accès aux sites d’un autre compte : elle ne peut pas devenir administrateur ici.');
    await checkAdminSeat(orgId);
    await db.update('users', id, { agency: 1, org_id: orgId });
    for (const m of theirs) await db.remove('members', m.id);   // administrators reach every site of the account
  }
  return { ok: true };
});

route('POST', '/api/admin/users/:id/invite', async (req, _r, u, [id]) => {
  const orgId = adminOnly(u);
  const p = await ownPerson(orgId, id);
  if (!p.active) fail(404, 'Personne introuvable.');
  const { send, lang, siteId } = await json(req);
  const url = inviteUrl(await newInvite(id));
  // a new invitation by e-mail for someone who has not joined yet; a password link is only shown to the administrator
  const theirs = (await db.find('members', { user_id: id, org_id: orgId })).map(m => m.site_id);
  const site = siteId ? ownSite(orgId, siteId) : mySites(orgId).find(s => theirs.includes(s.id));
  const emailed = send === true && !p.joined && mailOn()
    && await sendInvite(p, site?.name || (await mailFrom(orgId, u, lang)).agency, url, INVITE_DAYS, await mailFrom(orgId, u, lang));
  return { inviteUrl: url, emailed };
});

route('POST', '/api/admin/members', async (req, _r, u) => {
  const orgId = adminOnly(u);
  const { userId, siteId, role, scope, alerts } = await json(req);
  ownSite(orgId, siteId);
  await ownPerson(orgId, userId);
  // uptime alerts (server/monitor.ts) for one person on one site: their e-mail when the site goes down and comes back
  if (alerts !== undefined && !role && scope === undefined) {
    if (!(await db.get('members', memberId(siteId, userId)))) fail(404, 'Cette personne n’a pas accès à ce site.');
    await db.update('members', memberId(siteId, userId), { alerts: alerts ? 1 : 0 });
    return { ok: true };
  }
  if (role && !['editor', 'approver'].includes(role)) fail(400, 'Rôle inconnu.');
  if (scope !== undefined && !SCOPES.includes(scope)) fail(400, 'Étendue inconnue.');
  const cur = await db.get('members', memberId(siteId, userId));
  if (role && !cur) await checkClientSeat(orgId, siteId, userId);
  // role and scope are set separately from the screen: what is not sent stays as it was
  if (role || (scope && cur)) await db.set('members', memberId(siteId, userId), { site_id: siteId, user_id: userId, org_id: orgId,
    role: role || cur?.role || 'editor', scope: scope !== undefined ? scope : cur?.scope || 'page', alerts: cur?.alerts ? 1 : 0 });
  else await db.remove('members', memberId(siteId, userId));
  return { ok: true };
});

// ---- GitHub: the ClaudePress app (created once per server) and each account's installations

const redirect = (res: http.ServerResponse, to: string) => { res.writeHead(302, { location: to }); res.end(); return undefined; };

route('GET', '/api/github', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  const org = await db.get('orgs', orgId);
  return { app: await GHApp.appInfo(), installations: org?.github_installations || [], canCreateApp: !!u.platform };
});

/** Step 1 of creating the app: the form the browser posts to GitHub. */
route('POST', '/api/github/app', async (req, _r, u) => {
  adminOnly(u);
  if (!u.platform) fail(403, 'Réservé à la personne qui gère ce serveur.');
  if (await GHApp.appInfo()) fail(400, 'L’application GitHub existe déjà.');
  const { owner } = await json(req);
  const state = GHApp.newState(u.org_id!);
  const action = owner ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`;
  return { action, manifest: JSON.stringify(GHApp.manifest(origin(), GHApp.appName())) };
});

/** Step 2: GitHub sends the browser back with a code; the app's keys are fetched and stored encrypted. */
route('GET', '/api/github/app-created', async (req, res, u) => {
  const q = new URL(req.url!, 'http://x').searchParams;
  if (!u.platform || !GHApp.takeState(q.get('state') || '')) return redirect(res, '/#/admin/github?github=refused');
  try { await GHApp.saveCreatedApp(q.get('code') || ''); } catch (e) { console.error(e); return redirect(res, '/#/admin/github?github=failed'); }
  return redirect(res, '/#/admin/github?github=app');
});

route('GET', '/api/github/install', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  return { url: (await GHApp.installUrl(GHApp.newState(orgId))) ?? fail(400, 'L’application GitHub n’est pas encore créée sur ce serveur.') };
});

/** After an installation: GitHub sends the browser back; the installation joins the account if it is really theirs. */
route('GET', '/api/github/installed', async (req, res, u) => {
  const orgId = adminOnly(u);
  const q = new URL(req.url!, 'http://x').searchParams;
  const st = GHApp.takeState(q.get('state') || '');
  const id = Number(q.get('installation_id'));
  if (!id || !q.get('code') || (st && st.orgId !== orgId)) return redirect(res, '/#/admin/github?github=refused');
  try { await GHApp.confirmInstallation(orgId, id, q.get('code')!); } catch (e) { console.error(e); return redirect(res, '/#/admin/github?github=refused'); }
  return redirect(res, '/#/admin/github?github=connected');
});

route('GET', '/api/admin/github/repos', async (_q, _r, u) => GHApp.repositoriesOf(adminOnly(u)));

// ---- figures of the sites: one Google connection per account, then each site's Analytics and Search Console properties

const googleRedirect = () => `${origin()}/api/google/connected`;

route('GET', '/api/admin/insights', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  return { google: await Insights.connectionOf(orgId),
    sites: await Promise.all(mySites(orgId).map(async s => ({ id: s.id, name: s.name, liveUrl: s.liveUrl, settings: await Insights.settingsOf(s.id) }))) };
});

route('GET', '/api/admin/google/properties', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  try { return await Insights.propertiesOf(orgId); }
  catch (e) { fail(e instanceof Insights.NotConnected ? 409 : 502, (e as Error).message); }
});

route('GET', '/api/google/connect', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  if (!Insights.googleOn()) fail(400, 'La connexion Google n’est pas configurée sur ce serveur.');
  return { url: Insights.connectUrl(orgId, u.id, googleRedirect()) };
});

/** Google sends the browser back here with a code (or an error, when the person said no). */
route('GET', '/api/google/connected', async (req, res, u) => {
  const orgId = adminOnly(u);
  const q = new URL(req.url!, 'http://x').searchParams;
  if (!q.get('code')) return redirect(res, '/#/admin/insights?google=refused');
  try { await Insights.finishConnect(orgId, u.id, q.get('state') || '', q.get('code')!, googleRedirect()); }
  catch (e) { console.error('[google]', (e as Error).message); return redirect(res, '/#/admin/insights?google=failed'); }
  return redirect(res, '/#/admin/insights?google=connected');
});

/** "Add ClaudePress as a viewer": the account's own Google address, for the agency to add in Analytics and Search Console. */
route('POST', '/api/admin/google/viewer', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  try { await Insights.useViewer(orgId); }
  catch (e: any) {
    console.error('[google viewer]', e.message);
    // Google Cloud's own messages are for the person running the server, not for the agency
    fail(e.status ? 502 : 400, e.status ? 'Google n’a pas pu préparer votre adresse ClaudePress. Réessayez dans un instant.' : e.message);
  }
  return Insights.connectionOf(orgId);
});

route('POST', '/api/admin/google/disconnect', async (_q, _r, u) => {
  const orgId = adminOnly(u);
  await Insights.disconnect(orgId);
  return Insights.connectionOf(orgId);
});

route('POST', '/api/admin/sites/:id/insights', async (req, _r, u, [id]) => {
  ownSite(adminOnly(u), id);
  const { ga4, ga4Name, gsc, clients } = await json(req);
  try { return await Insights.saveSettings(id, { ga4, ga4Name: ga4Name === undefined ? undefined : ga4Name ? String(ga4Name).slice(0, 120) : null, gsc, clients }); }
  catch (e) { fail(400, (e as Error).message); }
});

/** Whether this person sees the site's figures: the agency always, once a property is chosen; clients when allowed. */
async function seesInsights(role: Role, siteId: string) {
  const s = await Insights.settingsOf(siteId);
  return !!(s.ga4 || s.gsc) && (role === 'agency' || s.clients);
}

route('GET', '/api/sites/:id/insights', async (req, _r, u, [id]) => {
  const role = (await roleOn(u, id)) ?? fail(403, 'Accès refusé');
  if (!(await seesInsights(role, id))) fail(404, 'Pas de statistiques pour ce site.');
  const q = new URL(req.url!, 'http://x').searchParams;
  const days = Insights.PERIODS.includes(Number(q.get('days'))) ? Number(q.get('days')) : 28;
  // fetching again before the 6 hours are up: the agency only, so a client's page cannot run up Google's quotas
  return Insights.insightsOf(id, orgIdOfSite(id)!, days, role === 'agency' && q.get('refresh') === '1');
});

/** Checks and completes a website form from the admin screen. */
async function siteFromForm(f: any, orgId: string, existing?: SiteConfig): Promise<SiteConfig> {
  const name = String(f.name || '').trim();
  let id = existing?.id || String(f.id || name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!name || !id) fail(400, 'Le nom du site est requis.');
  if (!existing) for (let n = 2; siteAnyState(id) || await db.get('sites', id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
  const liveUrl = String(f.liveUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\/\S+$/.test(liveUrl)) fail(400, 'Adresse du site invalide (https://…).');
  let repo = String(f.repo || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) repo = `https://github.com/${repo}.git`;   // "owner/name" is a GitHub repository
  if (config.githubOnly && !/^https:\/\/github\.com\//.test(repo)) fail(400, 'Ce serveur travaille avec des dépôts GitHub : organisation/depot.');
  if (await GHApp.appInfo() && /^https:\/\/github\.com\//.test(repo) && !(existing && repo === existing.repo)) {
    const allowed = (await GHApp.repositoriesOf(orgId)).map(r => `https://github.com/${r.fullName}.git`.toLowerCase());
    if (!allowed.includes(repo.toLowerCase())) fail(400, 'Ce dépôt n’est pas autorisé pour votre compte : connectez GitHub et autorisez-le.');
  }
  if (!/^https:\/\/\S+$/.test(repo) && !(existing && repo === existing.repo)) fail(400, 'Dépôt GitHub invalide : organisation/depot ou adresse https.');
  const a = f.adapter || {};
  const md = a.type === 'markdown';
  const build = Array.isArray(a.build) ? a.build : String(a.build || (md ? 'npm run build' : 'python3 build/build.py')).trim().split(/\s+/);
  const common = {
    lang: String(a.lang || 'fr').trim(),
    mediaDir: String(a.mediaDir || (md ? 'public/images' : 'source/media')).trim(),
    mediaPrefix: String(a.mediaPrefix || (md ? '/images/' : '/wp-content/uploads/')).trim(),
    build, outDir: String(a.outDir || (md ? 'dist' : 'site')).trim(),
    buildEnv: existing?.adapter.buildEnv,
    guide: String(a.guide || '').trim(),
    sharedFiles: String(a.sharedFiles ?? existing?.adapter.sharedFiles?.join(' ') ?? '').split(/[\s,]+/).filter(Boolean),
  };
  const collections = md ? parseCollections(a.collections) : [];
  if (md && !collections.length) fail(400, 'Indiquez au moins un dossier de pages Markdown.');
  return {
    id, orgId, name, liveUrl, repo, branch: String(f.branch || 'main').trim(), push: !!f.push,
    previews: f.previews === 'local' && !config.githubOnly ? 'local' : f.previews === 'github' ? 'github'
      : config.previewBuild ? 'claudepress' : config.githubOnly ? 'github' : 'local',
    cacheDirs: String(f.cacheDirs ?? existing?.cacheDirs?.join(' ') ?? '').split(/[\s,]+/).filter(Boolean),
    seedCache: existing?.seedCache || [],
    adapter: md ? { type: 'markdown', collections, ...common } : {
      type: 'blocks-json',
      pagesFile: String(a.pagesFile || 'source/content/pages.json').trim(),
      pricesFile: String(a.pricesFile ?? '').trim() || undefined,
      ...common,
    },
  };
}

/** Folders of Markdown pages, one per line: "<folder> <address pattern> <page|post>", e.g. "src/content/blog /blog/{slug}/ post". */
function parseCollections(text: unknown) {
  if (Array.isArray(text)) return text as MarkdownConfig['collections'];
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [dir, url = '/{path}/', kind = 'page'] = l.split(/\s+/);
    if (dir.split('/').includes('..')) fail(400, `Dossier invalide : ${dir}`);
    return { dir: dir.replace(/^\.?\/|\/$/g, ''), url: url.startsWith('/') ? url : '/' + url, kind: /^(post|article|blog)s?$/i.test(kind) ? 'post' as const : 'page' as const };
  });
}

/** Every site gets the import scan: it proposes the permissions, the notes for the AI and the settings. Runs once a site has none that finished. */
async function scanIfMissing(id: string, userId: string, lang?: string) {
  if ((await scanOf(id))?.state !== 'done') await scanSite(id, userId, lang);
}

route('POST', '/api/admin/sites', async (req, _r, u) => {
  const orgId = adminOnly(u);
  const plan = planOf((await orgOf(orgId))!);
  if (mySites(orgId).length >= plan.sites)
    fail(402, `Votre formule ${plan.name} permet ${plan.sites} site${plan.sites > 1 ? 's' : ''}. Passez à la formule supérieure pour en ajouter.`);
  const body = await json(req);
  const cfg = await siteFromForm(body, orgId);
  await saveSite(cfg);
  // first read and the import scan run in the background; the screen shows the progress
  setupSite(cfg).then(() => { GoLive.redetect(siteAnyState(cfg.id)!).catch(() => {}); return scanSite(cfg.id, u.id, body.lang); });
  return { id: cfg.id };
});

route('POST', '/api/admin/sites/:id', async (req, _r, u, [id]) => {
  const orgId = adminOnly(u);
  const cur = ownSite(orgId, id);
  const body = await json(req);
  const cfg = await siteFromForm({ ...body }, orgId, cur);
  await saveSite(cfg);
  setupSite(cfg).then(() => { GoLive.redetect(siteAnyState(cfg.id)!).catch(() => {}); return scanIfMissing(cfg.id, u.id, body.lang); });
  return { ok: true };
});

route('POST', '/api/admin/sites/:id/retry', (_q, _r, u, [id]) => {
  const orgId = adminOnly(u);
  setupSite(ownSite(orgId, id)).then(() => scanIfMissing(id, u.id));
  return { ok: true };
});

// the import scan: what clients can change, what is shared by every page, what stays with the agency
route('GET', '/api/admin/sites/:id/scan', async (_q, _r, u, [id]) => {
  ownSite(adminOnly(u), id);
  return { scan: await scanOf(id) };
});

route('POST', '/api/admin/sites/:id/scan', async (req, _r, u, [id]) => {
  ownSite(adminOnly(u), id);
  scanSite(id, u.id, (await json(req)).lang);
  return { ok: true };
});

route('POST', '/api/admin/sites/:id/remove', async (_q, _r, u, [id]) => {
  const orgId = adminOnly(u);
  ownSite(orgId, id);
  await removeSite(id);
  await dropMonitor(id);
  await GoLive.dropLive(id);
  await Security.dropSecurity(id);
  return { ok: true };
});

// ------------------------------------------------------------------ sign-in (no session needed)

const mayBeFirstAdmin = (email: string) => !config.firstAdmins?.length || config.firstAdmins.map(e => e.toLowerCase()).includes(email.toLowerCase());

async function setupNeeded() {
  return !(await db.find('users', { agency: 1, active: 1 })).some(x => x.password_hash || x.firebase_uid);
}

/** The first account of a new server, or the one older data belonged to. */
async function firstOrg(name: string, plan: string, aiIncluded: number) {
  const [existing] = (await db.find('orgs')).sort((a, b) => String(a.created).localeCompare(String(b.created)));
  if (existing) return existing.id;
  const id = newId();
  await db.set('orgs', id, { name, plan, ai_included: aiIncluded, api_key_enc: null, api_key_last4: null, created: now() });
  return id;
}

async function adoptOrphanSites(orgId: string) {
  for (const s of allSites()) if (!s.orgId) { s.orgId = orgId; await db.update('sites', s.id, { org_id: orgId }); }
}

const newUser = (email: string, name: string, extra: Record<string, unknown>) => ({
  email, name, agency: 0, org_id: null, platform: 0, active: 1, firebase_uid: null, password_hash: null,
  invite_token: null, invite_expires: null, last_login: null, created: now(), ...extra,
});

async function authRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ok = async (userId: string, extra: object = {}) => { send(res, 200, { ok: true, ...extra }, { 'set-cookie': await startSession(userId) }); return true; };
  const p = url.pathname;
  if (p === '/api/auth/state') { send(res, 200, { setupNeeded: await setupNeeded(), signup: !!config.signup, firebase: config.firebase || null, github: !!(config.firebase && config.githubSignIn), githubOnly: !!config.githubOnly, analytics: config.analytics?.measurementId || null }); return true; }
  if (p === '/api/logout') { send(res, 200, { ok: true }, { 'set-cookie': await endSession(req) }); return true; }
  if (req.method !== 'POST' && !p.startsWith('/api/invite/')) return false;

  // with Firebase Authentication, passwords live at Firebase: the local password routes are closed
  if (config.firebase && req.method === 'POST' && (p === '/api/setup' || p === '/api/login' || p === '/api/signup' || p.startsWith('/api/invite/')))
    fail(400, 'Connectez-vous avec le formulaire de connexion.');

  // the app exchanges the code shown on the web for its own token, kept on the phone
  if (p === '/api/devices/pair') {
    if (tooManyAttempts(ip)) fail(429, 'Trop de tentatives. Réessayez dans un quart d’heure.');
    const { code, name } = await json(req);
    const d = await pairDevice(String(code || ''), String(name || ''));
    if (!d) { recordFailure(ip); fail(404, 'Ce code ne fonctionne pas ou a expiré. Affichez-en un nouveau sur ClaudePress.'); }
    const u = await db.get('users', d!.userId);
    if (!u?.active) fail(403, 'Ce compte est désactivé. Contactez votre administrateur.');
    send(res, 200, { token: d!.token, server: origin(), user: { id: u!.id, name: u!.name, email: u!.email, lang: u!.lang ?? null } });
    return true;
  }

  if (p === '/api/session') {
    if (!config.firebase) fail(400, 'Connexion Firebase non configurée.');
    if (tooManyAttempts(ip)) fail(429, 'Trop de tentatives. Réessayez dans un quart d’heure.');
    const { idToken, invite, name, company } = await json(req);
    let who;
    try { who = await verifyFirebaseToken(config.firebase!.projectId, String(idToken || '')); }
    catch { recordFailure(ip); fail(401, 'Connexion refusée. Réessayez.'); }
    const nm = String(name || who!.name || who!.email.split('@')[0]).trim().slice(0, 80);
    // an invitation link proves the person received it at that address
    if (invite) {
      const iu = await userByInvite(String(invite));
      if (!iu || iu.invite_expires < now()) { recordFailure(ip); fail(404, 'Ce lien d’invitation n’est plus valable. Demandez-en un nouveau à votre administrateur.'); }
      if (iu!.email !== who!.email) fail(400, `Cette invitation est pour ${iu!.email} : connectez-vous avec cette adresse.`);
      await db.update('users', iu!.id, { firebase_uid: who!.uid, name: nm || iu!.name, invite_token: null, invite_expires: null });
      return ok(iu!.id);
    }
    if (!who!.emailVerified) fail(403, 'EMAIL_NOT_VERIFIED');
    const known = (await db.find('users', { firebase_uid: who!.uid }))[0] || await userByEmail(who!.email);
    if (known) {
      if (!known.active) fail(403, 'Ce compte est désactivé. Contactez votre administrateur.');
      await db.update('users', known.id, { firebase_uid: who!.uid, invite_token: null, invite_expires: null });
      return ok(known.id);
    }
    if (await setupNeeded() && mayBeFirstAdmin(who!.email)) {
      // the first person to sign in on a new server becomes its administrator
      const orgId = await firstOrg(String(company || config.agencyName || 'Mon agence').trim(), 'agency', 1);
      const id = newId();
      await db.set('users', id, newUser(who!.email, nm, { agency: 1, platform: 1, org_id: orgId, firebase_uid: who!.uid }));
      await adoptOrphanSites(orgId);
      return ok(id, { created: 'admin' });
    }
    if (config.signup) {
      const orgId = newId(), id = newId();
      await db.set('orgs', orgId, { name: String(company || nm).trim().slice(0, 80), plan: allPlans()[0].id, ai_included: 0, api_key_enc: null, api_key_last4: null, created: now() });
      await db.set('users', id, newUser(who!.email, nm, { agency: 1, org_id: orgId, firebase_uid: who!.uid }));
      return ok(id, { created: 'account' });
    }
    fail(403, 'Aucun compte ClaudePress pour cette adresse. Demandez une invitation à votre agence.');
  }

  if (p === '/api/setup') {
    if (!(await setupNeeded())) fail(403, 'Le compte administrateur existe déjà.');
    const { name, email, password } = await json(req);
    const mail = String(email || '').trim().toLowerCase();
    if (!mayBeFirstAdmin(mail)) fail(403, 'Cette adresse ne peut pas créer le compte administrateur de ce serveur.');
    if (!/^\S+@\S+\.\S+$/.test(mail) || !String(name || '').trim()) fail(400, 'Nom et e-mail requis.');
    const bad = passwordProblem(password); if (bad) fail(400, bad);
    const existing = await userByEmail(mail);
    const orgId = existing?.org_id || await firstOrg(config.agencyName || 'Mon agence', 'agency', 1);
    const id = existing?.id || newId();
    if (existing) await db.update('users', id, { name: String(name).trim(), agency: 1, active: 1, platform: 1, org_id: orgId, password_hash: hashPassword(password) });
    else await db.set('users', id, newUser(mail, String(name).trim(), { agency: 1, platform: 1, org_id: orgId, password_hash: hashPassword(password) }));
    await adoptOrphanSites(orgId);
    return ok(id);
  }

  // new administrator accounts start on the Free plan (1 site, their own Claude key)
  if (p === '/api/signup') {
    if (!config.signup) fail(403, 'Les inscriptions ne sont pas ouvertes sur ce serveur.');
    if (tooManyAttempts(ip)) fail(429, 'Trop de tentatives. Réessayez dans un quart d’heure.');
    const { name, company, email, password } = await json(req);
    const mail = String(email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(mail) || !String(name || '').trim()) fail(400, 'Nom et e-mail requis.');
    const bad = passwordProblem(password); if (bad) fail(400, bad);
    if (await userByEmail(mail)) { recordFailure(ip); fail(400, 'Un compte existe déjà avec cet e-mail. Connectez-vous.'); }
    const orgId = newId(), id = newId();
    await db.set('orgs', orgId, { name: String(company || name).trim().slice(0, 80), plan: allPlans()[0].id, ai_included: 0, api_key_enc: null, api_key_last4: null, created: now() });
    await db.set('users', id, newUser(mail, String(name).trim(), { agency: 1, org_id: orgId, password_hash: hashPassword(password) }));
    return ok(id);
  }

  if (p === '/api/login') {
    const { email, password } = await json(req);
    const mail = String(email || '').trim().toLowerCase();
    if (tooManyAttempts(ip, mail)) fail(429, 'Trop de tentatives. Réessayez dans un quart d’heure.');
    const u = await userByEmail(mail);
    if (!u || !u.active || !checkPassword(String(password || ''), u.password_hash)) { recordFailure(ip, mail); fail(401, 'E-mail ou mot de passe incorrect.'); }
    return ok(u.id);
  }

  const inv = /^\/api\/invite\/([a-z0-9]+)$/.exec(p);
  if (inv) {
    if (tooManyAttempts(ip)) fail(429, 'Trop de tentatives. Réessayez dans un quart d’heure.');
    const iu = await userByInvite(inv[1]);
    if (!iu || iu.invite_expires < now()) { recordFailure(ip); fail(404, 'Ce lien d’invitation n’est plus valable. Demandez-en un nouveau à votre administrateur.'); }
    if (req.method === 'GET') { send(res, 200, { name: iu!.name, email: iu!.email, brand: await brandFor(iu!) }); return true; }
    const { name, password } = await json(req);
    const bad = passwordProblem(password); if (bad) fail(400, bad);
    await db.update('users', iu!.id, { name: String(name || '').trim() || iu!.name, password_hash: hashPassword(password), invite_token: null, invite_expires: null });
    await endAllSessions(iu!.id);
    return ok(iu!.id);
  }
  return false;
}

// ------------------------------------------------------------------ server

// ------------------------------------------------------------------ the extension's own routes (server/extension.ts)

const openRoutes: Parameters<RouteKit['open']>[0][] = [];
ext.routes?.({
  route, open: h => { openRoutes.push(h); }, fail, json, adminOnly, accountView, sitesOf: mySites,
  forget: orgId => { forgetAccount(orgId); Security.forgetSecurity(orgId); },
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://x');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (PUBLIC_HOST && host.endsWith('.hosted.app') && host !== PUBLIC_HOST && (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
      res.writeHead(301, { location: origin() + (req.url || '/') });
      return res.end();
    }

    // previews, only for signed-in people: /preview/live/<site>/… is the published site, /preview/c/<change>/… one change applied
    const pv = /^\/preview\/(live|c)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (pv) {
      const u = (await userOf(req)) ?? fail(401, 'Connectez-vous');
      const [, kind, id, rest] = pv;
      if (!rest) { res.writeHead(302, { location: url.pathname + '/' }); return res.end(); }
      const c = kind === 'c' ? (await db.get<ChangeRow>('changes', id)) ?? fail(404, 'Aperçu introuvable') : null;
      const s = site(c ? c.site_id : id);
      if (!(await roleOn(u, s.id))) fail(403, 'Accès refusé');
      if (s.previews !== 'local') {
        if (!c) return proxySite(res, s.liveUrl, `/preview/live/${id}`, rest + url.search);
        if (s.previews === 'github') return proxySite(res, c.preview_url ?? fail(404, 'Aperçu pas encore prêt'), `/preview/c/${id}`, rest + url.search);
        if (s.staging.change !== c.id || !s.staging.build) fail(404, 'L’adresse d’aperçu montre maintenant un autre changement.');
        return serveBuilt(res, `sites/${s.id}/${s.staging.build}`, `/preview/c/${id}`, rest);
      }
      const dir = c ? previewDir(s.id, c.id) : s.base;
      // originals that the build does not copy (replaced photos) still show in "before"
      const media = (p: string) => { try { return s.adapter_.mediaFile(dir, p); } catch { return null; } };
      return serveSite(res, path.join(dir, path.relative(s.base, s.baseOut)), `/preview/${kind}/${id}`, rest, media);
    }

    // the site's preview address, for people without an account: /s/<token>/…
    const sh = /^\/s\/([\w-]{20,})(\/.*)?$/.exec(url.pathname);
    if (sh) {
      const s = siteByShareToken(sh[1]);
      if (!s || !s.staging.build) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<p style="font:16px system-ui;padding:40px">Aucun aperçu en cours pour ce site.</p>'); }
      if (!sh[2]) { res.writeHead(302, { location: url.pathname + '/' }); return res.end(); }
      return serveBuilt(res, `sites/${s.id}/${s.staging.build}`, `/s/${sh[1]}`, sh[2], true);
    }

    // white-label logos and tab icons: public, so sign-in and invitation screens can show them; the name changes with each new image
    const logo = /^\/brand-logo\/([a-z0-9]+-[a-z0-9]+\.(webp|png))$/.exec(url.pathname);
    if (logo && req.method === 'GET') {
      const data = await db.getFile(`brand/${logo[1]}`);
      if (!data) return send(res, 404, { error: 'introuvable' });
      res.writeHead(200, { 'content-type': `image/${logo[2]}`, 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(data);
    }

    // the monitoring's minute tick (Cloud Scheduler): no session, it only checks what is due, so calling it more often does nothing
    // it also publishes the changes scheduled for now, checks that published changes reach the live site, and starts
    // the daily security checks that are due
    if (url.pathname === '/api/monitor/tick' && req.method === 'POST') {
      const [checked, published, live, security] = await Promise.all([tick(), publishDue(), GoLive.liveTick(), Security.securityTick()]);
      return send(res, 200, { checked, published, live, security });
    }

    // the extension's routes that need no session (a payment provider's webhook, proved by its signature)
    for (const h of openRoutes) if (await h(req, res, url)) return;

    if (url.pathname.startsWith('/api/')) {
      if (await authRoutes(req, res, url)) return;
      const u = (await userOf(req)) ?? fail(401, 'Connectez-vous');
      if (url.pathname.startsWith('/api/uploads/') && req.method === 'GET') {
        const name = path.basename(url.pathname.slice(13));
        const data = await db.getFile(`uploads/${name}`);
        if (!data) return send(res, 404, { error: 'introuvable' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' });
        return res.end(data);
      }
      for (const [method, re, h] of routes) {
        const m = re.exec(url.pathname);
        if (m && method === req.method) {
          const out = await h(req, res, u, m.slice(1).map(decodeURIComponent));
          if (out !== undefined && !res.headersSent) send(res, 200, out);
          return;
        }
      }
      return send(res, 404, { error: 'Route inconnue' });
    }

    // the extension's screens, under /ext/
    if (EXT_WEB && url.pathname.startsWith('/ext/')) {
      const e = path.join(EXT_WEB, path.normalize(url.pathname.slice(4)));
      if (e.startsWith(EXT_WEB + path.sep) && fs.existsSync(e) && fs.statSync(e).isFile()) return serveFile(res, e);
      return send(res, 404, { error: 'introuvable' });
    }
    // the app itself: static files, every other path is the single-page app
    const f = path.join(WEB, path.normalize(url.pathname));
    if (f.startsWith(WEB) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      return serveFile(res, f);
    }
    // the interface's translation layer is loaded with every page of the app (web/i18n.js), and the extension's screens
    return serveFile(res, path.join(WEB, 'index.html'), '<script type="module" src="/i18n.js"></script>'
      + (EXT_WEB && fs.existsSync(path.join(EXT_WEB, 'app.js')) ? '<meta name="claudepress-extension" content="/ext/app.js">' : ''));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof AiUnavailable ? 402 : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: (e as Error).message });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`ClaudePress on ${origin()}`));
initSites();   // sites become available one by one as their checkout is ready
sealOldKeys().catch(e => console.error('[keys] not sealed again:', (e as Error).message));
ext.start?.();
startMonitor();
GoLive.startLiveChecks();
Security.startSecurity();
// scheduled changes are looked at with the monitoring's ticks; a server that is always up does not wait for them
setInterval(() => publishDue().catch(e => console.error('[schedule]', e)), 15_000);
