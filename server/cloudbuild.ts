// Previews built by ClaudePress on Google Cloud Build: clone the change's branch, build the site with its own
// command, upload the result to a private bucket. ClaudePress serves it behind sign-in (or a share link).
//   gs://<bucket>/sites/<site>/<build>/…   built pages (deleted after 3 days by the bucket's lifecycle rule)
//   gs://<bucket>/cache/<site>.tgz         the site's build caches, so images are not resized again each time
import { GoogleAuth } from 'google-auth-library';
import { config } from './config.ts';

export interface PreviewBuildConfig {
  project: string;
  region: string;              // where builds run, e.g. europe-west1
  bucket: string;              // private bucket for built previews
  serviceAccount: string;      // e-mail of the account builds run as
  githubTokenSecret: string;   // Secret Manager name of the GitHub token used to clone private repositories
  image?: string;              // build image with Python and Node.js
}

const IMAGE = 'nikolaik/python-nodejs:python3.12-nodejs22';
const SDK = 'gcr.io/google.com/cloudsdktool/cloud-sdk:slim';
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export const previewBuildConfig = (): PreviewBuildConfig | null => (config as any).previewBuild ?? null;

async function call<T = any>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const client = await auth.getClient();
  return (await client.request<T>({ url, method, data: body })).data;
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Starts a build of `branch`; returns the Cloud Build id. */
export async function startPreviewBuild(o: {
  siteId: string; buildId: string; owner: string; repo: string; branch: string; privateRepo: boolean; token?: string;
  command: string[]; outDir: string; cacheDirs: string[]; env?: Record<string, string>;
}) {
  const c = previewBuildConfig() ?? (() => { throw new Error('Aperçus ClaudePress non configurés sur ce serveur (previewBuild).'); })();
  const repoUrl = `github.com/${o.owner}/${o.repo}.git`;
  const out = `gs://${c.bucket}/sites/${o.siteId}/${o.buildId}`;
  const cache = `gs://${c.bucket}/cache/${o.siteId}.tgz`;
  const install = [
    'if [ -f build/requirements.txt ]; then pip install -q -r build/requirements.txt; elif [ -f requirements.txt ]; then pip install -q -r requirements.txt; fi',
    'if [ -f package-lock.json ]; then npm ci --silent; elif [ -f package.json ]; then npm install --silent; fi',
  ].join(' && ');
  const steps = [
    // private repositories: a one-hour installation token of the ClaudePress GitHub App (or the stored server token)
    { id: 'clone', name: 'gcr.io/cloud-builders/git', entrypoint: 'bash',
      args: ['-c', o.privateRepo
        ? `git clone --quiet --depth 1 --branch ${sh(o.branch)} "https://x-access-token:$$GITHUB_TOKEN@${repoUrl}" site`
        : `git clone --quiet --depth 1 --branch ${sh(o.branch)} "https://${repoUrl}" site`],
      ...(o.privateRepo && o.token ? { env: [`GITHUB_TOKEN=${o.token}`] } : o.privateRepo ? { secretEnv: ['GITHUB_TOKEN'] } : {}) },
    { id: 'restore-cache', name: SDK, entrypoint: 'bash',
      args: ['-c', `gcloud storage cp ${cache} cache.tgz --quiet 2>/dev/null && tar xzf cache.tgz -C site || echo "no cache yet"`] },
    { id: 'build', name: c.image || IMAGE, entrypoint: 'bash', dir: 'site',
      env: Object.entries(o.env || {}).map(([k, v]) => `${k}=${v}`),
      args: ['-c', `${install} && ${o.command.map(sh).join(' ')}`] },
    { id: 'upload', name: SDK, entrypoint: 'bash',
      args: ['-c', [
        `gcloud storage rsync -r site/${sh(o.outDir)} ${out} --quiet`,
        ...(o.cacheDirs.length ? [`(cd site && tar czf ../cache.tgz ${o.cacheDirs.map(sh).join(' ')} 2>/dev/null) && gcloud storage cp cache.tgz ${cache} --quiet || true`] : []),
      ].join(' && ')] },
  ];
  const body = {
    steps, timeout: '900s',
    serviceAccount: `projects/${c.project}/serviceAccounts/${c.serviceAccount}`,
    options: { logging: 'CLOUD_LOGGING_ONLY' },
    tags: ['claudepress-preview', `site-${o.siteId}`.slice(0, 120)],
    ...(o.privateRepo && !o.token ? { availableSecrets: { secretManager: [{ versionName: `projects/${c.project}/secrets/${c.githubTokenSecret}/versions/latest`, env: 'GITHUB_TOKEN' }] } } : {}),
  };
  const op = await call('POST', `https://cloudbuild.googleapis.com/v1/projects/${c.project}/locations/${c.region}/builds`, body);
  return op.metadata.build.id as string;
}

export interface BuildSteps { [step: string]: number }   // seconds each step took (or has taken so far)
export const BUILD_STEPS = ['clone', 'restore-cache', 'build', 'upload'];

export async function previewBuildStatus(buildId: string): Promise<{ state: 'running' | 'ready' | 'failed'; detail?: string; step?: string; steps: BuildSteps }> {
  const c = previewBuildConfig()!;
  const b = await call('GET', `https://cloudbuild.googleapis.com/v1/projects/${c.project}/locations/${c.region}/builds/${buildId}`);
  const steps: BuildSteps = {};
  let step: string | undefined;
  let prevEnd = Date.parse(b.startTime || '');   // a running step may not have its own timing yet
  for (const s of b.steps || []) {
    const start = Date.parse(s.timing?.startTime || '') || (s.status === 'WORKING' ? prevEnd : 0), end = Date.parse(s.timing?.endTime || '');
    if (s.status === 'WORKING') step = s.id;
    if (start) steps[s.id] = Math.round(((end || Date.now()) - start) / 1000);
    if (end) prevEnd = end;
  }
  if (b.status === 'SUCCESS') return { state: 'ready', steps };
  if (['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED'].includes(b.status)) {
    const failed = (b.steps || []).find((s: any) => s.status === 'FAILURE' || s.status === 'TIMEOUT');
    return { state: 'failed', detail: `${b.status}${failed ? ` à l’étape « ${failed.id} »` : ''} : ${b.logUrl}`, steps };
  }
  return { state: 'running', step: step ?? (b.status === 'QUEUED' ? 'queued' : undefined), steps };
}

// a first build, before the site has a history of its own (a Python site with images, roughly)
const TYPICAL: BuildSteps = { clone: 8, 'restore-cache': 40, build: 120, upload: 25 };

/** How far a build is, 0 to 99, from the steps done and the time the same steps took last time on this site. */
export function buildProgress(steps: BuildSteps, step: string | undefined, last?: BuildSteps | null) {
  const expect = (id: string) => Math.max(3, last?.[id] ?? TYPICAL[id] ?? 30);
  const total = BUILD_STEPS.reduce((n, id) => n + expect(id), 0);
  let done = 0;
  for (const id of BUILD_STEPS) {
    if (id === step) { done += Math.min(steps[id] ?? 0, expect(id) * 0.95); break; }
    if (steps[id] === undefined) break;
    done += expect(id);
  }
  return Math.max(2, Math.min(99, Math.round((done / total) * 100)));
}

// ---- reading and removing built previews

let bucketP: Promise<any> | null = null;
function bucket() {
  bucketP ||= (async () => {
    const c = previewBuildConfig()!;
    const { initializeApp, getApps } = await import('firebase-admin/app');
    const { getStorage } = await import('firebase-admin/storage');
    return getStorage(getApps()[0] || initializeApp({ projectId: c.project })).bucket(c.bucket);
  })();
  return bucketP;
}

export async function readPreviewFile(objectPath: string): Promise<Buffer | null> {
  try { return (await (await bucket()).file(objectPath).download())[0]; }
  catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function deletePreview(siteId: string, buildId: string) {
  await (await bucket()).deleteFiles({ prefix: `sites/${siteId}/${buildId}/` }).catch(() => {});
}
