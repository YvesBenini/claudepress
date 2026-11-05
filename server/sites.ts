// Sites, their content and their previews. Two ways to preview and publish:
//   claudepress  ClaudePress builds the preview on Google Cloud Build into one preview address per site
//                ("staging"), only when someone asks for it; publishing commits to the site's branch on GitHub.
//   github       each change is a pull request; the site's own pipeline builds its preview and, once merged, deploys it.
//   In both, ClaudePress keeps no checkout: it reads the content files through the GitHub API.
//   local   ClaudePress clones the repository and builds previews itself:
//           workspaces/<site>/base          clone of the site's repo = what is published
//           workspaces/<site>/previews/<id> copy of base with one change applied, built for its preview
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, now } from './db.ts';
import { blocksJson, type BlocksJsonConfig } from './adapters/blocks-json.ts';
import { markdown, type MarkdownConfig } from './adapters/markdown.ts';
import type { Content, MediaFile, Op, SiteAdapter } from './adapters/types.ts';
import * as GH from './github.ts';
import { fileOpsOnLatest } from './repofiles.ts';
import { buildProgress, deletePreview, previewBuildStatus, startPreviewBuild, type BuildSteps } from './cloudbuild.ts';

const exec = promisify(execFile);
const WORK = path.resolve(process.env.CLAUDEPRESS_WORKSPACES || 'workspaces');

/** A website as the admin screen describes it (stored in the `sites` table). */
export interface SiteConfig {
  id: string;
  orgId: string | null;              // the account that owns the site
  name: string;
  liveUrl: string;
  repo: string;                       // git URL (or a local path, for development)
  branch: string;
  previews: 'claudepress' | 'github' | 'local';
  cacheDirs: string[];                // claudepress previews: build caches kept between builds (e.g. resized images)
  push: boolean;                      // local previews: publishing pushes to the repo, whose own pipeline deploys the site
  seedCache: string[];                // build caches copied from a local repo (first build is faster)
  adapter: BlocksJsonConfig | MarkdownConfig;
}

export { config } from './config.ts';
import { config } from './config.ts';

export type SiteStatus = 'setting_up' | 'ready' | 'error';

export interface Site extends SiteConfig {
  adapter_: SiteAdapter;
  base: string;
  content: Content;                   // content of base, kept in memory
  baseOut: string;
  lock: Promise<unknown>;
  status: SiteStatus;
  error: string | null;
  headSha: string | null;             // github: the commit the content was read from
  texts: Record<string, string | null>;   // github: the content files at headSha, as they are
  blobs: Map<string, string>;         // github: texts already read, by blob sha (only changed files are read again)
  staging: { change: string | null; build: string | null };   // claudepress: what the site's preview address shows
  lastBuild: BuildSteps | null;                                // claudepress: how long each step took last time, for the progress bar
  shareToken: string | null;          // claudepress: link to the preview address for people without an account
  checked: number;                    // github: when the branch head was last looked at
}

const sites = new Map<string, Site>();

export function site(id: string): Site {
  const s = sites.get(id);
  if (!s) throw new Error(`Site inconnu : ${id}`);
  if (s.status !== 'ready') throw new Error(`Le site ${s.name} n’est pas prêt (${s.status === 'error' ? 'erreur de connexion' : 'installation en cours'}).`);
  return s;
}
export const siteAnyState = (id: string) => sites.get(id);
export const allSites = () => [...sites.values()];

function makeAdapter(cfg: SiteConfig): SiteAdapter {
  if (cfg.adapter.type === 'blocks-json') return blocksJson(cfg.adapter);
  if (cfg.adapter.type === 'markdown') return markdown(cfg.adapter);
  throw new Error(`Type de contenu inconnu : ${(cfg.adapter as any).type}`);
}

/** Copy a folder cheaply: APFS clones on macOS, reflinks on Linux, a plain copy otherwise. */
async function cloneDir(src: string, dst: string) {
  for (const args of [['-cR', src, dst], ['-R', '--reflink=auto', src, dst], ['-R', src, dst]]) {
    try { await exec('cp', args); return; } catch { fs.rmSync(dst, { recursive: true, force: true }); }
  }
  throw new Error(`Copie impossible : ${src}`);
}

const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd, maxBuffer: 20 << 20 }).then(r => r.stdout.trim());

function rowToConfig(r: any): SiteConfig {
  return { id: r.id, orgId: r.org_id, name: r.name, liveUrl: r.live_url, repo: r.repo, branch: r.branch, push: !!r.push, previews: (['claudepress', 'github'].includes(r.previews) ? r.previews : 'local') as SiteConfig['previews'], cacheDirs: JSON.parse(r.cache_dirs || '[]'),
           seedCache: JSON.parse(r.seed_cache || '[]'), adapter: JSON.parse(r.adapter) };
}

export async function saveSite(cfg: SiteConfig) {
  const cur = await db.get('sites', cfg.id);
  await db.set('sites', cfg.id, {
    ...(cur?.scan ? { scan: cur.scan } : {}),   // the import scan and its site map outlive a change of settings
    org_id: cfg.orgId, name: cfg.name, live_url: cfg.liveUrl, repo: cfg.repo, branch: cfg.branch, adapter: JSON.stringify(cfg.adapter),
    push: cfg.push ? 1 : 0, previews: cfg.previews, cache_dirs: JSON.stringify(cfg.cacheDirs || []), seed_cache: JSON.stringify(cfg.seedCache), status: cur?.status || 'setting_up', error: cur?.error ?? null, created: cur?.created || now(),
  });
}

/** Clones (first time), loads and builds one site. Never throws: problems end up in the site's status. */
export async function setupSite(cfg: SiteConfig) {
  const base = path.join(WORK, cfg.id, 'base');
  const s: Site = { ...cfg, adapter_: makeAdapter(cfg), base, content: null, baseOut: '', lock: Promise.resolve(), status: 'setting_up', error: null, headSha: null, checked: 0, texts: {}, blobs: new Map(),
                    staging: { change: null, build: null }, lastBuild: null, shareToken: null };
  const saved = await db.get('sites', cfg.id);
  if (saved) { s.staging = { change: saved.staging_change ?? null, build: saved.staging_build ?? null }; s.shareToken = saved.share_token ?? null; s.lastBuild = saved.last_build_steps ?? null; }
  sites.set(cfg.id, s);
  await db.update('sites', cfg.id, { status: 'setting_up', error: null });
  if (cfg.previews !== 'local') {
    try {
      const repo = GH.repoOf(cfg.repo) ?? (() => { throw new Error('Ce mode demande un dépôt github.com.'); })();
      await readFromGitHub(s, repo, await GH.headSha(repo, cfg.branch));
      s.status = 'ready';
      console.log(`[${cfg.id}] ready (GitHub ${repo.owner}/${repo.name}@${s.headSha!.slice(0, 7)})`);
    } catch (e) {
      s.status = 'error';
      s.error = String((e as Error).message).slice(0, 2000);
      console.error(`[${cfg.id}] ${s.error}`);
    }
    await db.update('sites', cfg.id, { status: s.status, error: s.error });
    return s;
  }
  try {
    if (config.githubOnly) throw new Error('Ce serveur ne construit pas les sites lui-même : choisissez « Aperçus par GitHub » dans les réglages du site.');
    if (!fs.existsSync(path.join(base, '.git'))) {
      fs.rmSync(base, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(base), { recursive: true });
      console.log(`[${cfg.id}] cloning ${cfg.repo}`);
      await exec('git', ['clone', '--quiet', '--branch', cfg.branch, cfg.repo, base], { timeout: 10 * 60e3 });
      for (const rel of cfg.seedCache) {
        const from = path.join(cfg.repo, rel);
        if (fs.existsSync(from) && !fs.existsSync(path.join(base, rel))) {
          fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
          await cloneDir(from, path.join(base, rel));
        }
      }
    } else {
      await git(base, 'remote', 'set-url', 'origin', cfg.repo);
      // with "publish pushes" off, publishes stay in this checkout: it cannot follow the repository any more
      if (cfg.push) await sync(base, cfg.branch);
    }
    s.content = s.adapter_.load(base);
    const b = await s.adapter_.build(base);
    s.baseOut = b.outDir;
    if (!b.ok) throw new Error('La construction du site a échoué : ' + b.log.trim().split('\n').slice(-6).join('\n'));
    s.status = 'ready';
    console.log(`[${cfg.id}] ready: ${b.log.trim().split('\n').pop()}`);
  } catch (e) {
    s.status = 'error';
    s.error = String((e as any).stderr || (e as Error).message).slice(0, 2000);
    console.error(`[${cfg.id}] ${s.error}`);
  }
  await db.update('sites', cfg.id, { status: s.status, error: s.error });
  return s;
}

/** Forgets a site: its checkout and previews are deleted; the repository and the live site are not touched. */
export async function removeSite(id: string) {
  sites.delete(id);
  await db.remove('sites', id);
  for (const m of await db.find('members', { site_id: id })) await db.remove('members', m.id);
  fs.rmSync(path.join(WORK, id), { recursive: true, force: true });
}

/** Brings the checkout up to date with the repository (work pushed by the agency, other publishes). */
async function sync(base: string, branch: string) {
  try {
    await git(base, 'fetch', '--quiet', 'origin', branch);
    await git(base, 'merge', '--ff-only', '--quiet', `origin/${branch}`);
  } catch (e) {
    throw new Error(`Impossible de mettre à jour depuis le dépôt (${branch}) : ${String((e as any).stderr || (e as Error).message).trim()}`);
  }
}

// ------------------------------------------------------------------ GitHub mode

const repoOfSite = (s: Site) => GH.repoOf(s.repo)!;
const previewBranch = (changeId: string) => `claudepress/${changeId}`;

async function readFromGitHub(s: Site, repo: GH.Repo, sha: string) {
  const { files: tree } = await GH.listTree(repo, sha);
  const blobOf = new Map(tree.map(f => [f.path, f.sha]));
  const wanted = s.adapter_.textFiles(tree.map(f => f.path));
  const texts: Record<string, string | null> = {};
  const blobs = new Map<string, string>();
  const queue = [...wanted];
  // a few at a time: a site of Markdown pages can have hundreds of files
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let f; (f = queue.shift()) !== undefined;) {
      const b = blobOf.get(f);
      texts[f] = !b ? null : s.blobs.get(b) ?? await GH.readFile(repo, f, sha);
      if (b && texts[f] != null) blobs.set(b, texts[f]!);
    }
  }));
  s.content = s.adapter_.parse(p => texts[p] ?? null, wanted);
  s.texts = texts;
  s.blobs = blobs;
  s.headSha = sha;
  s.checked = Date.now();
}

/** Follows the repository: work pushed by the agency, merged changes. Checks at most every `maxAge` ms. */
export async function freshen(s: Site, maxAge = 30_000) {
  if (s.previews === 'local' || Date.now() - s.checked < maxAge) return;
  const repo = repoOfSite(s);
  const sha = await GH.headSha(repo, s.branch);
  s.checked = Date.now();
  if (sha !== s.headSha) await readFromGitHub(s, repo, sha);
}

/** The files a change writes: content texts, the photos it adds, and whole files changed with full edits. */
async function changeFiles(s: Site, content: Content, ops: Op[]) {
  const files: Record<string, string | Buffer | null> = { ...s.adapter_.render(content, p => s.texts[p] ?? null) };
  if (ops.some(o => o.kind === 'file')) {
    const f = await fileOpsOnLatest(s, ops);
    if (f.errors.length) throw new Error('Le site a changé entre-temps : ' + f.errors.join(' ; '));
    Object.assign(files, f.files);
  }
  for (const m of mediaOf(ops)) {
    const data = await db.getFile(`uploads/${path.basename(m.upload)}`);
    if (!data) throw new Error(`Photo introuvable : ${m.upload}`);
    files[s.adapter_.mediaRepoPath(m.path)] = data;
  }
  return files;
}

/** The change applied on the latest version of the site: its files, or why it no longer applies. */
async function changeOnLatest(s: Site, ops: Op[]) {
  await freshen(s, 0);
  const content = structuredClone(s.content);
  const errors = applyAll(s, content, ops);
  if (errors.length) throw new Error('Le site a changé entre-temps : ' + errors.join(' ; '));
  return { content, files: await changeFiles(s, content, ops) };
}

const authorOf = async (userId: string) => {
  const u = await db.get('users', userId);
  return { name: u?.name || 'ClaudePress', email: u?.email || 'noreply@claudepress.org' };
};

/** Sends the change to its branch, then asks for its preview: the site's pipeline (github) or Cloud Build (claudepress). */
async function pushPreview(s: Site, changeId: string) {
  const row = await db.get('changes', changeId);
  if (!row) return;
  const ops: Op[] = JSON.parse(row.ops);
  await db.update('changes', changeId, { preview: 'building', preview_url: null, preview_started: new Date().toISOString(), preview_log: null, preview_checked: null, preview_progress: { pct: 1, step: 'sending' },
    // the previous build is forgotten first: until the new one has an id, nothing can be taken for ready
    preview_sha: null, preview_build: null, preview_folder: null });
  try {
    const { files } = await changeOnLatest(s, ops);
    const repo = repoOfSite(s);
    const title = row.title || 'Modification proposée';
    const sha = await GH.commitFiles(repo, { baseSha: s.headSha!, branch: previewBranch(changeId), files,
      message: `${title}\n\nProposed in ClaudePress.\nClaudePress-Change: ${changeId}`, author: await authorOf(row.author_id) });
    if (s.previews === 'github') {
      const pr = await GH.ensurePullRequest(repo, { head: previewBranch(changeId), base: s.branch, title: `ClaudePress : ${title}`,
        body: `Changement proposé dans ClaudePress.\n\nNe pas fusionner à la main : la publication se fait depuis ClaudePress (validation comprise).` });
      await db.update('changes', changeId, { preview_sha: sha, pr_number: pr });
    } else {
      const buildId = `${changeId}-${Date.now().toString(36)}`;
      const a = s.adapter as any;
      const build = await startPreviewBuild({ siteId: s.id, buildId, owner: repo.owner, repo: repo.name, branch: previewBranch(changeId),
        privateRepo: await GH.isPrivate(repo), token: await GH.cloneToken(repo), command: a.build, outDir: a.outDir, cacheDirs: s.cacheDirs, env: a.buildEnv });
      await db.update('changes', changeId, { preview_sha: sha, preview_build: build, preview_folder: buildId });
    }
  } catch (e) {
    await db.update('changes', changeId, { preview: 'failed', preview_log: String((e as Error).message).slice(0, 1000) });
  }
}

/** Is the preview of a change ready? Asks GitHub or Cloud Build, at most every 5 seconds per change. */
export async function checkPreview(changeId: string) {
  const c = await db.get('changes', changeId);
  if (!c || c.preview !== 'building' || !c.preview_sha) return c;
  if (c.preview_checked && Date.now() - Date.parse(c.preview_checked) < 5000) return c;
  const s = sites.get(c.site_id);
  if (!s || s.previews === 'local') return c;
  const patch: any = { preview_checked: new Date().toISOString() };
  if (s.previews === 'claudepress') {
    if (!c.preview_build) return c;
    const b = await previewBuildStatus(c.preview_build);
    if (b.state === 'running') patch.preview_progress = { pct: buildProgress(b.steps, b.step, s.lastBuild), step: b.step ?? 'queued' };
    if (b.state === 'ready') {
      // the site's preview address now shows this change; the previous one is removed
      const old = s.staging.build;
      s.staging = { change: changeId, build: c.preview_folder };
      s.lastBuild = b.steps;
      await db.update('sites', s.id, { staging_change: changeId, staging_build: c.preview_folder, last_build_steps: b.steps });
      if (old && old !== c.preview_folder) await deletePreview(s.id, old);
      Object.assign(patch, { preview: 'ready', preview_progress: null });
    }
    if (b.state === 'failed') Object.assign(patch, { preview: 'failed', preview_log: `La construction de l’aperçu a échoué : ${b.detail}` });
  } else {
    const p = await GH.previewOf(repoOfSite(s), c.preview_sha);
    // the address comes from the site's pipeline: only a public https address is ever opened by the server
    const safe = (u?: string) => { try { const x = new URL(u!); return x.protocol === 'https:' && !/^(localhost|[\d.]+|\[.*\]|.*\.internal|metadata\.google\.internal)$/i.test(x.hostname); } catch { return false; } };
    if (p.state === 'ready' && !safe(p.url)) Object.assign(patch, { preview: 'failed', preview_log: `Adresse d’aperçu refusée : ${p.url}` });
    else if (p.state === 'ready') Object.assign(patch, { preview: 'ready', preview_url: p.url!.replace(/\/$/, '') });
    if (p.state === 'failed') Object.assign(patch, { preview: 'failed', preview_log: `La construction de l’aperçu a échoué sur GitHub : ${p.detail}` });
  }
  await db.update('changes', changeId, patch);
  return { ...c, ...patch };
}

/** The preview address of a site: a token for people without an account (created once, can be renewed). */
export async function shareToken(siteId: string, renew = false) {
  const s = sites.get(siteId)!;
  if (!s.shareToken || renew) {
    s.shareToken = (await import('node:crypto')).randomBytes(18).toString('base64url');
    await db.update('sites', siteId, { share_token: s.shareToken });
  }
  return s.shareToken;
}
export const siteByShareToken = (token: string) => [...sites.values()].find(s => s.shareToken && s.shareToken === token) ?? null;

export async function initSites() {
  // sites described in the config file are imported once; after that the admin screen manages them
  for (const c of config.sites || []) {
    if (await db.get('sites', c.id)) continue;
    const [org] = (await db.find('orgs')).sort((a, b) => String(a.created).localeCompare(String(b.created)));
    await saveSite({ branch: 'main', push: false, seedCache: [], orgId: org?.id ?? null, ...c } as SiteConfig);
  }
  const rows = (await db.find('sites')).sort((a, b) => a.name.localeCompare(b.name));
  await Promise.all(rows.map(r => setupSite(rowToConfig(r))));
}

/** Local mode: the whole files of full edits, written into a checkout. Returns their paths. */
function writeFileOps(dir: string, ops: Op[]) {
  const last = new Map<string, string>();
  for (const o of ops) if (o.kind === 'file') last.set(o.path, o.after);
  for (const [p, text] of last) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  return [...last.keys()];
}

function mediaOf(ops: Op[]) {
  const media: MediaFile[] = [];
  for (const op of ops) {
    if (op.kind === 'set' && op.media) media.push(op.media);
    if (op.kind === 'create_post' && op.post.cover?.media) media.push(op.post.cover.media);
  }
  return media;
}

async function copyMedia(s: Site, dir: string, ops: Op[]) {
  const media = mediaOf(ops);
  for (const m of media) {
    const dst = s.adapter_.mediaFile(dir, m.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const data = await db.getFile(`uploads/${path.basename(m.upload)}`);
    if (!data) throw new Error(`Photo introuvable : ${m.upload}`);
    fs.writeFileSync(dst, data);
  }
  return media;
}

/** Applies ops to a copy of the content; returns the errors of the ops that no longer apply. */
export function applyAll(s: Site, content: Content, ops: Op[]) {
  const errors: string[] = [];
  for (const op of ops) {
    try { s.adapter_.apply(content, op); } catch (e) { errors.push((e as Error).message); }
  }
  return errors;
}

export const previewDir = (siteId: string, changeId: string) => path.join(WORK, siteId, 'previews', changeId);

const building = new Map<string, { running: Promise<void>; again: boolean }>();

/** Builds the preview of a change. Calls made while a build runs collapse into one more build. */
export function buildPreview(siteId: string, changeId: string): Promise<void> {
  const cur = building.get(changeId);
  if (cur) { cur.again = true; return cur.running; }
  const state = { running: Promise.resolve(), again: false };
  state.running = (async () => {
    do {
      state.again = false;
      const s = sites.get(siteId);
      if (s && s.previews !== 'local') await pushPreview(s, changeId);
      else await buildOnce(siteId, changeId);
    } while (state.again);
    building.delete(changeId);
  })();
  building.set(changeId, state);
  return state.running;
}

async function buildOnce(siteId: string, changeId: string) {
  const s = site(siteId);
  const row = await db.get('changes', changeId);
  if (!row) return;
  const ops: Op[] = JSON.parse(row.ops);
  await db.update('changes', changeId, { preview: 'building' });
  const dir = previewDir(siteId, changeId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await cloneDir(s.base, dir);
    const content = structuredClone(s.content);
    const errors = applyAll(s, content, ops);
    await copyMedia(s, dir, ops);
    s.adapter_.save(dir, content);
    writeFileOps(dir, ops);
    const b = await s.adapter_.build(dir);
    const log = [...errors, b.log.trim().split('\n').slice(-12).join('\n')].join('\n');
    await db.update('changes', changeId, { preview: b.ok ? 'ready' : 'failed', preview_log: log });
  } catch (e) {
    await db.update('changes', changeId, { preview: 'failed', preview_log: String((e as Error).message) });
  }
}

/** Removes a change's preview: its build folder, its pull request and branch, its pages on the preview address. */
export async function dropPreview(siteId: string, changeId: string, prNumber?: number | null) {
  fs.rmSync(previewDir(siteId, changeId), { recursive: true, force: true });
  const s = sites.get(siteId);
  if (!s || s.previews === 'local') return;
  if (prNumber) await GH.closePullRequest(repoOfSite(s), prNumber, previewBranch(changeId)).catch(() => {});
  else await GH.deleteBranch(repoOfSite(s), previewBranch(changeId)).catch(() => {});
  if (s.staging.change === changeId) {
    if (s.staging.build) await deletePreview(s.id, s.staging.build);
    s.staging = { change: null, build: null };
    await db.update('sites', s.id, { staging_change: null, staging_build: null });
  }
}

/** Publishes a change: catch up with the repository, apply, commit, build, then push (the site's pipeline deploys it). */
export function publish(siteId: string, changeId: string, title: string, author: { name: string; email: string }) {
  const s = site(siteId);
  const job = s.lock.then(async () => {
    if (s.previews === 'github') return publishOnGitHub(s, changeId, title, author);
    if (s.previews === 'claudepress') return publishDirect(s, changeId, title, author);
    const ops: Op[] = JSON.parse((await db.get('changes', changeId))!.ops);
    if (s.push) { await sync(s.base, s.branch); s.content = s.adapter_.load(s.base); }
    const content = structuredClone(s.content);
    const errors = applyAll(s, content, ops);
    if (errors.length) throw new Error('Le site a changé entre-temps : ' + errors.join(' ; '));
    await copyMedia(s, s.base, ops);
    s.adapter_.save(s.base, content);
    const code = writeFileOps(s.base, ops);
    // folders that do not exist yet (no photo added so far) cannot be named to git
    await git(s.base, 'add', '--', ...s.adapter_.contentFiles.filter(f => fs.existsSync(path.join(s.base, f))), ...code);
    const msg = `${title}\n\nPublished from ClaudePress by ${author.name}.\nClaudePress-Change: ${changeId}`;
    await git(s.base, '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '--quiet', '-m', msg);
    const full = await git(s.base, 'rev-parse', 'HEAD'), sha = full.slice(0, 7);
    s.content = content;
    const b = await s.adapter_.build(s.base);
    if (!b.ok) throw new Error('La construction du site a échoué : ' + b.log.slice(-400));
    const steps: string[] = [];
    if (s.push) {
      try {
        await git(s.base, 'push', '--quiet', 'origin', `HEAD:${s.branch}`);
      } catch (e) {
        // leave the checkout as the repository is, so the next publish starts clean
        await git(s.base, 'reset', '--hard', '--quiet', `origin/${s.branch}`);
        s.content = s.adapter_.load(s.base);
        throw new Error('L’envoi vers le dépôt a échoué, rien n’a été publié : ' + String((e as any).stderr || (e as Error).message).trim());
      }
      steps.push('pushed');
    }
    return { sha, full, steps };
  });
  s.lock = job.catch(() => {});
  return job;
}

/** GitHub mode: the change is rebuilt on the latest content, its pull request merged; the site's pipeline deploys it. */
async function publishOnGitHub(s: Site, changeId: string, title: string, author: { name: string; email: string }) {
  const c = (await db.get('changes', changeId))!;
  const ops: Op[] = JSON.parse(c.ops);
  const { files } = await changeOnLatest(s, ops);
  const repo = repoOfSite(s);
  if (!Object.keys(files).length) throw new Error('Rien à publier : le site contient déjà ces changements.');
  const message = `Published from ClaudePress by ${author.name}.\nClaudePress-Change: ${changeId}`;
  // the branch must sit on the latest version of the site, so the merge cannot conflict; when the preview already
  // does (and shows these same changes), it is merged as it is, without a new build
  const upToDate = c.preview_sha && c.preview === 'ready' && await GH.parentOf(repo, c.preview_sha) === s.headSha;
  if (!upToDate) await GH.commitFiles(repo, { baseSha: s.headSha!, branch: previewBranch(changeId), files, message: `${title}\n\n${message}`, author });
  const pr = c.pr_number || await GH.ensurePullRequest(repo, { head: previewBranch(changeId), base: s.branch, title: `ClaudePress : ${title}`, body: message });
  const sha = await GH.mergePullRequest(repo, pr, title, message);
  await GH.deleteBranch(repo, previewBranch(changeId));
  await readFromGitHub(s, repo, sha);
  return { sha: sha.slice(0, 7), full: sha, steps: ['merged'] };
}

/** claudepress mode: one commit on the site's branch, on its latest version; the site's host deploys it. */
async function publishDirect(s: Site, changeId: string, title: string, author: { name: string; email: string }) {
  const c = (await db.get('changes', changeId))!;
  const ops: Op[] = JSON.parse(c.ops);
  const repo = repoOfSite(s);
  for (let attempt = 0; ; attempt++) {
    const { files } = await changeOnLatest(s, ops);
    if (!Object.keys(files).length) throw new Error('Rien à publier : le site contient déjà ces changements.');
    try {
      const sha = await GH.commitFiles(repo, { baseSha: s.headSha!, branch: s.branch, files, author, force: false,
        message: `${title}\n\nPublished from ClaudePress by ${author.name}.\nClaudePress-Change: ${changeId}` });
      await readFromGitHub(s, repo, sha);
      await dropPreview(s.id, changeId);
      return { sha: sha.slice(0, 7), full: sha, steps: ['committed'] };
    } catch (e) {
      // someone else published in between: start again from their version
      if (!(e instanceof GH.GitHubError) || e.status !== 422 || attempt >= 2) throw e;
      s.checked = 0;
    }
  }
}

