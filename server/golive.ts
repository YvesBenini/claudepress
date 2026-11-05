// Going live: does a published change reach the live site? Publishing puts the change on the site's branch on GitHub;
// what deploys it is the site's host (Netlify, Vercel, Cloudflare Pages, GitHub Pages, a workflow…). When nothing
// deploys that branch, the change sits on GitHub and the site never changes: this module notices it and says so.
//   1. How a site deploys, read from GitHub (when it is added, then once a day): hosting services leave deployments,
//      commit statuses or check runs on the commits they deploy, and a workflow can deploy each push to the branch.
//   2. After each publish, the changed pages are read on the live address until the new text (or photo, or new
//      article) shows there. The same pages are read once while the commit is being made: only a text that was
//      absent then and shows now counts, and a page where the old text cannot be found (built in the browser, at
//      another address) is left out. What pages cannot show (code, prices) waits for GitHub: a production deployment
//      of the commit that succeeded, or a deploy check that passed.
//   3. Not live 30 minutes after it was published, or its deploy failed: the account's administrators are told, by
//      e-mail and in the app, with what is known of the site's deploys and where to set one up. Clients see a calm word.
// Checks run on a timer, and with the monitoring's tick (POST /api/monitor/tick) on servers that sleep: only what is due.
//
// Collections:
//   golive    id = site  site_id, org_id, method {kind, host, workflow, checked}, seen_live, minutes (the last times to go live), alerted
//   changes   live ('checking' | 'live' | 'late' | 'failed' | 'unverified' | 'local'), live_watch, live_sha, live_expect,
//             live_checked, live_at, live_detail, live_url, live_alerted
import { config } from './config.ts';
import { db, notify, now, type ChangeRow } from './db.ts';
import * as GH from './github.ts';
import { siteAnyState, type Site } from './sites.ts';
import { brandOf, orgOf } from './billing.ts';
import { layout, mailOn, sendMail } from './mail.ts';
import { fetchPage } from './monitor.ts';
import type { Op } from './adapters/types.ts';

const LATE = 30;                 // minutes after publishing before the administrators are told
const GIVE_UP = 24 * 60;         // minutes after publishing when the checks stop (a later publish that goes live settles it)
const ALERT_EVERY = 6 * 3600e3;  // one e-mail per site in this time, however many changes are late
const METHOD_AGE = 24 * 3600e3;  // how long what was found about a site's deploys is kept
const PAGES = 4, EXPECTS = 6;

const origin = () => (config.publicUrl || `http://${config.host || 'localhost'}:${process.env.PORT || config.port || 4400}`).replace(/\/$/, '');
const minutesSince = (iso: string | null | undefined) => iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000)) : 0;

type LiveState = NonNullable<ChangeRow['live']>;
type Live = ChangeRow;

// ---- how a site deploys

export interface Method {
  kind: 'host' | 'workflow' | 'none' | 'local' | 'unknown';
  host: string | null;        // the hosting service, when it can be named
  workflow: string | null;    // the GitHub Actions workflow that deploys
  checked: string;
}

const HOSTS: [RegExp, string][] = [
  [/netlify/i, 'Netlify'], [/vercel/i, 'Vercel'], [/cloudflare|wrangler/i, 'Cloudflare Pages'], [/github-pages|pages build and deployment|actions\/deploy-pages|gh-pages/i, 'GitHub Pages'],
  [/firebase/i, 'Firebase Hosting'], [/\brender\b/i, 'Render'], [/amplify/i, 'AWS Amplify'], [/azure/i, 'Azure Static Web Apps'], [/railway/i, 'Railway'],
  [/digitalocean/i, 'DigitalOcean'], [/hostinger/i, 'Hostinger'], [/surge\.sh|\bsurge\b/i, 'Surge'], [/ftp-deploy|\bl?ftp\b|sftp/i, 'FTP'],
];
const hostIn = (text: string) => HOSTS.find(([re]) => re.test(text))?.[1] ?? null;
// environments of previews, not of the live site
const PREVIEW = /preview|staging|\bdev\b|development|\btest|pr-\d|pull/i;
// a check run of GitHub Actions that deploys, by its job's name
const DEPLOY_JOB = /deploy|pages|publish|hosting|ftp|upload|release/i;

/** What the deploys of one commit say: live (deployed), failed, pending (started), or nothing about it. */
export function readSignals(sig: GH.Signals): { state: 'live' | 'failed' | 'pending' | 'none'; host: string | null; url: string | null; detail: string | null } {
  const found: { state: 'live' | 'failed' | 'pending'; host: string | null; url: string | null; detail: string | null }[] = [];
  for (const d of sig.deployments) {
    if (PREVIEW.test(d.env)) continue;
    const host = hostIn(`${d.by} ${d.env}`) ?? (d.by ? d.by.replace(/\[bot\]/, '') : null);
    const state = d.state === 'success' ? 'live' : d.state === 'failure' || d.state === 'error' ? 'failed' : 'pending';
    found.push({ state, host, url: d.url, detail: state === 'failed' ? `${host || 'deployment'} · ${d.env}` : null });
  }
  for (const s of sig.statuses) {
    const host = hostIn(s.context);
    if (!host || PREVIEW.test(s.context)) continue;
    const state = s.state === 'success' ? 'live' : s.state === 'failure' || s.state === 'error' ? 'failed' : 'pending';
    found.push({ state, host, url: s.url, detail: state === 'failed' ? s.context : null });
  }
  for (const c of sig.checks) {
    const host = hostIn(`${c.app} ${c.name}`);
    if (!host && !(c.app === 'github-actions' && DEPLOY_JOB.test(c.name))) continue;
    if (PREVIEW.test(c.name)) continue;
    const state = c.status !== 'completed' ? 'pending' : c.conclusion === 'success' ? 'live'
      : ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(c.conclusion || '') ? 'failed' : null;
    if (state) found.push({ state, host: host ?? 'GitHub Actions', url: c.url, detail: state === 'failed' ? `${c.name} : ${c.conclusion}` : null });
  }
  return found.find(f => f.state === 'live') ?? found.find(f => f.state === 'failed') ?? found.find(f => f.state === 'pending')
    ?? { state: 'none', host: null, url: null, detail: null };
}

/** A workflow that runs on pushes to `branch` and deploys something: its name, and the service it deploys to when named. */
export function deployingWorkflow(files: { path: string; text: string }[], branch: string) {
  for (const f of files) {
    const t = f.text;
    const onPush = /^on:\s*(\[[^\]]*\bpush\b[^\]]*\]|push\b)/m.test(t) || /^on:\s*$[\s\S]*?^\s+push:/m.test(t);
    if (!onPush) continue;
    // a list of branches that does not name this one (or a wildcard) does not deploy it
    const branches = /^\s+push:\s*$\s+branches(?:-ignore)?:\s*(\[[^\]]*\]|(?:\s*-\s*.+\n?)+)/m.exec(t)?.[1];
    if (branches && !new RegExp(`(^|[\\s\\[,'"-])(${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|\\*+)([\\s\\],'"]|$)`).test(branches)) continue;
    if (!/deploy|pages|firebase|netlify|vercel|wrangler|ftp|rsync|scp|ssh|s3 sync|gsutil|surge|hostinger|azure|amplify/i.test(t)) continue;
    const name = /^name:\s*['"]?(.+?)['"]?\s*$/m.exec(t)?.[1] ?? f.path.replace(/^.*\//, '');
    return { name, host: hostIn(t.replace(/^name:.*$/m, '')) };
  }
  return null;
}

/** Looks at GitHub for what deploys the site's branch. */
export async function detect(s: Site): Promise<Method> {
  const at = now();
  if (s.previews === 'local' && !s.push) return { kind: 'local', host: null, workflow: null, checked: at };
  const repo = GH.repoOf(s.repo);
  if (!repo) return { kind: 'unknown', host: null, workflow: null, checked: at };
  try {
    for (const sha of await GH.recentCommits(repo, s.branch, 5)) {
      const r = readSignals(await GH.signalsOf(repo, sha));
      if (r.state !== 'none' && r.host && r.host !== 'GitHub Actions') return { kind: 'host', host: r.host, workflow: null, checked: at };
    }
    const wf = deployingWorkflow(await GH.workflowsOf(repo, s.branch), s.branch);
    if (wf) return { kind: 'workflow', host: wf.host, workflow: wf.name, checked: at };
    return { kind: 'none', host: null, workflow: null, checked: at };
  } catch (e) {
    console.error(`[golive] ${s.id}: deploys not read:`, (e as Error).message);
    return { kind: 'unknown', host: null, workflow: null, checked: at };
  }
}

interface SiteLive { site_id: string; org_id: string | null; method: Method | null; seen_live: string | null; minutes: number[]; alerted: string | null }
const record = async (s: Site): Promise<SiteLive> =>
  ({ site_id: s.id, org_id: s.orgId ?? null, method: null, seen_live: null, minutes: [], alerted: null, ...(await db.get<SiteLive>('golive', s.id)) });

const detecting = new Map<string, Promise<Method>>();
/** Reads the site's deploys again now. */
export function redetect(s: Site) {
  if (!detecting.has(s.id)) detecting.set(s.id, (async () => {
    try {
      const method = await detect(s);
      await db.set('golive', s.id, { ...(await record(s)), method });
      return method;
    } finally { detecting.delete(s.id); }
  })());
  return detecting.get(s.id)!;
}
/** What is known of a site's deploys; read again in the background once it is a day old. */
async function methodOf(s: Site) {
  const m = (await record(s)).method;
  const stale = !m || Date.now() - Date.parse(m.checked) > METHOD_AGE
    || (m.kind === 'local') !== (s.previews === 'local' && !s.push);   // publishing to GitHub was turned on or off
  if (stale && s.status === 'ready') redetect(s).catch(() => {});
  return m;
}

// ---- what a change should show on the live site

/** A text as pages and contents are compared: tags out, entities read, accents and punctuation dropped, lower case. */
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô', ugrave: 'ù', ucirc: 'û', uuml: 'ü', oelig: 'œ', Eacute: 'É', Agrave: 'À' };
const decode = (s: string) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? ' ');   // the others are punctuation
export const norm = (s: string) => decode(String(s ?? '').replace(/<[^>]*>/g, ' ')).normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

/** A page as checks read it: its text, and the values of its attributes (photos, descriptions, titles), apart. */
function haystack(html: string) {
  const body = html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  const attrs = (html.match(/<[a-z][^>]*>/gi) || []).flatMap(tag => [...tag.matchAll(/\s[\w:-]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => m[1] ?? m[2]));
  return { text: ` ${norm(body)} `, attrs: ` ${norm(attrs.join(' | ').replace(/\|/g, ' . '))} ` };
}
const shows = (h: { text: string; attrs: string }, needle: string) => h.text.includes(` ${needle} `) || h.attrs.includes(` ${needle} `);

/**
 * Where a text changed, with enough words around it to be found on a page and nowhere else: the old words and the
 * new. Null when nothing that a page shows changed.
 */
export function fragments(before: string, after: string) {
  const A = norm(before).split(' ').filter(Boolean), B = norm(after).split(' ').filter(Boolean);
  if (!B.length || A.join(' ') === B.join(' ')) return null;
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0; while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  /** The changed words of one side, widened with their neighbours to about 24 letters, at most 12 words. */
  const window = (W: string[], from: number, to: number) => {
    let a = from, b = Math.min(to, from + 12);
    for (let left = true; W.slice(a, b).join(' ').length < 24 && (a > 0 || b < W.length) && b - a < 12; left = !left) {
      if (left && a > 0) a--; else if (b < W.length) b++; else a--;
    }
    return W.slice(a, b).join(' ');
  };
  return { was: A.length ? window(A, p, A.length - q) : '', now: window(B, p, B.length - q) };
}

/** What one operation will show once it is live, on which page. */
interface Expect { url: string; was?: string; now?: string; added?: boolean; gone?: boolean }

function expectOf(op: Op): Expect | null {
  const text = (v: unknown) => Array.isArray(v) ? v.join(' ') : String(v ?? '');
  // a photo shows by its file name (builds may resize it, change its type or add a hash after the name)
  const file = (v: unknown) => norm(text(v).replace(/[?#].*$/, '').replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, ''));
  switch (op.kind) {
    case 'set': {
      if (op.field === 'href') return null;
      if (op.field === 'src') { const was = file(op.before), now = file(op.after); return now && now !== was ? { url: op.url, was, now } : null; }
      const f = fragments(text(op.before), text(op.after));
      return f && f.was ? { url: op.url, ...f } : null;
    }
    case 'seo': case 'shared': { const f = fragments(op.before, op.after); return f && f.was ? { url: op.url, ...f } : null; }
    case 'create_post': return { url: op.url, now: norm(op.post.title), added: true };
    case 'delete_post': return { url: op.url, gone: true };
    default: return null;   // prices, files: GitHub tells
  }
}

const pageUrl = (s: Site, url: string) => {
  const u = new URL(url, s.liveUrl.replace(/\/?$/, '/'));
  u.searchParams.set('claudepress', Date.now().toString(36));   // past a cache that keys on the address
  return u.toString();
};

/** The pages of the expectations, read once each. */
async function readPages(s: Site, list: Expect[]) {
  const urls = [...new Set(list.map(e => e.url))];
  return new Map(await Promise.all(urls.map(async u => [u, await fetchPage(pageUrl(s, u), 12_000)] as const)));
}
const ok = (p: { status: number | null }) => !!p.status && p.status >= 200 && p.status < 300;
const missing = (p: { status: number | null }) => p.status === 404 || p.status === 410;

/**
 * What the change will show, kept only where the live site still shows the old version: read while the commit is
 * made, before any deploy. Pages where the old text is not found cannot tell, and are left out.
 */
export async function expectations(s: Site, ops: Op[]): Promise<Expect[]> {
  const wanted: Expect[] = [];
  for (const op of ops) {
    const e = expectOf(op);
    if (e && !wanted.some(w => w.url === e.url && w.now === e.now) && (wanted.some(w => w.url === e.url) || new Set(wanted.map(w => w.url)).size < PAGES)) wanted.push(e);
    if (wanted.length >= EXPECTS) break;
  }
  if (!wanted.length || !/^https?:\/\//.test(s.liveUrl || '')) return [];
  const pages = await readPages(s, wanted);
  return wanted.filter(e => {
    const p = pages.get(e.url)!;
    if (e.gone) return ok(p);
    if (e.added) return missing(p);
    if (!ok(p)) return false;
    const h = haystack(p.html);
    return shows(h, e.was!) && !shows(h, e.now!);
  });
}

/** Does any of the change show on the live site now? */
async function seenOnSite(s: Site, list: Expect[]) {
  if (!list.length) return false;
  const pages = await readPages(s, list);
  return list.some(e => {
    const p = pages.get(e.url)!;
    if (e.gone) return missing(p);
    return ok(p) && shows(haystack(p.html), e.now!);
  });
}

// ---- following a published change

/** Called as a change is published: `expect` was started before its commit, so it read the old version. */
export async function follow(changeId: string, s: Site, sha: string | null, expect: Promise<Expect[]>) {
  if (s.previews === 'local' && !s.push) { await db.update('changes', changeId, { live: 'local', live_watch: 0 }); return; }
  const list = await expect.catch(() => [] as Expect[]);
  await db.update('changes', changeId, { live: 'checking', live_watch: 1, live_sha: sha, live_expect: JSON.stringify(list), live_checked: null,
    live_at: null, live_detail: null, live_url: null, live_alerted: null });
}

/** Checks one change now; returns its state. */
export async function check(changeId: string): Promise<LiveState | null> {
  const c = await db.get<Live>('changes', changeId);
  if (!c?.live || !c.published || c.live === 'live' || c.live === 'local') return c?.live ?? null;
  const s = siteAnyState(c.site_id);
  if (!s) { await db.update('changes', c.id, { live_watch: 0 }); return c.live; }
  const list: Expect[] = JSON.parse(c.live_expect || '[]');
  const repo = GH.repoOf(s.repo);
  let seen = await seenOnSite(s, list), gh: ReturnType<typeof readSignals> | null = null;
  if (!seen && repo && c.live_sha) gh = await GH.signalsOf(repo, c.live_sha).then(readSignals).catch(() => null);
  const age = minutesSince(c.published);
  await db.update('changes', c.id, { live_checked: now() });
  if (seen || gh?.state === 'live') { await wentLive(c, s, gh?.url ?? null); return 'live'; }
  if (gh?.state === 'failed' && c.live !== 'failed') {
    await db.update('changes', c.id, { live: 'failed', live_detail: gh.detail, live_url: gh.url });
    await alert(s, c, 'failed', { detail: gh.detail, url: gh.url });
    return 'failed';
  }
  if (c.live === 'checking' && age >= LATE) {
    const site = await record(s);
    // nothing a page or GitHub could show either way: said quietly, unless this site was never seen deploying
    if (!list.length && (!gh || gh.state === 'none') && (site.seen_live || site.method?.kind === 'host' || site.method?.kind === 'workflow')) {
      await db.update('changes', c.id, { live: 'unverified', live_watch: 0 });
      return 'unverified';
    }
    await db.update('changes', c.id, { live: 'late' });
    await alert(s, c, 'late', { minutes: age });
    return 'late';
  }
  if (age >= GIVE_UP) await db.update('changes', c.id, { live_watch: 0 });
  return c.live;
}

/** The change shows: so do the changes published before it on the same branch, still waiting. */
async function wentLive(c: Live, s: Site, url: string | null) {
  const at = now(), minutes = minutesSince(c.published);
  const waiting = (await db.find<Live>('changes', { site_id: s.id, live_watch: 1 })).filter(x => x.id !== c.id && x.published && x.published <= c.published!);
  for (const x of [c, ...waiting]) {
    await db.update('changes', x.id, { live: 'live', live_watch: 0, live_at: at, live_url: url ?? x.live_url ?? null });
    if (x.live_alerted) await alert(s, x, 'live', { minutes: minutesSince(x.published) });
  }
  const site = await record(s);
  await db.set('golive', s.id, { ...site, seen_live: at, minutes: [...site.minutes, minutes].slice(-10) });
}

const due = (c: Live) => {
  const age = Date.now() - Date.parse(c.published!);
  const gap = age < 15 * 60e3 ? 60e3 : age < 2 * 3600e3 ? 5 * 60e3 : 30 * 60e3;
  return !c.live_checked || Date.now() - Date.parse(c.live_checked) >= gap - 5_000;
};

/** Checks every published change that is due. Never two runs at once. */
let running: Promise<number> | null = null;
export function liveTick() {
  return running ??= (async () => {
    try {
      const list = (await db.find<Live>('changes', { live_watch: 1 })).filter(c => c.published && due(c));
      for (const c of list) await check(c.id).catch(e => console.error(`[golive] ${c.id}:`, (e as Error).message));
      return list.length;
    } finally { running = null; }
  })();
}

export function startLiveChecks() {
  const run = () => liveTick().catch(e => console.error('[golive]', e));
  setTimeout(run, 20_000);
  setInterval(run, 20_000);
}

// ---- alerts: the administrators get what was found; the clients only see the change's state

type Lang = 'fr' | 'en';
type Kind = 'late' | 'failed' | 'live';

/** Why a change may not be live, from what is known of the site's deploys. */
function reason(m: Method | null, branch: string, lang: Lang) {
  const fr = lang === 'fr';
  if (m?.kind === 'host' && m.host) return fr ? `D’habitude, ${m.host} met ce site en ligne : regardez son dernier déploiement chez ${m.host}.`
    : `${m.host} usually deploys this site: look at its latest deploy in ${m.host}.`;
  if (m?.kind === 'workflow') return fr ? `D’habitude, l’action GitHub « ${m.workflow} » met ce site en ligne : regardez sa dernière exécution dans l’onglet Actions du dépôt.`
    : `The GitHub workflow “${m.workflow}” usually deploys this site: look at its latest run in the repository’s Actions tab.`;
  if (m?.kind === 'none') return fr ? `ClaudePress ne voit rien qui mette ce site en ligne quand GitHub change : aucun hébergeur n’a signalé de déploiement, et aucune action GitHub ne déploie la branche ${branch}.`
    : `ClaudePress sees nothing that deploys this site when GitHub changes: no host reported a deploy, and no GitHub workflow deploys the branch ${branch}.`;
  return fr ? `Vérifiez que l’hébergeur du site se met à jour quand la branche ${branch} change sur GitHub.` : `Check that the site’s host updates when the branch ${branch} changes on GitHub.`;
}

function texts(kind: Kind, site: string, title: string, info: any, m: Method | null, branch: string, lang: Lang) {
  const fr = lang === 'fr';
  if (kind === 'late') return {
    notice: `« ${title} » n’est pas encore sur le site en ligne de ${site}, ${info.minutes} min après sa publication.`,
    subject: fr ? `🟠 « ${title} » n’est pas encore en ligne sur ${site}` : `🟠 “${title}” is not live on ${site} yet`,
    body: [fr ? `« ${title} » a été publié il y a ${info.minutes} min. Le changement est sur GitHub (branche ${branch}), mais le site en ligne montre toujours l’ancienne version.`
      : `“${title}” was published ${info.minutes} min ago. The change is on GitHub (branch ${branch}), but the live site still shows the old version.`,
      reason(m, branch, lang),
      fr ? 'ClaudePress continue de vérifier et vous écrit dès que le changement apparaît.' : 'ClaudePress keeps checking and writes to you as soon as the change shows.'],
    button: fr ? 'Voir comment le mettre en ligne' : 'See how to get it live',
  };
  if (kind === 'failed') return {
    notice: `La mise en ligne de « ${title} » a échoué sur ${site}${info.detail ? ` (${info.detail})` : ''}.`,
    subject: fr ? `🔴 La mise en ligne de « ${title} » a échoué` : `🔴 Deploying “${title}” failed`,
    body: [fr ? `« ${title} » est sur GitHub, mais sa mise en ligne sur ${site} a échoué${info.detail ? ` : ${info.detail}` : ''}.`
      : `“${title}” is on GitHub, but deploying it to ${site} failed${info.detail ? `: ${info.detail}` : ''}.`,
      ...(info.url ? [fr ? `Le journal de l’erreur : ${info.url}` : `The error log: ${info.url}`] : []),
      fr ? 'Une fois l’erreur corrigée, le prochain déploiement mettra ce changement en ligne.' : 'Once the error is fixed, the next deploy will put this change live.'],
    button: fr ? 'Ouvrir le site dans ClaudePress' : 'Open the site in ClaudePress',
  };
  return {
    notice: `« ${title} » est maintenant sur le site en ligne de ${site}, ${info.minutes} min après sa publication.`,
    subject: fr ? `🟢 « ${title} » est en ligne sur ${site}` : `🟢 “${title}” is live on ${site}`,
    body: [fr ? `« ${title} » est maintenant sur le site en ligne, ${info.minutes} min après sa publication.` : `“${title}” is now on the live site, ${info.minutes} min after it was published.`],
    button: fr ? 'Voir le site' : 'See the site',
  };
}

async function alert(s: Site, c: Live, kind: Kind, info: any) {
  const site = await record(s);
  // one e-mail per site every few hours when changes are late; a failure, and its end, are always told
  const mail = kind !== 'late' || !site.alerted || Date.now() - Date.parse(site.alerted) > ALERT_EVERY;
  if (kind !== 'live') {
    await db.update('changes', c.id, { live_alerted: now() });
    if (mail) await db.set('golive', s.id, { ...site, alerted: now() });
  }
  const org = await orgOf(s.orgId);
  const brand = brandOf(org);
  const admins = s.orgId ? await db.find('users', { agency: 1, active: 1, org_id: s.orgId }) : await db.find('users', { agency: 1, active: 1 });
  if (!admins.length) return;
  await notify(admins.map(a => a.id), c.id, texts(kind, s.name, c.title || 'Modification', info, site.method, s.branch, 'fr').notice);
  if (!mail || !mailOn()) return;
  const agency = brand?.name || org?.name || config.agencyName || 'ClaudePress';
  for (const p of admins) {
    const lang: Lang = p.lang === 'en' ? 'en' : 'fr';
    const t = texts(kind, s.name, c.title || (lang === 'fr' ? 'Modification' : 'Edit'), info, site.method, s.branch, lang);
    const url = kind === 'live' ? s.liveUrl : `${origin()}/#/admin/site/${s.id}`;
    const { html, text } = layout(t.body, { label: t.button, url }, [lang === 'fr' ? `Vérification de la mise en ligne de ${s.liveUrl.replace(/^https?:\/\/|\/$/g, '')}.`
      : `Go-live check of ${s.liveUrl.replace(/^https?:\/\/|\/$/g, '')}.`], brand?.color || '#ea580c', lang === 'fr' ? ' : ' : ': ');
    await sendMail({ to: p.email, subject: t.subject, html, text, fromName: agency });
  }
}

// ---- what the screens show

const median = (l: number[]) => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** The short state for lists and the getting-started steps: how the site deploys, and how many changes are not live. */
export async function liveState(siteId: string) {
  const s = siteAnyState(siteId);
  if (!s) return null;
  const site = await record(s);
  const method = await methodOf(s);
  const waiting = await db.find<Live>('changes', { site_id: siteId, live_watch: 1 });
  return { kind: method?.kind ?? null, host: method?.host ?? method?.workflow ?? null, seenLive: site.seen_live,
    late: waiting.filter(c => c.live === 'late' || c.live === 'failed').length };
}

/** A site's go-live card: what deploys it, how long changes take to show, the last changes, and what a guide needs. */
export async function liveView(siteId: string) {
  const s = siteAnyState(siteId);
  if (!s) return null;
  const site = await record(s);
  const method = await methodOf(s) ?? await redetect(s);
  const recent = (await db.find<Live>('changes', { site_id: siteId, status: 'published' })).filter(c => c.live)
    .sort((a, b) => (b.published || '').localeCompare(a.published || '')).slice(0, 5);
  const ad = s.adapter as any;
  return {
    method, seenLive: site.seen_live, median: median(site.minutes),
    recent: recent.map(c => ({ id: c.id, title: c.title, published: c.published, live: c.live, liveAt: c.live_at ?? null, detail: c.live_detail ?? null, url: c.live_url ?? null,
      minutes: c.live_at ? Math.max(0, Math.round((Date.parse(c.live_at) - Date.parse(c.published!)) / 60_000)) : minutesSince(c.published) })),
    repo: GH.repoOf(s.repo) ? s.repo.replace(/^https:\/\/github\.com\/|\.git$/g, '') : null, branch: s.branch, liveUrl: s.liveUrl,
    build: Array.isArray(ad.build) ? ad.build.join(' ') : null, outDir: ad.outDir ?? null, local: s.previews === 'local' && !s.push,
  };
}

/** A change's go-live state, as its page shows it. */
export function liveOfChange(c: Live) {
  if (!c.live) return null;
  return { state: c.live, at: c.live_at ?? null, detail: c.live_detail ?? null, url: c.live_url ?? null, checked: c.live_checked ?? null };
}

/** A site removed: what was found about its deploys goes with it. */
export async function dropLive(siteId: string) {
  await db.remove('golive', siteId);
}

