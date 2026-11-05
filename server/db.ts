// Data: documents in collections, and files (photos, conversations).
// Two backends behind the same functions:
//   local      one SQLite file (data/claudepress.db) and a folder (data/blobs): nothing to set up
//   firestore  Firestore + a Cloud Storage bucket: for the hosted version (Firebase App Hosting)
// Only simple lookups are used (equality filters, sorting in memory), so Firestore needs no extra index.
//
// Collections (fields keep the names of the first SQL version):
//   users     email, name, agency, org_id, platform, active, firebase_uid, password_hash, invite_token, invite_expires, last_login
//   orgs      name, plan, ai_included, api_key_enc, api_key_last4
//   sites     org_id, name, live_url, repo, branch, adapter, push, seed_cache, status, error
//   members   id "<site>:<user>"  site_id, user_id, org_id, role
//   sessions  id = token          user_id, created
//   devices   id = sha256(token)  user_id, name, created, last_used, apns_token   (connected phones)
//   pairings  id = code           user_id, expires                             (10 minutes, single use)
//   changes   site_id, org_id, type, title, status, author_id, ops, chat, post, request, preview, … (conversation in files)
//   notices   user_id, change_id, text, read, created
//   usage     id "<org>:<YYYY-MM>"  org_id, month, credit (EUR), cost (USD)
//   scan_usage id "<site>:<YYYY-MM>" site_id, org_id, month, scans, credit (EUR), cost (USD)   (a share of the org's usage)
//   usage_log org_id, month, at, kind, site_id, change_id, user_id, tokens_in/cached/out, claude_usd, claude_paid_by,
//             images, video_seconds, media_usd, media_paid_by, credit (EUR)   (every charge, for the usage page)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

export const DATA = path.resolve(process.env.CLAUDEPRESS_DATA || 'data');
fs.mkdirSync(DATA, { recursive: true });

export const now = () => new Date().toISOString();
export const newId = (n = 10) => crypto.randomBytes(16).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, n);

export type Doc<T = any> = T & { id: string };
export type Where = Record<string, string | number | boolean | null>;

export interface Store {
  get<T = any>(col: string, id: string): Promise<Doc<T> | null>;
  set(col: string, id: string, data: Record<string, unknown>): Promise<void>;
  update(col: string, id: string, patch: Record<string, unknown>): Promise<void>;
  remove(col: string, id: string): Promise<void>;
  find<T = any>(col: string, where?: Where): Promise<Doc<T>[]>;
  count(col: string, where?: Where): Promise<number>;
  /** Adds to numeric fields, creating the document with `base` when missing. */
  increment(col: string, id: string, base: Record<string, unknown>, add: Record<string, number>): Promise<void>;
  putFile(name: string, data: Buffer | string): Promise<void>;
  getFile(name: string): Promise<Buffer | null>;
  removeFile(name: string): Promise<void>;
}

// ------------------------------------------------------------------ local: SQLite + folder

function localStore(): Store {
  const sql = new DatabaseSync(path.join(DATA, 'claudepress.db'));
  sql.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (col, id));`);
  const blobs = path.join(DATA, 'blobs');
  const blobPath = (name: string) => {
    const p = path.join(blobs, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
    if (!p.startsWith(blobs)) throw new Error('bad file name');
    return p;
  };
  const filter = (where: Where = {}) => {
    const keys = Object.keys(where);
    if (keys.some(k => !/^\w+$/.test(k))) throw new Error('bad field');
    return {
      clause: keys.map(k => ` AND json_extract(data, '$.${k}') IS ?`).join(''),
      args: keys.map(k => typeof where[k] === 'boolean' ? (where[k] ? 1 : 0) : where[k]),
    };
  };
  const read = (row: any) => row ? { ...JSON.parse(row.data), id: row.id } : null;
  const store: Store = {
    async get(col, id) { return read(sql.prepare('SELECT id, data FROM docs WHERE col = ? AND id = ?').get(col, id)); },
    async set(col, id, data) {
      const { id: _drop, ...rest } = data as any;
      sql.prepare('INSERT INTO docs (col, id, data) VALUES (?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data').run(col, id, JSON.stringify(rest));
    },
    async update(col, id, patch) {
      const cur = await store.get(col, id);
      await store.set(col, id, { ...(cur || {}), ...patch });
    },
    async remove(col, id) { sql.prepare('DELETE FROM docs WHERE col = ? AND id = ?').run(col, id); },
    async find(col, where) {
      const f = filter(where);
      return (sql.prepare(`SELECT id, data FROM docs WHERE col = ?${f.clause}`).all(col, ...f.args) as any[]).map(read);
    },
    async count(col, where) {
      const f = filter(where);
      return (sql.prepare(`SELECT COUNT(*) AS n FROM docs WHERE col = ?${f.clause}`).get(col, ...f.args) as any).n;
    },
    async increment(col, id, base, add) {
      const cur: any = (await store.get(col, id)) || { ...base };
      for (const [k, v] of Object.entries(add)) cur[k] = (Number(cur[k]) || 0) + v;
      await store.set(col, id, cur);
    },
    async putFile(name, data) { const p = blobPath(name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); },
    async getFile(name) { const p = blobPath(name); return fs.existsSync(p) ? fs.readFileSync(p) : null; },
    async removeFile(name) { fs.rmSync(blobPath(name), { force: true }); },
  };
  migrateTables(sql, store);
  return store;
}

/** Databases of the first version had one SQL table per kind of record: copy them into documents once. */
function migrateTables(sql: DatabaseSync, store: Store) {
  const has = (t: string) => !!sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!has('users') || (sql.prepare('SELECT COUNT(*) AS n FROM docs').get() as any).n) return;
  const put = (col: string, id: string, data: any) =>
    sql.prepare('INSERT OR IGNORE INTO docs (col, id, data) VALUES (?, ?, ?)').run(col, id, JSON.stringify(data));
  const rows = (t: string) => has(t) ? sql.prepare(`SELECT * FROM ${t}`).all() as any[] : [];
  const tx = sql.prepare('BEGIN'); tx.run();
  try {
    let org = rows('orgs')[0]?.id;
    if (!org && rows('users').some(u => u.agency)) {
      org = newId();
      put('orgs', org, { name: config.agencyName || 'Mon agence', plan: 'agency', ai_included: 1, created: now() });
    }
    for (const r of rows('orgs')) { const { id, ...d } = r; put('orgs', id, d); }
    for (const r of rows('users')) { const { id, ...d } = r; put('users', id, { ...d, org_id: d.org_id ?? (d.agency ? org : null) }); }
    const siteOrg: Record<string, string> = {};
    for (const r of rows('sites')) { const { id, ...d } = r; siteOrg[id] = d.org_id ?? org; put('sites', id, { ...d, org_id: siteOrg[id] }); }
    for (const r of rows('members')) put('members', `${r.site_id}:${r.user_id}`, { ...r, org_id: siteOrg[r.site_id] ?? null });
    for (const r of rows('sessions')) { const { token, ...d } = r; put('sessions', token, d); }
    for (const r of rows('notices')) { const { id, ...d } = r; put('notices', `n${id}`, d); }
    for (const r of rows('changes')) {
      const { id, messages, ...d } = r;
      put('changes', id, { ...d, org_id: siteOrg[d.site_id] ?? null });
      if (messages && messages !== '[]') {
        const p = path.join(DATA, 'blobs', 'transcripts', `${id}.json`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, messages);
      }
      if (d.credit_used) {
        const month = String(d.updated || d.created).slice(0, 7);
        const key = `${siteOrg[d.site_id]}:${month}`;
        const cur = (sql.prepare("SELECT data FROM docs WHERE col = 'usage' AND id = ?").get(key) as any);
        const u = cur ? JSON.parse(cur.data) : { org_id: siteOrg[d.site_id], month, credit: 0, cost: 0 };
        u.credit += d.credit_used; u.cost += d.cost || 0;
        sql.prepare("INSERT INTO docs (col, id, data) VALUES ('usage', ?, ?) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data").run(key, JSON.stringify(u));
      }
    }
    // uploads move next to the other files
    const up = path.join(DATA, 'uploads');
    if (fs.existsSync(up)) {
      fs.mkdirSync(path.join(DATA, 'blobs', 'uploads'), { recursive: true });
      for (const f of fs.readdirSync(up)) fs.copyFileSync(path.join(up, f), path.join(DATA, 'blobs', 'uploads', f));
    }
    sql.prepare('COMMIT').run();
    console.log('[data] records of the first version copied into documents');
  } catch (e) {
    sql.prepare('ROLLBACK').run();
    throw e;
  }
}

// ------------------------------------------------------------------ Firestore + Cloud Storage

async function firestoreStore(cfg: { projectId: string; bucket: string; database?: string }): Promise<Store> {
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  const { getStorage } = await import('firebase-admin/storage');
  const app = getApps()[0] || initializeApp({ projectId: cfg.projectId, storageBucket: cfg.bucket });
  const fsdb = cfg.database ? getFirestore(app, cfg.database) : getFirestore(app);
  fsdb.settings({ ignoreUndefinedProperties: true });
  const bucket = getStorage(app).bucket(cfg.bucket);
  const query = (col: string, where: Where = {}) => {
    let q: FirebaseFirestore.Query = fsdb.collection(col);
    for (const [k, v] of Object.entries(where)) q = q.where(k, '==', typeof v === 'boolean' ? (v ? 1 : 0) : v);
    return q;
  };
  return {
    async get(col, id) { const d = await fsdb.collection(col).doc(id).get(); return d.exists ? { ...d.data(), id: d.id } as any : null; },
    async set(col, id, data) { const { id: _drop, ...rest } = data as any; await fsdb.collection(col).doc(id).set(rest); },
    async update(col, id, patch) { const { id: _drop, ...rest } = patch as any; await fsdb.collection(col).doc(id).set(rest, { merge: true }); },
    async remove(col, id) { await fsdb.collection(col).doc(id).delete(); },
    async find(col, where) { return (await query(col, where).get()).docs.map(d => ({ ...d.data(), id: d.id }) as any); },
    async count(col, where) { return (await query(col, where).count().get()).data().count; },
    async increment(col, id, base, add) {
      await fsdb.collection(col).doc(id).set({ ...base, ...Object.fromEntries(Object.entries(add).map(([k, v]) => [k, FieldValue.increment(v)])) }, { merge: true });
    },
    async putFile(name, data) { await bucket.file(name).save(typeof data === 'string' ? Buffer.from(data) : data, { resumable: false }); },
    async getFile(name) {
      try { return (await bucket.file(name).download())[0]; }
      catch (e: any) { if (e?.code === 404) return null; throw e; }
    },
    async removeFile(name) { await bucket.file(name).delete({ ignoreNotFound: true }); },
  };
}

export const db: Store = config.storage?.type === 'firestore' ? await firestoreStore(config.storage) : localStore();

// ------------------------------------------------------------------ shared records

export interface ChangeRow {
  id: string; site_id: string; org_id: string | null; type: 'edit' | 'post' | 'request'; title: string;
  status: 'draft' | 'pending' | 'changes_requested' | 'scheduled' | 'published' | 'discarded' | 'agency' | 'done';
  author_id: string; ops: string; chat: string; post: string | null; request: string | null;
  preview: 'none' | 'building' | 'ready' | 'failed'; preview_log: string | null;
  reviewer_id: string | null; review_comment: string | null; commit_sha: string | null; undoes: string | null;
  tokens_in: number; tokens_out: number; tokens_cached?: number; cost: number; credit_used: number; created: string; updated: string; published: string | null;
  pr_number: number | null; preview_sha: string | null; preview_url: string | null; preview_checked: string | null;   // GitHub previews
  // publishing on a date: when, who scheduled it (it is published as them), why the last try failed;
  // suggested_at is the day asked for (by the assistant from the request, or by the author sending it for approval)
  publish_at?: string | null; scheduled_by?: string | null; schedule_error?: string | null; suggested_at?: string | null;
  // once published, is it on the live site (server/golive.ts)
  live?: 'checking' | 'live' | 'late' | 'failed' | 'unverified' | 'local'; live_watch?: number; live_sha?: string | null; live_expect?: string;
  live_checked?: string | null; live_at?: string | null; live_detail?: string | null; live_url?: string | null; live_alerted?: string | null;
}

/** A new change with every field set, so both backends return the same shape. */
export function newChange(fields: Partial<ChangeRow> & Pick<ChangeRow, 'site_id' | 'org_id' | 'type' | 'author_id'>): Omit<ChangeRow, 'id'> {
  return {
    title: '', status: 'draft', ops: '[]', chat: '[]', post: null, request: null, preview: 'none', preview_log: null,
    reviewer_id: null, review_comment: null, commit_sha: null, undoes: null, tokens_in: 0, tokens_out: 0, cost: 0, credit_used: 0,
    pr_number: null, preview_sha: null, preview_url: null, preview_checked: null,
    created: now(), updated: now(), published: null, ...fields,
  };
}

/** The Claude conversation of a change (can hold photos, so it lives in a file, not in the record). */
export const transcript = {
  async get(changeId: string): Promise<any[]> { const b = await db.getFile(`transcripts/${changeId}.json`); return b ? JSON.parse(b.toString('utf8')) : []; },
  async set(changeId: string, messages: any[]) { await db.putFile(`transcripts/${changeId}.json`, JSON.stringify(messages)); },
};

/** `link`: where the notice leads when it is not about a change (an app address such as '#/admin/account'). */
export async function notify(userIds: string[], changeId: string | null, text: string, link?: string) {
  for (const u of new Set(userIds)) await db.set('notices', newId(14), { user_id: u, change_id: changeId, text, read: 0, created: now(), ...(link ? { link } : {}) });
}

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
