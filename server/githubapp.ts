// The ClaudePress GitHub App: how any administrator connects their repositories.
//   1. The person running the server creates the app once, from ClaudePress, with GitHub's manifest flow: GitHub
//      hands the app's keys straight back to the server, which stores them encrypted (nobody copies a key).
//   2. Each account installs the app on its GitHub account or organisation and picks the repositories it allows.
//   3. ClaudePress works with installation tokens: one hour, limited to those repositories.
import crypto from 'node:crypto';
import { db, newId, now } from './db.ts';
import { decrypt, encrypt } from './billing.ts';
import { config } from './config.ts';

const API = 'https://api.github.com';
const DOC = ['platform', 'github_app'] as const;

export interface AppInfo { id: number; slug: string; clientId: string; owner: string; htmlUrl: string }

async function appRecord() {
  return db.get(DOC[0], DOC[1]);
}

export async function appInfo(): Promise<AppInfo | null> {
  const r = await appRecord();
  return r ? { id: r.app_id, slug: r.slug, clientId: r.client_id, owner: r.owner, htmlUrl: r.html_url } : null;
}

/** What GitHub needs to create the app (manifest flow). */
export function manifest(publicUrl: string, name: string) {
  return {
    name, url: 'https://claudepress.org', public: true,
    description: 'Edit your website by asking, with previews and approval. Powered by Claude.',
    redirect_url: `${publicUrl}/api/github/app-created`,
    callback_urls: [`${publicUrl}/api/github/installed`],
    setup_url: `${publicUrl}/api/github/installed`,
    request_oauth_on_install: true,       // proves who installed it, so an installation can only join their own account
    setup_on_update: true,
    hook_attributes: { url: `${publicUrl}/api/github/hook`, active: false },
    default_permissions: { contents: 'write', pull_requests: 'write', statuses: 'read', checks: 'read', deployments: 'read', metadata: 'read' },
    default_events: [],
  };
}

const states = new Map<string, { orgId: string; at: number }>();
export function newState(orgId: string) {
  const s = newId(24);
  states.set(s, { orgId, at: Date.now() });
  return s;
}
export function takeState(s: string) {
  const v = states.get(s);
  states.delete(s);
  return v && Date.now() - v.at < 30 * 60e3 ? v : null;
}

/** Finishes the manifest flow: GitHub returns the new app's keys, stored encrypted. */
export async function saveCreatedApp(code: string) {
  const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub n’a pas créé l’application (${res.status}).`);
  const a: any = await res.json();
  await db.set(DOC[0], DOC[1], {
    app_id: a.id, slug: a.slug, client_id: a.client_id, owner: a.owner?.login || '', html_url: a.html_url,
    client_secret_enc: encrypt(a.client_secret), pem_enc: encrypt(a.pem), webhook_secret_enc: a.webhook_secret ? encrypt(a.webhook_secret) : null,
    created: now(),
  });
  return appInfo();
}

/** A short JWT that identifies the app itself (10 minutes at most). */
async function appJwt() {
  const r = (await appRecord()) ?? (() => { throw new Error('L’application GitHub de ClaudePress n’est pas encore créée.'); })();
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: t - 60, exp: t + 540, iss: String(r.app_id) })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), decrypt(r.pem_enc)).toString('base64url')}`;
}

async function asApp(method: string, path: string) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${await appJwt()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
  if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path} : ${res.status}`), { status: res.status });
  return res.json();
}

const tokens = new Map<number, { token: string; until: number }>();
/** An installation token (valid one hour), renewed a few minutes before it expires. */
export async function installationToken(installationId: number) {
  const c = tokens.get(installationId);
  if (c && c.until - Date.now() > 5 * 60e3) return c.token;
  const t = await asApp('POST', `/app/installations/${installationId}/access_tokens`);
  tokens.set(installationId, { token: t.token, until: Date.parse(t.expires_at) });
  return t.token as string;
}

const repoInstallations = new Map<string, number>();
/** The installation that gives access to a repository, or null when the app is not installed there. */
export async function installationOf(owner: string, name: string) {
  const key = `${owner}/${name}`.toLowerCase();
  if (repoInstallations.has(key)) return repoInstallations.get(key)!;
  try {
    const i = await asApp('GET', `/repos/${owner}/${name}/installation`);
    repoInstallations.set(key, i.id);
    return i.id as number;
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Finishes an installation: GitHub sends back who installed it (OAuth code). The installation joins the account
 * only if that person can really see it, so nobody can attach somebody else's repositories.
 */
export async function confirmInstallation(orgId: string, installationId: number, code: string) {
  const r = (await appRecord())!;
  const tok = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: r.client_id, client_secret: decrypt(r.client_secret_enc), code }),
  }).then(x => x.json());
  if (!tok.access_token) throw new Error('GitHub n’a pas confirmé l’installation. Réessayez.');
  const mine = await fetch(`${API}/user/installations?per_page=100`, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json' } }).then(x => x.json());
  const inst = (mine.installations || []).find((i: any) => i.id === installationId);
  if (!inst) throw new Error('Cette installation GitHub ne vous appartient pas.');
  const org = await db.get('orgs', orgId);
  const list = (org?.github_installations || []).filter((i: any) => i.id !== installationId);
  list.push({ id: installationId, account: inst.account.login, type: inst.account.type });
  await db.update('orgs', orgId, { github_installations: list });
  return inst.account.login as string;
}

/** Repositories an account has allowed, through all its installations. */
export async function repositoriesOf(orgId: string) {
  const org = await db.get('orgs', orgId);
  const out: { fullName: string; private: boolean; installation: number }[] = [];
  for (const i of org?.github_installations || []) {
    try {
      const token = await installationToken(i.id);
      for (let page = 1; page < 10; page++) {
        const r: any = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } }).then(x => x.json());
        for (const repo of r.repositories || []) out.push({ fullName: repo.full_name, private: repo.private, installation: i.id });
        if (!r.repositories || r.repositories.length < 100) break;
      }
    } catch { /* uninstalled since: skipped */ }
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export const installUrl = async (state: string) => {
  const a = await appInfo();
  return a ? `https://github.com/apps/${a.slug}/installations/new?state=${state}` : null;
};

export const appName = () => (config.agencyName && config.agencyName !== 'ClaudePress' ? `ClaudePress ${config.agencyName}` : 'ClaudePress');
