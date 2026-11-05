// Extensions: what a hosted service adds to ClaudePress without changing its code: plans with limits and prices, an AI
// credit that runs out, payment, and the screens that offer them. A server without an extension is self-hosted: one
// plan, nothing limited, no prices.
//   - The extension is a module whose default export is an `Extension`: `cloud/server/index.ts` when that file exists,
//     else the file named by CLAUDEPRESS_EXTENSION.
//   - Its screens: `web`, a folder whose files are served under /ext/; its `app.js` is loaded before the first screen
//     and registers hooks with `ClaudePress.hook(name, fn)` (see web/app.js, "extensions").
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { User } from './auth.ts';
import type { Org } from './billing.ts';

/** What an account may have. Self-hosted: everything, without limit. `byok` and `included` are for an extension's prices. */
export interface Plan {
  id: string; name: string; sites: number; clients: number; admins: number;
  whiteLabel: boolean; monitoring: boolean; security: boolean;
  byok: number; included: { price: number; credit: number } | null;
}

export const SELF_HOSTED: Plan = { id: 'self', name: 'Auto-hébergé', sites: Infinity, clients: Infinity, admins: Infinity,
  whiteLabel: true, monitoring: true, security: true, byok: 0, included: { price: 0, credit: Infinity } };

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, u: User, p: string[]) => Promise<unknown> | unknown;

/** What the server hands an extension so it can add its own routes, the same way as its own. */
export interface RouteKit {
  route(method: string, pattern: string, h: Handler): void;
  /** A route answered before anyone is signed in (a payment provider's webhook): true when it was answered. */
  open(handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>): void;
  fail(status: number, message: string): never;
  json(req: http.IncomingMessage): Promise<any>;
  adminOnly(u: User): string;
  /** The account as Administration → Account shows it, after a change. */
  accountView(orgId: string): Promise<unknown>;
  /** The account's sites, to check a smaller plan still holds them. */
  sitesOf(orgId: string): { id: string }[];
  /** After the account's add-ons changed: monitoring and security read them again. */
  forget(orgId: string): void;
}

export interface Extension {
  /** The plans offered, the first one for new accounts. Each one's limits apply (null in the config: unlimited). */
  plans?(): Plan[];
  /** AI credit kept beyond the plan's monthly credit (packs bought), in EUR, and until when. */
  reserve?(org: Org): Promise<{ eur: number; until: string | null }>;
  /** After AI use paid from the credit was counted (EUR): take it from the reserve, warn when it runs out. */
  charged?(org: Org, creditEur: number): Promise<void>;
  /** Monitoring and security bought on top of the plan. */
  addons?(org: Org): { monitoring?: boolean; security?: boolean };
  /** More of the account for its screens (what it pays, what it can buy). */
  account?(org: Org): Promise<Record<string, unknown>>;
  /** More for the Monitoring and Security pages: what they can offer to buy. */
  offer?(org: Org, kind: 'monitoring' | 'security'): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** What an administrator can do when the AI credit ran out ('credits') or the assistant is not on yet ('ai'). */
  hint?(need: 'credits' | 'ai'): string;
  routes?(kit: RouteKit): void;
  /** At start, once the server listens. */
  start?(): void;
  /** Folder of its screens, served under /ext/ (its app.js is loaded with the app). */
  web?: string;
}

let ext: Extension = {};
export const extension = () => ext;
/** A hosted service: its extension lists plans. */
export const hosted = () => !!ext.plans;

/** Loads the extension, if this server has one: once, before the routes are made. */
export async function loadExtension() {
  const file = process.env.CLAUDEPRESS_EXTENSION ? path.resolve(process.env.CLAUDEPRESS_EXTENSION) : path.resolve('cloud/server/index.ts');
  if (!fs.existsSync(file)) return ext;
  ext = (await import(pathToFileURL(file).href)).default ?? {};
  console.log(`Extension: ${path.relative(process.cwd(), file)}`);
  return ext;
}
