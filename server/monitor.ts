// Uptime monitoring of the sites' live addresses. Every minute each monitored site is fetched; when it fails twice in a
// row an incident opens and the account's administrators are told, by e-mail and in the app, and so are the site's
// clients whose access has uptime alerts on (Administration → the site → Clients). A site that goes down shortly
// after a publish names that change, so it can be undone at once. The certificate's expiry is watched as well.
// On a hosted service every account has one site monitored for free (the one its administrators choose, by default its
// first by name); the add-on (config `monitoring.price`, or plans with `"monitoring": true`) monitors all of them.
// A self-hosted server monitors every site. Checks run on a timer, and on POST /api/monitor/tick for servers that sleep between
// requests (Cloud Scheduler, every minute): both only check what is due, so an extra tick costs nothing.
//
// Collections:
//   monitors     id = site  site_id, org_id, state ('up' | 'down' | null), failures, since, checked, status, ms, error,
//                           incident, paused, ssl_expires, ssl_checked, ssl_alerted
//   incidents    site_id, org_id, started, resolved, reason, change_id, change_title, minutes
//   uptime_days  id "<site>:<YYYY-MM-DD>"  site_id, org_id, day, checks, ok, ms (the sum, for the average)
//   uptime_hours id "<site>:<YYYY-MM-DDTHH>" the same per hour, kept 8 days: the last 24 hours and the response times
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { config } from './config.ts';
import { db, newId, notify, now, type ChangeRow } from './db.ts';
import { allSites, siteAnyState, type Site } from './sites.ts';
import { brandOf, monitoringOn, orgOf } from './billing.ts';
import { hosted } from './extension.ts';
import { layout, mailOn, sendMail } from './mail.ts';

const EVERY = 60_000;            // one check a minute per site
const FAILS = 2;                 // failures in a row before an incident opens
const SUSPECT_HOURS = 2;         // a publish this recent is named as the likely cause
const SSL_DAYS = 14;             // warn when the certificate expires within this many days, once a week
const SAVE_EVERY = 10 * 60_000;  // a site whose state did not change is written down this often
const KEEP_DAYS = 90;
const KEEP_HOURS_DAYS = 8;
const UA = 'ClaudePress-Monitor/1.0 (+https://claudepress.org)';

const origin = () => (config.publicUrl || `http://${config.host || 'localhost'}:${process.env.PORT || config.port || 4400}`).replace(/\/$/, '');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- fetching a site's address. A hosted server never reaches private addresses (its own network, the cloud's
// metadata server): the check is made on the address each connection really uses, so redirects and DNS tricks are covered.
// A self-hosted server may monitor an intranet site (and so may a test server, with CLAUDEPRESS_MONITOR_PRIVATE=1).

const blocked = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) blocked.addSubnet(a, bits, 'ipv6');

const privateOk = () => !hosted() || process.env.CLAUDEPRESS_MONITOR_PRIVATE === '1';
function isPrivate(ip: string) {
  const a = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
  return blocked.check(a, net.isIPv6(a) ? 'ipv6' : 'ipv4');
}
const refused = () => Object.assign(new Error('private address'), { code: 'PRIVATE_ADDRESS' });

function lookup(host: string, o: dns.LookupOptions, cb: (e: NodeJS.ErrnoException | null, a?: string | dns.LookupAddress[], f?: number) => void) {
  dns.lookup(host, { all: true, family: o.family }, (e, addrs) => {
    if (e) return cb(e);
    if (!privateOk() && addrs.some(a => isPrivate(a.address))) return cb(refused());
    if (o.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
  });
}
const literalOk = (host: string) => { const h = host.replace(/^\[|\]$/g, ''); return privateOk() || !net.isIP(h) || !isPrivate(h); };

/** One request, headers only: the status and where it redirects. */
function once(u: URL, deadline: number): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'GET', lookup: lookup as any, headers: { 'user-agent': UA, accept: 'text/html,*/*' } }, res => {
      res.destroy();
      resolve({ status: res.statusCode || 0, location: res.headers.location });
    });
    const t = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), Math.max(1, deadline - Date.now()));
    req.on('close', () => clearTimeout(t));
    req.on('error', reject);
    req.end();
  });
}

// what people read in alerts: the cause in plain words
const CAUSES: [RegExp, string][] = [
  [/ENOTFOUND|EAI_AGAIN/, 'adresse introuvable (DNS)'], [/ECONNREFUSED/, 'connexion refusée'], [/TIMEOUT|ETIMEDOUT/, 'pas de réponse en 15 secondes'],
  [/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/, 'certificat SSL invalide'], [/ECONNRESET|EPIPE|socket hang up/, 'connexion coupée'],
  [/PRIVATE_ADDRESS/, 'adresse privée, non surveillée'],
];
const cause = (e: any) => CAUSES.find(([re]) => re.test(`${e?.code} ${e?.message}`))?.[1] ?? 'erreur de connexion';

interface Probe { ok: boolean; status: number | null; ms: number | null; error: string | null }

/** Fetches the address, following up to 5 redirects. A site behind a bot shield (401, 403, 429) still answers: it is up. */
export async function probe(url: string, timeout = 15_000): Promise<Probe> {
  const start = performance.now(), deadline = Date.now() + timeout;
  try {
    let u = new URL(url);
    for (let hop = 0; ; hop++) {
      if (!/^https?:$/.test(u.protocol) || !literalOk(u.hostname)) throw refused();
      const r = await once(u, deadline);
      if (r.status >= 300 && r.status < 400 && r.location && hop < 5) { u = new URL(r.location, u); continue; }
      const ok = r.status < 400 || [401, 403, 429].includes(r.status);
      return { ok, status: r.status, ms: Math.round(performance.now() - start), error: ok ? null : `erreur ${r.status}` };
    }
  } catch (e) { return { ok: false, status: null, ms: null, error: cause(e) }; }
}

/** One request, read to the end (at most `max` bytes, 3 MB by default), past caches: what a page shows right now. */
function read(u: URL, deadline: number, max = 3 << 20): Promise<{ status: number; location?: string; html: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'GET', lookup: lookup as any,
      headers: { 'user-agent': UA, accept: 'text/html,*/*', 'cache-control': 'no-cache', pragma: 'no-cache' } }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) { res.destroy(); return resolve({ status, location: res.headers.location, html: '', headers: res.headers }); }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > max) res.destroy(); else chunks.push(c); });
      res.on('close', () => resolve({ status, html: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    const t = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), Math.max(1, deadline - Date.now()));
    req.on('close', () => clearTimeout(t));
    req.on('error', reject);
    req.end();
  });
}

/** A page of a site with what it holds, following redirects; status null when it could not be reached (server/golive.ts). */
export async function fetchPage(url: string, timeout = 15_000): Promise<{ status: number | null; html: string }> {
  const deadline = Date.now() + timeout;
  try {
    let u = new URL(url);
    for (let hop = 0; ; hop++) {
      if (!/^https?:$/.test(u.protocol) || !literalOk(u.hostname)) throw refused();
      const r = await read(u, deadline);
      if (r.location && hop < 5) { u = new URL(r.location, u); continue; }
      return { status: r.status, html: r.html };
    }
  } catch { return { status: null, html: '' }; }
}

/**
 * An address with its response headers (server/security.ts), following redirects unless `follow` is false; null when
 * it could not be reached. `url` is where it ended, `location` where it redirects when it was not followed.
 */
export async function fetchWithHeaders(url: string, o: { follow?: boolean; timeout?: number; max?: number } = {}) {
  const deadline = Date.now() + (o.timeout ?? 15_000);
  try {
    let u = new URL(url);
    for (let hop = 0; ; hop++) {
      if (!/^https?:$/.test(u.protocol) || !literalOk(u.hostname)) throw refused();
      const r = await read(u, deadline, o.max);
      if (r.location && o.follow !== false && hop < 5) { u = new URL(r.location, u); continue; }
      return { status: r.status, headers: r.headers, body: r.html, url: u.toString(), location: r.location ? new URL(r.location, u).toString() : null };
    }
  } catch { return null; }
}

/** When the site's certificate expires, or null when it could not be read. */
function certExpiry(host: string): Promise<Date | null> {
  return new Promise(resolve => {
    if (!literalOk(host)) return resolve(null);
    const sock = tls.connect({ host, port: 443, servername: net.isIP(host) ? undefined : host, timeout: 10_000, lookup: lookup as any }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve(c?.valid_to ? new Date(c.valid_to) : null);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

// ---- state: kept in memory, written down when it changes (or every few minutes), so a site that stays up costs
// a few writes an hour, not one a minute

export interface Monitor {
  id: string; site_id: string; org_id: string | null; state: 'up' | 'down' | null; failures: number; since: string | null;
  checked: string | null; status: number | null; ms: number | null; error: string | null; incident: string | null;
  paused: boolean; ssl_expires: string | null; ssl_checked: string | null; ssl_alerted: string | null;
}

const states = new Map<string, Monitor>();
const savedAt = new Map<string, number>();

async function stateOf(s: Site): Promise<Monitor> {
  let m = states.get(s.id);
  if (!m) {
    m = { id: s.id, site_id: s.id, org_id: s.orgId ?? null, state: null, failures: 0, since: null, checked: null, status: null, ms: null, error: null,
      incident: null, paused: false, ssl_expires: null, ssl_checked: null, ssl_alerted: null, ...(await db.get<Monitor>('monitors', s.id)) };
    states.set(s.id, m);
  }
  return m;
}

async function save(m: Monitor, force = false) {
  if (!force && Date.now() - (savedAt.get(m.id) ?? 0) < SAVE_EVERY) return;
  savedAt.set(m.id, Date.now());
  await db.set('monitors', m.id, { ...m });
}

// each day's and each hour's checks, added up in memory and written every few minutes
type Totals = { checks: number; ok: number; ms: number };
const totals = { uptime_days: new Map<string, { base: Record<string, unknown>; add: Totals }>(), uptime_hours: new Map<string, { base: Record<string, unknown>; add: Totals }>() };
function count(m: Monitor, p: Probe) {
  const at = now();
  for (const [col, key, field] of [['uptime_days', at.slice(0, 10), 'day'], ['uptime_hours', at.slice(0, 13), 'hour']] as const) {
    const id = `${m.site_id}:${key}`;
    const t = totals[col].get(id) ?? { base: { site_id: m.site_id, org_id: m.org_id, [field]: key }, add: { checks: 0, ok: 0, ms: 0 } };
    t.add.checks++; if (p.ok) { t.add.ok++; t.add.ms += p.ms ?? 0; }
    totals[col].set(id, t);
  }
}
let daysSaved = Date.now();
async function saveDays(force = false) {
  if (!force && Date.now() - daysSaved < SAVE_EVERY) return;
  daysSaved = Date.now();
  for (const [col, map] of Object.entries(totals)) {
    const all = [...map]; map.clear();
    for (const [id, t] of all) await db.increment(col, id, t.base, t.add);
  }
}

// which of an account's sites are monitored: all of them with the add-on, else the one it chose (by default its first by
// name), free; looked up again every two minutes, or at once when the account changes it
const covers = new Map<string, { all: boolean; site: string | null; at: number }>();
const siteList = (orgId: string) => allSites().filter(s => s.orgId === orgId && /^https?:\/\//.test(s.liveUrl || '')).sort((a, b) => a.name.localeCompare(b.name));
async function coverage(orgId: string | null | undefined) {
  if (!orgId) return { all: !hosted(), site: null };
  const c = covers.get(orgId);
  if (c && Date.now() - c.at < 120_000) return c;
  const org = await orgOf(orgId), sites = siteList(orgId);
  const v = { all: monitoringOn(org), site: sites.find(s => s.id === org?.monitor_site)?.id ?? sites[0]?.id ?? null, at: Date.now() };
  covers.set(orgId, v);
  return v;
}
const watched = async (s: Site) => { const c = await coverage(s.orgId); return c.all || c.site === s.id; };
export const forgetAccount = (orgId: string) => covers.delete(orgId);

/** What an account's monitoring covers: every site, or one (free) and which. */
export async function monitorCoverage(orgId: string) {
  const c = await coverage(orgId);
  const site = c.site ? siteAnyState(c.site) : null;
  return { all: c.all, freeSite: !c.all && site ? { id: site.id, name: site.name } : null };
}

// ---- checking

async function checkOne(s: Site, m: Monitor) {
  let p = await probe(s.liveUrl);
  if (!p.ok) { await sleep(5_000); p = await probe(s.liveUrl); }   // a blip is not an incident
  count(m, p);
  const before = { state: m.state, failures: m.failures };
  Object.assign(m, { checked: now(), status: p.status, ms: p.ms, error: p.error, org_id: s.orgId ?? null });
  if (p.ok) {
    if (m.state !== 'up') { if (m.state === 'down') await recovered(s, m); m.state = 'up'; m.since = now(); }
    m.failures = 0;
  } else {
    m.failures++;
    if (m.failures >= FAILS && m.state !== 'down') await wentDown(s, m, p);
  }
  await certificate(s, m);
  await save(m, before.state !== m.state || before.failures !== m.failures);
}

async function wentDown(s: Site, m: Monitor, p: Probe) {
  const started = new Date(Date.now() - (FAILS - 1) * EVERY).toISOString();
  // the last change published shortly before: the likely cause, to undo in one click
  const recent = (await db.find<ChangeRow & { published?: string }>('changes', { site_id: s.id, status: 'published' }))
    .filter(c => c.published && Date.parse(c.published) > Date.now() - SUSPECT_HOURS * 3600_000)
    .sort((a, b) => b.published!.localeCompare(a.published!))[0];
  const id = newId(14);
  await db.set('incidents', id, { site_id: s.id, org_id: s.orgId ?? null, started, resolved: null, reason: p.error,
    change_id: recent?.id ?? null, change_title: recent?.title ?? null, minutes: null });
  Object.assign(m, { state: 'down', since: started, incident: id });
  await alert(s, 'down', { reason: p.error || '', change: recent ? { id: recent.id, title: recent.title, after: Math.max(0, Math.round((Date.parse(started) - Date.parse(recent.published!)) / 60_000)) } : null });
}

async function recovered(s: Site, m: Monitor) {
  const minutes = m.since ? Math.max(1, Math.round((Date.now() - Date.parse(m.since)) / 60_000)) : null;
  if (m.incident) await db.update('incidents', m.incident, { resolved: now(), minutes });
  m.incident = null;
  await alert(s, 'up', { minutes });
}

async function certificate(s: Site, m: Monitor) {
  const u = new URL(s.liveUrl);
  if (u.protocol !== 'https:' || (m.ssl_checked && Date.now() - Date.parse(m.ssl_checked) < 6 * 3600_000)) return;
  const expires = await certExpiry(u.hostname);
  if (!expires) return;   // tried again at the next check
  Object.assign(m, { ssl_expires: expires.toISOString(), ssl_checked: now() });
  const days = Math.floor((expires.getTime() - Date.now()) / 86_400_000);
  if (days <= SSL_DAYS && (!m.ssl_alerted || Date.now() - Date.parse(m.ssl_alerted) > 7 * 86_400_000)) {
    m.ssl_alerted = now();
    await alert(s, 'ssl', { days, expires });
  }
  await save(m, true);
}

/** Checks every monitored site that is due. Never two at once: a tick that comes during a run returns straight away. */
let running: Promise<number> | null = null;
export function tick() {
  return running ??= (async () => {
    try {
      const due: [Site, Monitor][] = [];
      for (const s of allSites()) {
        if (!/^https?:\/\//.test(s.liveUrl || '') || !(await watched(s))) continue;
        const m = await stateOf(s);
        if (!m.paused && (!m.checked || Date.now() - Date.parse(m.checked) >= EVERY - 5_000)) due.push([s, m]);
      }
      // ten at a time: a few slow sites do not hold the others up
      const queue = [...due];
      await Promise.all(Array.from({ length: 10 }, async () => {
        for (let x = queue.shift(); x; x = queue.shift()) await checkOne(...x).catch(e => console.error(`[monitor] ${x![0].id}:`, e));
      }));
      await saveDays();
      await prune();
      return due.length;
    } finally { running = null; }
  })();
}

let pruned = 0;
async function prune() {
  if (Date.now() - pruned < 86_400_000) return;
  pruned = Date.now();
  const oldest = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const d of await db.find('uptime_days')) if (d.day < oldest) await db.remove('uptime_days', d.id);
  const oldestHour = new Date(Date.now() - KEEP_HOURS_DAYS * 86_400_000).toISOString().slice(0, 13);
  for (const h of await db.find('uptime_hours')) if (h.hour < oldestHour) await db.remove('uptime_hours', h.id);
}

/** Starts the minute timer; on a server that sleeps between requests, the ticks wake it up. */
export function startMonitor() {
  const run = () => tick().catch(e => console.error('[monitor]', e));
  // every 15 seconds: only what is due is checked, so each site keeps close to its minute whatever the timer's phase
  setTimeout(run, 10_000);
  setInterval(run, 15_000);
  const stop = async () => { await saveDays(true); for (const m of states.values()) await save(m, true); process.exit(0); };
  process.once('SIGTERM', stop);
}

// ---- alerts: the administrators get the cause; the site's clients with alerts on, a calm word

type Alert = { kind: 'down'; reason: string; change: { id: string; title: string; after: number } | null }
  | { kind: 'up'; minutes: number | null } | { kind: 'ssl'; days: number; expires: Date };
type Lang = 'fr' | 'en';

const duration = (min: number | null, lang: Lang) => {
  if (!min) return lang === 'fr' ? 'quelques minutes' : 'a few minutes';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return h < 48 ? `${h} h${r ? ` ${r} min` : ''}` : (lang === 'fr' ? `${Math.round(h / 24)} jours` : `${Math.round(h / 24)} days`);
};
const day = (d: Date, lang: Lang) => d.toLocaleDateString(lang === 'fr' ? 'fr-BE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** The notice in the app (French, translated by the interface) and the e-mail, for administrators or for clients. */
function texts(a: Alert, site: string, agency: string, forClients: boolean, lang: Lang) {
  const fr = lang === 'fr';
  if (a.kind === 'down' && forClients) return {
    notice: `Votre site ${site} ne répond plus. ${agency} est prévenu et s’en occupe.`,
    subject: fr ? `Votre site ${site} ne répond plus` : `Your website ${site} is not responding`,
    body: [fr ? `Votre site ${site} ne répond plus depuis quelques minutes.` : `Your website ${site} has not been responding for a few minutes.`,
      fr ? `${agency} est prévenu et s’en occupe. Vous recevrez un message dès qu’il sera de nouveau en ligne.` : `${agency} has been told and is on it. You will get a message as soon as it is back online.`],
  };
  if (a.kind === 'down') {
    const c = a.change;
    return {
      notice: `${site} ne répond plus (${a.reason}).${c ? ` Cela a commencé ${c.after} min après la publication de « ${c.title} » : ouvrez-la pour l’annuler.` : ''}`,
      subject: fr ? `🔴 ${site} ne répond plus` : `🔴 ${site} is down`,
      body: [fr ? `${site} ne répond plus depuis 2 minutes : ${a.reason}.` : `${site} has not been responding for 2 minutes: ${a.reason}.`,
        ...(c ? [fr ? `Cela a commencé ${c.after} min après la publication de « ${c.title} ». Si ce changement en est la cause, annulez-le en un clic.`
          : `It started ${c.after} min after “${c.title}” was published. If that change is the cause, undo it in one click.`] : []),
        fr ? 'Vous recevrez un message dès que le site répondra de nouveau.' : 'You will get a message as soon as the site responds again.'],
      button: c ? { label: fr ? 'Voir le changement et l’annuler' : 'See the change and undo it', path: `#/change/${c.id}` } : undefined,
    };
  }
  if (a.kind === 'up') return {
    notice: forClients ? `Votre site ${site} est de nouveau en ligne.` : `${site} répond de nouveau, après ${duration(a.minutes, 'fr')} d’interruption.`,
    subject: fr ? `🟢 ${site} est de nouveau en ligne` : `🟢 ${site} is back online`,
    body: [forClients ? (fr ? `Votre site ${site} est de nouveau en ligne.` : `Your website ${site} is back online.`)
      : (fr ? `${site} répond de nouveau, après ${duration(a.minutes, lang)} d’interruption.` : `${site} responds again, after ${duration(a.minutes, lang)} of downtime.`)],
  };
  return {
    notice: `Le certificat SSL de ${site} expire dans ${a.days} jour(s). Sans renouvellement, les visiteurs verront une alerte de sécurité.`,
    subject: fr ? `🟠 Le certificat SSL de ${site} expire bientôt` : `🟠 The SSL certificate of ${site} expires soon`,
    body: [fr ? `Le certificat SSL de ${site} expire le ${day(a.expires, lang)}, dans ${a.days} jour(s).` : `The SSL certificate of ${site} expires on ${day(a.expires, lang)}, in ${a.days} day(s).`,
      fr ? 'Sans renouvellement, les visiteurs verront une alerte de sécurité à la place du site. La plupart des hébergeurs le renouvellent seuls : vérifiez que c’est bien le cas.'
        : 'Without a renewal, visitors will see a security warning instead of the site. Most hosts renew it on their own: check that this one does.'],
  };
}

const alertedClients = async (siteId: string) =>
  (await Promise.all((await db.find('members', { site_id: siteId })).filter(x => x.alerts).map(x => db.get('users', x.user_id)))).filter(u => u?.active).map(u => u!);

async function alert(s: Site, kind: Alert['kind'], info: any) {
  const a = { kind, ...info } as Alert;
  const org = await orgOf(s.orgId);
  const brand = brandOf(org);
  const agency = brand?.name || org?.name || config.agencyName || 'ClaudePress';
  const admins = s.orgId ? await db.find('users', { agency: 1, active: 1, org_id: s.orgId }) : await db.find('users', { agency: 1, active: 1 });
  // the clients whose access to the site has uptime alerts on; the certificate is the agency's business
  const clients = kind !== 'ssl' ? (await alertedClients(s.id)).filter(u => !admins.some(a => a.id === u.id)) : [];
  for (const [people, forClients] of [[admins, false], [clients, true]] as const) {
    if (!people.length) continue;
    const change = a.kind === 'down' && !forClients ? a.change?.id ?? null : null;
    await notify(people.map(p => p!.id), change, texts(a, s.name, agency, forClients, 'fr').notice, `#/site/${s.id}`);
    if (!mailOn()) continue;
    for (const p of people) {
      const lang: Lang = p!.lang === 'en' ? 'en' : 'fr';
      const t = texts(a, s.name, agency, forClients, lang);
      const button = t.button ? { label: t.button.label, url: `${origin()}/${t.button.path}` }
        : forClients ? { label: lang === 'fr' ? 'Voir mon site' : 'See my website', url: s.liveUrl }
        : { label: lang === 'fr' ? 'Ouvrir le site dans ClaudePress' : 'Open the site in ClaudePress', url: `${origin()}/#/admin/site/${s.id}` };
      const { html, text } = layout(t.body, button, [lang === 'fr' ? `Surveillance de ${s.liveUrl.replace(/^https?:\/\/|\/$/g, '')}, chaque minute.` : `Monitoring ${s.liveUrl.replace(/^https?:\/\/|\/$/g, '')}, every minute.`], brand?.color || '#ea580c', lang === 'fr' ? ' : ' : ': ');
      await sendMail({ to: p!.email, subject: t.subject, html, text, fromName: agency });
    }
  }
}

// ---- what the screens show

const percent = (ok: number, checks: number) => checks ? Math.floor(ok / checks * 10000) / 100 : null;

/** A site's totals for each day (YYYY-MM-DD) or hour (YYYY-MM-DDTHH) asked, the stored ones plus those not written yet. */
async function series(col: 'uptime_days' | 'uptime_hours', siteId: string, keys: string[]) {
  const field = col === 'uptime_days' ? 'day' : 'hour';
  const stored = new Map((await db.find(col, { site_id: siteId })).map(d => [d[field], d]));
  return keys.map(key => {
    const a = stored.get(key), b = totals[col].get(`${siteId}:${key}`)?.add;
    return { key, checks: (a?.checks || 0) + (b?.checks || 0), ok: (a?.ok || 0) + (b?.ok || 0), ms: (a?.ms || 0) + (b?.ms || 0) };
  });
}
const lastDays = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
const lastHours = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 3_600_000).toISOString().slice(0, 13));
const sum = (list: { checks: number; ok: number }[]) => percent(list.reduce((t, x) => t + x.ok, 0), list.reduce((t, x) => t + x.checks, 0));

/** Outages over the last `ms`: how many, and how many minutes the site was down in that time. */
function downtime(incidents: any[], ms: number) {
  const from = Date.now() - ms;
  const hit = incidents.filter(i => Date.parse(i.resolved || now()) > from);
  const minutes = hit.reduce((t, i) => t + (Date.parse(i.resolved || now()) - Math.max(from, Date.parse(i.started))) / 60_000, 0);
  return { incidents: hit.length, down: Math.round(minutes) };
}

/**
 * A site's monitoring as its page shows it (the way uptime services lay it out): its state and since when, the uptime
 * of the last 24 hours, 7 and 30 days with their outages, 30 daily bars, the last 24 hours' response times, its outages
 * and its certificate. Null when its account has no monitoring.
 */
export async function monitorView(siteId: string) {
  const s = siteAnyState(siteId);
  if (!s || !(await watched(s))) return null;
  const m = await stateOf(s);
  const days = await series('uptime_days', siteId, lastDays(30));
  const hours = await series('uptime_hours', siteId, lastHours(24));
  const all = (await db.find('incidents', { site_id: siteId })).sort((a, b) => b.started.localeCompare(a.started));
  const times = hours.filter(h => h.ok).map(h => Math.round(h.ms / h.ok));
  const ok = hours.reduce((t, h) => t + h.ok, 0), ms = hours.reduce((t, h) => t + h.ms, 0);
  return {
    name: s.name, url: s.liveUrl, every: EVERY / 60_000,
    state: m.paused ? 'paused' : m.state, since: m.since, checked: m.checked, status: m.status, ms: m.ms, error: m.error, paused: m.paused,
    alerted: (await alertedClients(siteId)).map(u => u.name),   // the site's clients told too
    periods: [
      { days: 1, uptime: sum(hours), ...downtime(all, 86_400_000) },
      { days: 7, uptime: sum(days.slice(-7)), ...downtime(all, 7 * 86_400_000) },
      { days: 30, uptime: sum(days), ...downtime(all, 30 * 86_400_000) },
    ],
    days: days.map(d => ({ day: d.key, uptime: percent(d.ok, d.checks) })),
    response: { hours: hours.map(h => ({ hour: `${h.key}:00:00Z`, ms: h.ok ? Math.round(h.ms / h.ok) : null })),
      avg: ok ? Math.round(ms / ok) : null, min: times.length ? Math.min(...times) : null, max: times.length ? Math.max(...times) : null },
    ssl: m.ssl_expires ? { expires: m.ssl_expires, days: Math.floor((Date.parse(m.ssl_expires) - Date.now()) / 86_400_000) } : null,
    incidents: all.slice(0, 10).map(i => ({ started: i.started, resolved: i.resolved, reason: i.reason,
      minutes: i.minutes ?? Math.max(1, Math.round((Date.now() - Date.parse(i.started)) / 60_000)), change: i.change_id ? { id: i.change_id, title: i.change_title } : null })),
  };
}

/** The short state for lists of sites: up, down or paused and since when; null before the first check or without monitoring. */
export async function monitorState(siteId: string) {
  const s = siteAnyState(siteId);
  if (!s || !(await watched(s))) return null;
  const m = await stateOf(s);
  return m.paused || m.state ? { state: m.paused ? 'paused' : m.state, since: m.since } : null;
}

/**
 * Every site of an account in one list, the way an uptime dashboard opens: state, last 24 hours in bars, uptime. Sites
 * the account's monitoring does not cover are listed too, so one can be chosen as the free one, or the add-on bought.
 */
export async function monitorOverview(orgId: string) {
  const c = await coverage(orgId);
  return { ...(await monitorCoverage(orgId)), sites: await Promise.all(siteList(orgId).map(async s => {
    if (!c.all && c.site !== s.id) return { id: s.id, name: s.name, url: s.liveUrl, monitored: false };
    const m = await stateOf(s);
    const hours = await series('uptime_hours', s.id, lastHours(24));
    return {
      id: s.id, name: s.name, url: s.liveUrl, monitored: true, state: m.paused ? 'paused' : m.state, since: m.since, ms: m.ms,
      hours: hours.map(h => ({ hour: `${h.key}:00:00Z`, uptime: percent(h.ok, h.checks) })), uptime24: sum(hours),
      ...downtime(await db.find('incidents', { site_id: s.id }), 86_400_000),
    };
  })) };
}

/** An administrator's settings for one site: pause its monitoring, or make it the account's free one. */
export async function setMonitor(siteId: string, o: { paused?: unknown; free?: unknown }) {
  const s = siteAnyState(siteId)!;
  if (o.free && s.orgId) {
    // the free site moves here: the one before stops being checked, its outage (if any) closed
    const before = (await coverage(s.orgId)).site;
    await db.update('orgs', s.orgId, { monitor_site: siteId });
    forgetAccount(s.orgId);
    const old = before && before !== siteId ? states.get(before) ?? await db.get<Monitor>('monitors', before) : null;
    if (old?.incident) { await db.update('incidents', old.incident, { resolved: now() }); Object.assign(old, { incident: null, state: null }); await save(old as Monitor, true); }
  }
  if (!(await watched(s))) throw new Error('La surveillance gratuite couvre un autre site de ce compte.');
  const m = await stateOf(s);
  if (o.paused !== undefined) Object.assign(m, { paused: !!o.paused, checked: null, failures: 0 });
  if (m.paused && m.incident) { await db.update('incidents', m.incident, { resolved: now() }); Object.assign(m, { incident: null, state: null }); }
  await save(m, true);
  return monitorView(siteId);
}

/** A site removed: its monitoring goes with it. */
export async function dropMonitor(siteId: string) {
  states.delete(siteId);
  await db.remove('monitors', siteId);
}
