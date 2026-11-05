// The repository's files, for full edits ("agency style"): the assistant can read, search and change any text
// file of the site, like the agency would in its editor. Files are read from GitHub at the commit the site is on,
// and kept in memory for that commit.
import * as GH from './github.ts';
import type { Site } from './sites.ts';
import type { Op } from './adapters/types.ts';

const MAX = 400_000;   // bytes: bigger files are not opened (generated or data files)
const BINARY = /\.(png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|pdf|zip|gz|tgz|jar|exe|bin|psd|ai|sketch)$/i;
const SKIP = /(^|\/)(\.git|node_modules|\.cache|__pycache__|vendor|wp-content|wp-includes|wp-admin|wayback)\//;
// never changed from ClaudePress: deployment workflows (they hold the keys to the hosting) and secrets
const LOCKED = /^(\.github\/|\.git\/)|(^|\/)\.env(\.|$)|(^|\/)(secrets?|credentials?)(\.|\/)|\.(pem|key|p12)$/i;

interface Cache { sha: string; tree: { path: string; size: number }[]; texts: Map<string, string | null> }
const caches = new Map<string, Cache>();

async function cacheOf(s: Site): Promise<Cache> {
  const repo = GH.repoOf(s.repo)!;
  let c = caches.get(s.id);
  if (!c || c.sha !== s.headSha) {
    const { files } = await GH.listTree(repo, s.headSha!);
    c = { sha: s.headSha!, tree: files.filter(f => !SKIP.test(f.path)), texts: new Map() };
    caches.set(s.id, c);
  }
  return c;
}

/** Why a path cannot be changed, or null. Content files go through their own tools (texts, prices, shared texts). */
export function lockedPath(s: Site, p: string) {
  if (!p || p.startsWith('/') || p.split('/').some(x => x === '..' || x === '')) return 'Chemin invalide : relatif à la racine du dépôt, sans « .. ».';
  if (LOCKED.test(p)) return `${p} est protégé : les workflows de déploiement et les secrets ne se modifient pas depuis ClaudePress.`;
  if (BINARY.test(p)) return `${p} n’est pas un fichier texte.`;
  const a = s.adapter as any;
  if (s.adapter_.owns(p)) return `${p} est un fichier de contenu : utilisez les outils de textes, de prix ou de textes communs.`;
  if (a.outDir && (p === a.outDir || p.startsWith(a.outDir.replace(/\/?$/, '/')))) return `${p} est généré par la construction du site : modifiez la source.`;
  return null;
}

/** Text files of the repository, with their size. */
export async function listFiles(s: Site, prefix = '') {
  const c = await cacheOf(s);
  return c.tree.filter(f => f.path.startsWith(prefix) && !BINARY.test(f.path)).map(f => ({ path: f.path, size: f.size }));
}

/** A file as the repository has it (null when it does not exist or is too big to open). */
export async function repoText(s: Site, p: string): Promise<string | null> {
  const c = await cacheOf(s);
  if (c.texts.has(p)) return c.texts.get(p)!;
  const f = c.tree.find(x => x.path === p);
  const text = !f || f.size > MAX || BINARY.test(p) ? null : await GH.readFile(GH.repoOf(s.repo)!, p, c.sha);
  c.texts.set(p, text);
  return text;
}

export const exists = async (s: Site, p: string) => (await cacheOf(s)).tree.some(f => f.path === p);

/** A file as this change leaves it: the change's own version if it touched it, else the repository's. */
export async function draftText(s: Site, ops: Op[], p: string) {
  const own = [...ops].reverse().find(o => o.kind === 'file' && o.path === p) as Extract<Op, { kind: 'file' }> | undefined;
  return own ? own.after : repoText(s, p);
}

/** Plain-text search through the text files (case-insensitive), with the change's own versions. */
export async function searchFiles(s: Site, ops: Op[], query: string, prefix = '') {
  const q = query.toLowerCase();
  const out: { path: string; line: number; text: string }[] = [];
  for (const f of await listFiles(s, prefix)) {
    if (f.size > MAX) continue;
    const text = await draftText(s, ops, f.path);
    if (text == null) continue;
    text.split('\n').forEach((l, i) => { if (out.length < 60 && l.toLowerCase().includes(q)) out.push({ path: f.path, line: i + 1, text: l.trim().slice(0, 200) }); });
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * The whole files a change writes, checked against the version the site is on now: when someone else changed a
 * file in between, the change does not apply any more (rather than overwriting their work).
 */
export async function fileOpsOnLatest(s: Site, ops: Op[]) {
  const files: Record<string, string> = {};
  const errors: string[] = [];
  const last = new Map<string, Extract<Op, { kind: 'file' }>>();
  for (const o of ops) if (o.kind === 'file') last.set(o.path, o);
  for (const o of last.values()) {
    const cur = await repoText(s, o.path);
    const first = ops.find(x => x.kind === 'file' && x.path === o.path) as Extract<Op, { kind: 'file' }>;
    if ((cur ?? null) !== (first.before ?? null)) { errors.push(`Le fichier ${o.path} a changé entre-temps`); continue; }
    files[o.path] = o.after;
  }
  return { files, errors };
}

/** Line diff of two versions of a file, as unified-diff lines with a little context (for the change cards). */
export function patchOf(a: string | null, b: string, context = 2, maxLines = 400) {
  const A = (a ?? '').split('\n'), B = b.split('\n');
  if (a == null) return B.slice(0, maxLines).map(l => '+' + l).concat(B.length > maxLines ? [`… ${B.length - maxLines} more lines`] : []).join('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  // the changed middle, line by line (LCS), or as one block when it is too big to compare
  const rows: string[] = [];
  if (a2.length * b2.length <= 4_000_000) {
    const L = Array.from({ length: a2.length + 1 }, () => new Int32Array(b2.length + 1));
    for (let i = a2.length - 1; i >= 0; i--) for (let j = b2.length - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < a2.length && j < b2.length) {
      if (a2[i] === b2[j]) { rows.push(' ' + a2[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) rows.push('-' + a2[i++]);
      else rows.push('+' + b2[j++]);
    }
    while (i < a2.length) rows.push('-' + a2[i++]);
    while (j < b2.length) rows.push('+' + b2[j++]);
  } else rows.push(...a2.map(l => '-' + l), ...b2.map(l => '+' + l));
  // keep changed lines with `context` lines around them
  const all = [...A.slice(Math.max(0, pre - context), pre).map(l => ' ' + l), ...rows, ...A.slice(A.length - suf, A.length - suf + context).map(l => ' ' + l)];
  const keep = all.map((l, k) => l[0] !== ' ' || all.slice(Math.max(0, k - context), k + context + 1).some(x => x[0] !== ' '));
  const out: string[] = [`@@ ligne ${Math.max(1, pre - context + 1)}`];
  all.forEach((l, k) => { if (keep[k]) out.push(l); else if (keep[k - 1]) out.push('…'); });
  return out.slice(0, maxLines).concat(out.length > maxLines ? [`… ${out.length - maxLines} more lines`] : []).join('\n');
}
