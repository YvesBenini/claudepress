// Accounts: passwords (scrypt), sessions in a cookie, invitation links that let a person choose their password.
import crypto from 'node:crypto';
import type http from 'node:http';
import { db, newId, now } from './db.ts';
import { config } from './config.ts';

export interface User { id: string; email: string; name: string; agency: number; active: number; org_id: string | null; platform: number; lang: 'fr' | 'en' | null }

const COOKIE = 'claudepress_session';
const SESSION_DAYS = 30;
export const INVITE_DAYS = 14;

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function checkPassword(password: string, stored: string | null) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

export function passwordProblem(password: string) {
  if (typeof password !== 'string' || password.length < 10) return 'Le mot de passe doit faire au moins 10 caractères.';
  return null;
}

const SESSION_MS = SESSION_DAYS * 86400e3;

export async function userOf(req: http.IncomingMessage): Promise<User | undefined> {
  const userId = await deviceUser(req) ?? await sessionUser(req);
  if (!userId) return undefined;
  const u = await db.get('users', userId);
  if (!u || !u.active) return undefined;
  return { id: u.id, email: u.email, name: u.name, agency: u.agency ? 1 : 0, active: 1, org_id: u.org_id ?? null, platform: u.platform ? 1 : 0, lang: u.lang === 'en' || u.lang === 'fr' ? u.lang : null };
}

async function sessionUser(req: http.IncomingMessage) {
  const token = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '')?.[1];
  if (!token) return undefined;
  const s = await db.get('sessions', token);
  if (!s || Date.parse(s.created) < Date.now() - SESSION_MS) return undefined;
  return s.user_id as string;
}

export async function startSession(userId: string) {
  const token = newId(40);
  await db.set('sessions', token, { user_id: userId, created: now() });
  await db.update('users', userId, { last_login: now() });
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export async function endSession(req: http.IncomingMessage) {
  const token = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '')?.[1];
  if (token) await db.remove('sessions', token);
  const device = bearerOf(req);   // "Disconnect this iPhone"
  if (device) await db.remove('devices', deviceId(device));
  return `${COOKIE}=; Path=/; Max-Age=0`;
}

/** Signs a person out everywhere: browsers and connected phones. */
export async function endAllSessions(userId: string) {
  for (const s of await db.find('sessions', { user_id: userId })) await db.remove('sessions', s.id);
  for (const d of await db.find('devices', { user_id: userId })) await db.remove('devices', d.id);
}

// ---- connected phones: the app pairs once with a code shown on the web, then sends its own token.
// A device stays connected until it is removed, the person is signed out everywhere, or it goes unused for 6 months.

const DEVICE_IDLE_MS = 180 * 86400e3;
const PAIR_MS = 10 * 60e3;
const PAIR_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I

const bearerOf = (req: http.IncomingMessage) => /^Bearer (cpd_[\w-]{40,})$/.exec(String(req.headers.authorization || ''))?.[1];
/** Devices are stored under a hash of their token: a copy of the database does not let anyone in. */
const deviceId = (token: string) => crypto.createHash('sha256').update(token).digest('base64url');

async function deviceUser(req: http.IncomingMessage) {
  const token = bearerOf(req);
  if (!token) return undefined;
  const d = await db.get('devices', deviceId(token));
  if (!d || Date.parse(d.last_used) < Date.now() - DEVICE_IDLE_MS) return undefined;
  if (Date.parse(d.last_used) < Date.now() - 3600e3) await db.update('devices', d.id, { last_used: now() });
  return d.user_id as string;
}

/** The id of the device making the request, to mark it in the list. */
export const currentDevice = (req: http.IncomingMessage) => { const t = bearerOf(req); return t ? deviceId(t) : null; };

/** A one-time code for connecting a phone, valid 10 minutes; the person's previous code stops working. */
export async function newPairCode(userId: string) {
  for (const p of await db.find('pairings', { user_id: userId })) await db.remove('pairings', p.id);
  const code = [...crypto.randomBytes(8)].map(b => PAIR_LETTERS[b % PAIR_LETTERS.length]).join('');
  const expires = new Date(Date.now() + PAIR_MS).toISOString();
  await db.set('pairings', code, { user_id: userId, expires });
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires };
}

/** Exchanges a pairing code for a device token (shown once, to the phone). */
export async function pairDevice(code: string, name: string) {
  const id = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = id.length === 8 ? await db.get('pairings', id) : null;
  if (!p) return null;
  await db.remove('pairings', id);
  if (p.expires < now()) return null;
  const token = `cpd_${crypto.randomBytes(32).toString('base64url')}`;
  await db.set('devices', deviceId(token), { user_id: p.user_id, name: String(name || 'iPhone').trim().slice(0, 60) || 'iPhone', created: now(), last_used: now(), apns_token: null });
  return { token, userId: p.user_id as string };
}

export async function devicesOf(userId: string) {
  return (await db.find('devices', { user_id: userId }))
    .filter(d => Date.parse(d.last_used) >= Date.now() - DEVICE_IDLE_MS)
    .sort((a, b) => b.last_used.localeCompare(a.last_used))
    .map(d => ({ id: d.id, name: d.name, created: d.created, last_used: d.last_used }));
}

/** A fresh invitation (or password reset) link token for a person; the previous one stops working. */
export async function newInvite(userId: string) {
  const token = newId(32);
  await db.update('users', userId, { invite_token: token, invite_expires: new Date(Date.now() + INVITE_DAYS * 86400e3).toISOString() });
  return token;
}

export async function userByInvite(token: string) {
  const [u] = await db.find('users', { invite_token: token, active: 1 });
  return u as (User & { invite_expires: string }) | undefined;
}

/** Slows down password guessing: at most 10 failed attempts per address and per account every 15 minutes. */
const failures = new Map<string, number[]>();
export function tooManyAttempts(...keys: string[]) {
  const cutoff = Date.now() - 15 * 60e3;
  return keys.some(k => (failures.get(k) || []).filter(t => t > cutoff).length >= 10);
}
export function recordFailure(...keys: string[]) {
  const cutoff = Date.now() - 15 * 60e3;
  for (const k of keys) failures.set(k, [...(failures.get(k) || []).filter(t => t > cutoff), Date.now()]);
}

// ---- Firebase Authentication: the browser signs in with Firebase, the server checks its ID token once and opens its own session

let firebaseAuth: import('firebase-admin/auth').Auth | null = null;

export interface FirebaseIdentity { uid: string; email: string; emailVerified: boolean; name: string; provider: string }

export async function verifyFirebaseToken(projectId: string, idToken: string): Promise<FirebaseIdentity> {
  if (!firebaseAuth) {
    const emulator = config.firebase?.authEmulator;
    if (emulator) process.env.FIREBASE_AUTH_EMULATOR_HOST = emulator.replace(/^https?:\/\//, '');   // local tests only
    const { initializeApp, getApps } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app = getApps()[0] || initializeApp({ projectId });   // checking ID tokens only needs the project id
    firebaseAuth = getAuth(app);
  }
  const t = await firebaseAuth.verifyIdToken(idToken);
  if (!t.email) throw new Error('Ce compte n’a pas d’adresse e-mail.');
  return { uid: t.uid, email: t.email.toLowerCase(), emailVerified: !!t.email_verified, name: String(t.name || ''), provider: String(t.firebase?.sign_in_provider || '') };
}
