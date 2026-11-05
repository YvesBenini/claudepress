// The few GitHub calls ClaudePress needs to propose a change as a pull request, read its preview and merge it.
// Access, per repository: the ClaudePress GitHub App's installation token when the app is installed there;
// otherwise CLAUDEPRESS_GITHUB_TOKEN (or GITHUB_TOKEN), or on a developer machine the GitHub CLI's login.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const API = 'https://api.github.com';

export interface Repo { owner: string; name: string }

/** "https://github.com/owner/name(.git)" → { owner, name }; anything else is not a GitHub repository. */
export function repoOf(url: string): Repo | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

import { appInfo, installationOf, installationToken } from './githubapp.ts';

let cachedToken: string | null = null;
/** The token for a request: the app's installation on that repository first, then the server's own token. */
async function tokenFor(path: string) {
  const m = /^\/repos\/([^/]+)\/([^/?]+)/.exec(path);
  if (m && await appInfo()) {
    const inst = await installationOf(m[1], m[2]);
    if (inst) return installationToken(inst);
  }
  return token();
}

async function token() {
  if (cachedToken) return cachedToken;
  cachedToken = process.env.CLAUDEPRESS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!cachedToken) {
    try { cachedToken = (await exec('gh', ['auth', 'token'])).stdout.trim(); } catch {}
  }
  if (!cachedToken) throw new Error('ClaudePress n’a pas accès à ce dépôt : connectez GitHub dans l’administration et autorisez ce dépôt.');
  return cachedToken;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function gh(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json') {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${await tokenFor(path)}`, accept, 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GitHubError(res.status, `GitHub ${method} ${path} : ${res.status} ${detail.slice(0, 300)}`);
  }
  return accept.includes('raw') ? res.text() : res.json();
}

const r = (repo: Repo) => `/repos/${repo.owner}/${repo.name}`;

export async function isPrivate(repo: Repo): Promise<boolean> {
  return !!(await gh('GET', r(repo))).private;
}

export async function headSha(repo: Repo, branch: string): Promise<string> {
  return (await gh('GET', `${r(repo)}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
}

/** Every file of a commit, with its size (GitHub cuts very large trees: `truncated` then says so). */
export async function listTree(repo: Repo, sha: string): Promise<{ files: { path: string; size: number; sha: string }[]; truncated: boolean }> {
  const t = await gh('GET', `${r(repo)}/git/trees/${sha}?recursive=1`);
  return { files: (t.tree || []).filter((x: any) => x.type === 'blob').map((x: any) => ({ path: x.path, size: x.size || 0, sha: x.sha })), truncated: !!t.truncated };
}

/** A text file at a commit, or null when it does not exist. */
export async function readFile(repo: Repo, filePath: string, ref: string): Promise<string | null> {
  try {
    return await gh('GET', `${r(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`, undefined, 'application/vnd.github.raw+json');
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

/**
 * One commit with the given files on top of `baseSha`, written to `branch` (created, or moved even if that
 * rewrites it: preview branches belong to ClaudePress). Returns the commit's sha.
 */
export async function commitFiles(repo: Repo, o: { baseSha: string; branch: string; message: string; author: { name: string; email: string };
                                                   files: Record<string, string | Buffer | null>; force?: boolean }) {
  const tree = [];
  for (const [p, data] of Object.entries(o.files)) {
    // null deletes the file
    if (data === null) { tree.push({ path: p, mode: '100644', type: 'blob', sha: null }); continue; }
    const blob = typeof data === 'string'
      ? await gh('POST', `${r(repo)}/git/blobs`, { content: data, encoding: 'utf-8' })
      : await gh('POST', `${r(repo)}/git/blobs`, { content: data.toString('base64'), encoding: 'base64' });
    tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const base = await gh('GET', `${r(repo)}/git/commits/${o.baseSha}`);
  const newTree = await gh('POST', `${r(repo)}/git/trees`, { base_tree: base.tree.sha, tree });
  const commit = await gh('POST', `${r(repo)}/git/commits`, {
    message: o.message, tree: newTree.sha, parents: [o.baseSha], author: { ...o.author, date: new Date().toISOString() },
  });
  try {
    await gh('PATCH', `${r(repo)}/git/refs/heads/${encodeURIComponent(o.branch)}`, { sha: commit.sha, force: o.force !== false });
  } catch (e) {
    // 422: the branch does not exist yet (create it), or a non-forced update is not a fast-forward (caller retries)
    if (!(e instanceof GitHubError) || e.status !== 422 || o.force === false) throw e;
    await gh('POST', `${r(repo)}/git/refs`, { ref: `refs/heads/${o.branch}`, sha: commit.sha });
  }
  return commit.sha as string;
}

/** The open pull request of `head`, created when missing. */
export async function ensurePullRequest(repo: Repo, o: { head: string; base: string; title: string; body: string }): Promise<number> {
  const open = await gh('GET', `${r(repo)}/pulls?state=open&head=${repo.owner}:${encodeURIComponent(o.head)}`);
  if (open.length) {
    if (open[0].title !== o.title) await gh('PATCH', `${r(repo)}/pulls/${open[0].number}`, { title: o.title });
    return open[0].number;
  }
  return (await gh('POST', `${r(repo)}/pulls`, o)).number;
}

/**
 * Squash-merges a pull request; returns the commit on the base branch. GitHub needs a moment after a push to
 * know whether a pull request can be merged, so this waits for that answer.
 */
export async function mergePullRequest(repo: Repo, n: number, title: string, message: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const pr = await gh('GET', `${r(repo)}/pulls/${n}`);
    if (pr.merged) return pr.merge_commit_sha;
    if (pr.mergeable === false) throw new Error('GitHub ne peut pas fusionner ce changement (conflit avec le site).');
    if (pr.mergeable === true) {
      try {
        return (await gh('PUT', `${r(repo)}/pulls/${n}/merge`, { merge_method: 'squash', commit_title: title, commit_message: message, sha: pr.head.sha })).sha;
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 405 || attempt >= 10) throw e;
      }
    }
    if (attempt >= 20) throw new Error('GitHub ne répond pas sur la fusion. Réessayez dans un instant.');
    await new Promise(res => setTimeout(res, 1500));
  }
}

/** The first parent of a commit. */
export async function parentOf(repo: Repo, sha: string): Promise<string | null> {
  return (await gh('GET', `${r(repo)}/git/commits/${sha}`)).parents?.[0]?.sha ?? null;
}

export async function closePullRequest(repo: Repo, n: number, branch: string) {
  try { await gh('PATCH', `${r(repo)}/pulls/${n}`, { state: 'closed' }); } catch {}
  await deleteBranch(repo, branch);
}

export async function deleteBranch(repo: Repo, branch: string) {
  try { await gh('DELETE', `${r(repo)}/git/refs/heads/${encodeURIComponent(branch)}`); } catch {}
}

/**
 * Where the site's pipeline is with a commit: its preview address once posted (commit status "preview",
 * or a GitHub deployment), failed when a check failed, pending otherwise.
 */
export async function previewOf(repo: Repo, sha: string): Promise<{ state: 'pending' | 'ready' | 'failed'; url?: string; detail?: string }> {
  const statuses = await gh('GET', `${r(repo)}/commits/${sha}/statuses?per_page=100`);
  const preview = statuses.find((s: any) => s.context === 'preview' && s.state === 'success' && s.target_url);
  if (preview) return { state: 'ready', url: preview.target_url };
  const deployments = await gh('GET', `${r(repo)}/deployments?sha=${sha}&per_page=5`);
  for (const d of deployments) {
    const [st] = await gh('GET', `${r(repo)}/deployments/${d.id}/statuses?per_page=1`);
    if (st?.state === 'success' && (st.environment_url || st.target_url)) return { state: 'ready', url: st.environment_url || st.target_url };
  }
  const runs = await gh('GET', `${r(repo)}/commits/${sha}/check-runs?per_page=50`);
  const failed = runs.check_runs?.find((c: any) => c.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion));
  if (failed) return { state: 'failed', detail: `${failed.name} : ${failed.conclusion} (${failed.html_url})` };
  if (statuses.some((s: any) => s.context === 'preview' && (s.state === 'failure' || s.state === 'error'))) return { state: 'failed', detail: 'preview' };
  return { state: 'pending' };
}

/** What GitHub was told about a commit by whatever builds and deploys it: deployments, commit statuses, check runs. */
export interface Signals {
  deployments: { env: string; by: string; state: string | null; url: string | null }[];
  statuses: { context: string; state: string; url: string | null }[];
  checks: { name: string; app: string; status: string; conclusion: string | null; url: string | null }[];
}

export async function signalsOf(repo: Repo, sha: string): Promise<Signals> {
  const [deployments, statuses, runs] = await Promise.all([
    gh('GET', `${r(repo)}/deployments?sha=${sha}&per_page=5`),
    gh('GET', `${r(repo)}/commits/${sha}/statuses?per_page=50`),
    gh('GET', `${r(repo)}/commits/${sha}/check-runs?per_page=50`),
  ]);
  return {
    deployments: await Promise.all(deployments.map(async (d: any) => {
      const [st] = await gh('GET', `${r(repo)}/deployments/${d.id}/statuses?per_page=1`);
      return { env: d.environment || '', by: `${d.creator?.login || ''} ${d.performed_via_github_app?.slug || ''}`.trim(), state: st?.state ?? null,
        url: st?.environment_url || st?.log_url || st?.target_url || null };
    })),
    // the latest status of each context comes first
    statuses: statuses.filter((s: any, i: number) => statuses.findIndex((x: any) => x.context === s.context) === i)
      .map((s: any) => ({ context: s.context, state: s.state, url: s.target_url || null })),
    checks: (runs.check_runs || []).map((c: any) => ({ name: c.name, app: c.app?.slug || '', status: c.status, conclusion: c.conclusion, url: c.html_url || null })),
  };
}

/** The last commits of a branch, newest first. */
export async function recentCommits(repo: Repo, branch: string, n = 5): Promise<string[]> {
  return (await gh('GET', `${r(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=${n}`)).map((c: any) => c.sha);
}

/** The repository's GitHub Actions workflows at `ref`, with their text. */
export async function workflowsOf(repo: Repo, ref: string): Promise<{ path: string; text: string }[]> {
  let list: any[];
  try { list = await gh('GET', `${r(repo)}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`); }
  catch (e) { if (e instanceof GitHubError && e.status === 404) return []; throw e; }
  const files = list.filter(f => f.type === 'file' && /\.ya?ml$/i.test(f.name)).slice(0, 15);
  return (await Promise.all(files.map(async f => ({ path: f.path as string, text: await readFile(repo, f.path, ref) ?? '' }))));
}

/** The repository's files at `ref` as GitHub archives them (.tar.gz, under one top folder), at most `max` bytes. */
export async function tarball(repo: Repo, ref: string, max = 300 << 20): Promise<Buffer> {
  const path = `${r(repo)}/tarball/${encodeURIComponent(ref)}`;
  // GitHub answers with a short-lived link to its archive server, which fetch follows without the token
  const res = await fetch(API + path, { headers: { authorization: `Bearer ${await tokenFor(path)}`, 'x-github-api-version': '2022-11-28' } });
  if (!res.ok || !res.body) throw new GitHubError(res.status, `GitHub GET ${path} : ${res.status}`);
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of res.body as any as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > max) throw new Error(`Le dépôt dépasse ${Math.round(max / (1 << 20))} Mo compressé.`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/** A token that can clone `repo` for a preview build (an installation token lasts one hour). */
export async function cloneToken(repo: Repo) {
  return tokenFor(`/repos/${repo.owner}/${repo.name}`);
}

