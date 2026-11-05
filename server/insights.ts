// A site's figures for its people: visits (Google Analytics 4) and Google searches (Search Console).
//   1. Each account gives ClaudePress read access to its clients' figures, one of two ways:
//      - "Connect Google" (config.google.clientId/clientSecret): an administrator signs in with a Google account that
//        reaches the properties (usually the agency's). Google hands back a refresh token, kept encrypted and sealed to
//        the account.
//      - "Add ClaudePress as a viewer" (config.google.viewer): the account gets a Google address of its own (a service
//        account) that the agency or the client adds as a viewer in Analytics and as a user in Search Console. Each
//        account has its own address, so no account can pick another's properties. A server with one agency can use
//        one shared address instead (viewer.shared: the service account the server runs as).
//   2. For each site, the administrator picks its Analytics property and its Search Console property, and whether the
//      site's clients see the figures.
//   3. Figures are fetched on demand and kept 6 hours, so a busy site home does not call Google on every visit.
// The Google Cloud project needs the Analytics Admin, Analytics Data and Search Console APIs enabled; "Connect Google"
// also needs <public address>/api/google/connected as an authorised redirect of its OAuth client, and per-account
// addresses need the server's own credentials to hold Service Account Admin and Service Account Token Creator there.
import { GoogleAuth } from 'google-auth-library';
import { db, newId, now } from './db.ts';
import { decrypt, encrypt, orgOf } from './billing.ts';
import { config } from './config.ts';

const READ = ['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/webmasters.readonly'];
const SCOPES = ['openid', 'email', ...READ];
const FRESH_MS = 6 * 3600e3;
export const PERIODS = [7, 28, 90];

export const googleOn = () => !!config.google?.clientId && !!config.google?.clientSecret;
export const viewerOn = () => !!config.google?.viewer;
const context = (orgId: string) => `org:${orgId}:google`;
type Mode = 'oauth' | 'viewer';
/** How an account reaches its figures (accounts connected before the viewer address existed have no mode: Google sign-in). */
const modeOf = (org: any): Mode | null => org?.google_mode ?? (org?.google_enc ? 'oauth' : null);

/** What a site shows: its Analytics property, its Search Console property, and whether its clients see them. */
export interface InsightSettings { ga4: string | null; ga4Name: string | null; gsc: string | null; clients: boolean }

export async function settingsOf(siteId: string): Promise<InsightSettings> {
  const s = await db.get<any>('insight_settings', siteId);
  return { ga4: s?.ga4 || null, ga4Name: s?.ga4Name || null, gsc: s?.gsc || null, clients: s?.clients !== false };
}

export async function saveSettings(siteId: string, patch: Partial<InsightSettings>) {
  const cur = await settingsOf(siteId);
  patch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));   // what was not sent stays as it is
  if (patch.ga4 !== undefined && patch.ga4 !== null && !/^properties\/\d+$/.test(patch.ga4)) throw new Error('Propriété Analytics inconnue.');
  if (patch.gsc !== undefined && patch.gsc !== null && !/^(sc-domain:[\w.-]+|https?:\/\/\S+)$/.test(patch.gsc)) throw new Error('Propriété Search Console inconnue.');
  const next = { ...cur, ...patch, clients: patch.clients === undefined ? cur.clients : !!patch.clients };
  await db.set('insight_settings', siteId, next);
  // other properties, other figures
  if (next.ga4 !== cur.ga4 || next.gsc !== cur.gsc) for (const d of PERIODS) await db.remove('insights', `${siteId}:${d}`);
  return next;
}

// ---- connecting Google

const states = new Map<string, { orgId: string; userId: string; at: number }>();

export function connectUrl(orgId: string, userId: string, redirectUri: string) {
  const state = newId(24);
  states.set(state, { orgId, userId, at: Date.now() });
  const q = new URLSearchParams({ client_id: config.google!.clientId!, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Google sends the browser back with a code: the refresh token is kept, sealed to the account that asked for it. */
export async function finishConnect(orgId: string, userId: string, state: string, code: string, redirectUri: string) {
  const st = states.get(state);
  states.delete(state);
  if (!st || st.orgId !== orgId || st.userId !== userId || Date.now() - st.at > 30 * 60e3) throw new Error('state');
  const t = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
  if (!t.refresh_token) throw new Error('Google did not return a refresh token');
  const granted = String(t.scope || '').split(' ');
  // the id token comes straight from Google's token endpoint over TLS, so its payload can be read without checking the signature
  const email = t.id_token ? JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString('utf8')).email : null;
  await db.update('orgs', orgId, {
    google_mode: 'oauth', google_enc: encrypt(t.refresh_token, context(orgId)), google_email: email || null, google_connected: now(), google_error: null,
    google_scopes: { analytics: granted.includes(SCOPES[2]), searchConsole: granted.includes(SCOPES[3]) },
  });
  tokens.set(orgId, { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 });
}

export async function disconnect(orgId: string) {
  const org: any = await orgOf(orgId);
  if (org?.google_enc) {
    const token = decrypt(org.google_enc, context(orgId));
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
  tokens.delete(orgId);
  // the viewer address is kept (google_viewer): turned on again, it is the same one, already added at Google
  await db.update('orgs', orgId, { google_mode: null, google_enc: null, google_email: null, google_connected: null, google_error: null, google_scopes: null });
}

// ---- the account's own Google address ("add ClaudePress as a viewer")

const cloud = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const shared = new GoogleAuth({ scopes: READ });

async function cloudCall(url: string, body: unknown) {
  const r = await fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${await cloud.getAccessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error?.message || `Google Cloud ${r.status}`), { status: r.status });
  return data;
}

/**
 * Turns on the viewer address for the account and returns it: its own service account (created once, kept afterwards),
 * or the server's shared one, which only a server with a single account may use.
 */
export async function useViewer(orgId: string) {
  const v = config.google?.viewer ?? (() => { throw new Error('L’adresse ClaudePress n’est pas configurée sur ce serveur.'); })();
  const org: any = await orgOf(orgId);
  let email: string = org?.google_viewer;
  if ('shared' in v) {
    if (await db.count('orgs') > 1) throw new Error('Ce serveur a plusieurs comptes : une adresse partagée leur montrerait les statistiques des uns et des autres.');
    email = (await shared.getCredentials()).client_email ?? (() => { throw new Error('Le serveur ne tourne pas avec un compte de service Google.'); })();
  } else if (!email) {
    const accountId = `cp-${orgId}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
    email = `${accountId}@${v.project}.iam.gserviceaccount.com`;
    await cloudCall(`https://iam.googleapis.com/v1/projects/${v.project}/serviceAccounts`, {
      accountId, serviceAccount: { displayName: `ClaudePress ${String(org?.name || orgId).slice(0, 80)}`, description: `Reads the site figures of ClaudePress account ${orgId}` },
    }).catch(e => { if (e.status !== 409) throw e; });   // 409: it exists already
  }
  if (org?.google_enc) await disconnect(orgId);   // one way at a time
  tokens.delete(orgId);
  await db.update('orgs', orgId, { google_mode: 'viewer', google_viewer: email, google_connected: now(), google_error: null });
  return email;
}

/** A one-hour token of the account's viewer address: the server acts as it, no key is ever stored. */
async function viewerToken(email: string) {
  if (config.google?.viewer && 'shared' in config.google.viewer) {
    const t = await shared.getAccessToken();
    return { token: t!, until: Date.now() + 50 * 60e3 };
  }
  const t = await cloudCall(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`,
    { scope: READ, lifetime: '3600s' });
  return { token: t.accessToken as string, until: Date.parse(t.expireTime) - 60e3 };
}

/** The account's connection as the administration shows it. */
export async function connectionOf(orgId: string) {
  const org: any = await orgOf(orgId);
  const mode = modeOf(org);
  return { available: googleOn(), viewerAvailable: viewerOn(), mode, connected: !!mode, email: org?.google_email || null,
    viewerEmail: mode === 'viewer' ? org.google_viewer : null, error: org?.google_error || null, scopes: org?.google_scopes || null };
}

async function tokenCall(params: Record<string, string>) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google!.clientId!, client_secret: config.google!.clientSecret!, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(t.error_description || t.error || `Google ${r.status}`), { code: t.error });
  return t;
}

const tokens = new Map<string, { token: string; until: number }>();

/**
 * A one-hour access token: the viewer address's, or one from the account's refresh token, where a refused refresh
 * token (access removed at Google) is noted.
 */
async function accessToken(orgId: string) {
  const cached = tokens.get(orgId);
  if (cached && cached.until > Date.now()) return cached.token;
  const org: any = await orgOf(orgId);
  const mode = modeOf(org);
  if (mode === 'viewer') {
    const t = await viewerToken(org.google_viewer);
    tokens.set(orgId, t);
    return t.token;
  }
  if (mode !== 'oauth' || !org.google_enc) throw new NotConnected();
  try {
    const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: decrypt(org.google_enc, context(orgId)) });
    tokens.set(orgId, { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 });
    if (org.google_error) await db.update('orgs', orgId, { google_error: null });
    return t.access_token as string;
  } catch (e: any) {
    if (e.code === 'invalid_grant') { await db.update('orgs', orgId, { google_error: 'revoked' }); throw new NotConnected(); }
    throw e;
  }
}

export class NotConnected extends Error { constructor() { super('Google n’est pas connecté pour ce compte.'); } }

async function google(orgId: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${await accessToken(orgId)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error?.message || `Google ${r.status}`), { status: r.status });
  return data;
}

/** What the connected Google account reaches, for the administrator to pick from. */
export async function propertiesOf(orgId: string) {
  const [ga, sc] = await Promise.allSettled([
    google(orgId, 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200'),
    google(orgId, 'https://www.googleapis.com/webmasters/v3/sites'),
  ]);
  if ([ga, sc].some(r => r.status === 'rejected' && r.reason instanceof NotConnected)) throw new NotConnected();
  return {
    analytics: ga.status === 'fulfilled' ? (ga.value.accountSummaries || []).flatMap((a: any) => (a.propertySummaries || [])
      .map((p: any) => ({ id: p.property, name: p.displayName, account: a.displayName }))) : null,
    searchConsole: sc.status === 'fulfilled' ? (sc.value.siteEntry || []).filter((s: any) => s.permissionLevel !== 'siteUnverifiedUser')
      .map((s: any) => ({ id: s.siteUrl, name: s.siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\/|\/$/g, '') })) : null,
    errors: [ga, sc].map(r => r.status === 'rejected' ? (r.reason as Error).message : null),
  };
}

// ---- figures

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
/** The period ending `lag` days ago, and the one just before it, to compare. */
function periods(days: number, lag: number) {
  return { current: { startDate: day(daysAgo(lag + days - 1)), endDate: day(daysAgo(lag)) },
           previous: { startDate: day(daysAgo(lag + 2 * days - 1)), endDate: day(daysAgo(lag + days)) } };
}
const n = (v: unknown) => Number(v) || 0;

async function analytics(orgId: string, property: string, days: number) {
  const p = periods(days, 1);   // up to yesterday: today is still filling up
  const url = `https://analyticsdata.googleapis.com/v1beta/${property}:batchRunReports`;
  const top = (dimension: string, metric: string, limit: number) => ({ dateRanges: [p.current], dimensions: [{ name: dimension }], metrics: [{ name: metric }],
    orderBys: [{ metric: { metricName: metric }, desc: true }], limit });
  const [a, b] = await Promise.all([
    google(orgId, url, { requests: [
      { dateRanges: [p.current, p.previous], metrics: ['activeUsers', 'sessions', 'screenPageViews', 'engagementRate', 'averageSessionDuration'].map(name => ({ name })) },
      { dateRanges: [p.current], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 },
      top('pagePath', 'screenPageViews', 10),
      top('sessionDefaultChannelGroup', 'sessions', 8),
      top('deviceCategory', 'activeUsers', 5),
    ] }),
    google(orgId, url, { requests: [top('city', 'activeUsers', 8)] }),
  ]);
  const [totals, daily, pages, channels, devices] = a.reports;
  const range = (r: string) => (totals.rows || []).find((x: any) => x.dimensionValues?.[0]?.value === r)?.metricValues?.map((m: any) => n(m.value)) || [0, 0, 0, 0, 0];
  const sum = (v: number[]) => ({ users: v[0], sessions: v[1], views: v[2], engagement: v[3], duration: v[4] });
  const rows = (r: any) => (r.rows || []).map((x: any) => ({ label: x.dimensionValues[0].value, value: n(x.metricValues[0].value) }));
  const byDay = new Map<string, number>((daily.rows || []).map((x: any) => [x.dimensionValues[0].value, n(x.metricValues[0].value)]));
  return {
    range: p.current, current: sum(range('date_range_0')), previous: sum(range('date_range_1')),
    // every day of the period, also those without a visit
    daily: Array.from({ length: days }, (_, i) => { const d = day(daysAgo(1 + days - 1 - i)); return { date: d, value: byDay.get(d.replace(/-/g, '')) || 0 }; }),
    pages: rows(pages), channels: rows(channels), devices: rows(devices),
    cities: rows(b.reports[0]).filter((c: any) => c.label !== '(not set)'),
  };
}

async function searchConsole(orgId: string, siteUrl: string, days: number) {
  const p = periods(days, 3);   // Search Console needs two or three days to settle
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const q = (range: { startDate: string; endDate: string }, dimensions: string[] = [], rowLimit = 10) => google(orgId, url, { ...range, dimensions, rowLimit });
  const [cur, prev, daily, queries, pages] = await Promise.all([q(p.current), q(p.previous), q(p.current, ['date'], days), q(p.current, ['query']), q(p.current, ['page'])]);
  const sum = (r: any) => { const x = r.rows?.[0] || {}; return { clicks: n(x.clicks), impressions: n(x.impressions), ctr: n(x.ctr), position: n(x.position) }; };
  const rows = (r: any) => (r.rows || []).map((x: any) => ({ label: x.keys[0], clicks: n(x.clicks), impressions: n(x.impressions), position: n(x.position) }));
  const byDay = new Map<string, number>((daily.rows || []).map((x: any) => [x.keys[0], n(x.clicks)]));
  return {
    range: p.current, current: sum(cur), previous: sum(prev),
    daily: Array.from({ length: days }, (_, i) => { const d = day(daysAgo(3 + days - 1 - i)); return { date: d, value: byDay.get(d) || 0 }; }),
    queries: rows(queries), pages: rows(pages),
  };
}

/** Plain words for what went wrong at Google, for the people who read the page. */
function problem(e: any) {
  if (e instanceof NotConnected) return 'not_connected';
  if (e.status === 403) return 'no_access';
  return 'unavailable';
}

/**
 * A site's figures over `days`, kept 6 hours. Each source stands alone: one failing leaves the other on screen, and a
 * failure keeps showing the last figures fetched, with their date.
 */
export async function insightsOf(siteId: string, orgId: string, days: number, refresh = false) {
  const s = await settingsOf(siteId);
  const key = `${siteId}:${days}`;
  const kept = await db.get<any>('insights', key);
  if (kept && !refresh && Date.now() - Date.parse(kept.at) < FRESH_MS && kept.ga4 === s.ga4 && kept.gsc === s.gsc) return kept.data;
  const [ga, sc] = await Promise.allSettled([
    s.ga4 ? analytics(orgId, s.ga4, days) : Promise.resolve(null),
    s.gsc ? searchConsole(orgId, s.gsc, days) : Promise.resolve(null),
  ]);
  for (const r of [ga, sc]) if (r.status === 'rejected') console.error(`[insights ${siteId}] ${(r.reason as Error).message}`);
  const data = {
    at: now(), days,
    analytics: ga.status === 'fulfilled' ? ga.value : kept?.data?.analytics ? { ...kept.data.analytics, stale: kept.data.analytics.stale || kept.at } : null,
    analyticsError: ga.status === 'rejected' ? problem(ga.reason) : null,
    search: sc.status === 'fulfilled' ? sc.value : kept?.data?.search ? { ...kept.data.search, stale: kept.data.search.stale || kept.at } : null,
    searchError: sc.status === 'rejected' ? problem(sc.reason) : null,
  };
  if (ga.status === 'fulfilled' || sc.status === 'fulfilled') await db.set('insights', key, { site_id: siteId, at: data.at, ga4: s.ga4, gsc: s.gsc, data });
  return data;
}
