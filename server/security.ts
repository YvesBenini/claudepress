// Security of the sites. Once a day each site the security add-on covers is checked from outside and in its
// repository, and its files are saved:
//   1. the live site: HTTPS and its redirect, security headers, cookies, mixed content, keys left in its scripts,
//      files that should never be public (.env, .git…), an open Firebase database, and scripts from other sites
//      that appear on it without being anywhere in the repository (a sign the site was changed behind the agency's back)
//   2. the domain: when it expires (RDAP), and for a domain that receives e-mail, SPF and DMARC (else anyone can send
//      e-mail in its name)
//   3. the repository: every dependency of its lockfiles against the advisories of OSV.dev (npm, PyPI, RubyGems), those
//      attackers use right now (CISA's Known Exploited Vulnerabilities) marked so; keys and .env files committed
//   4. a backup: the repository's files as GitHub archives them, each time they changed, kept 90 days
// What is new is told to the account's administrators (by e-mail when it is high or critical); what is gone at the
// next check is marked fixed. An administrator may accept a finding: it then stops counting and alerting.
// Nobody can promise a site will never be hacked: this is the process that finds problems early and keeps a copy.
// Without the add-on a site can still be checked on request, once a day: no daily checks, no alerts, no backups.
// The probes that ask for more than the home page and its scripts (sensitive files, Firebase) run only once
// ClaudePress knows the live site is built from the repository: a change published from ClaudePress was seen on it,
// or the home page's title is in the repository's files.
// Checks run on a timer, and with the monitoring's tick (POST /api/monitor/tick) on servers that sleep: only what is due.
//
// Collections:
//   security          id = site  site_id, org_id, checked, sha, score, grade, findings [], scripts [], accepted {}, error, auto
//   security_backups  site_id, org_id, sha, at, size, file
//   advisories        id = OSV id  summary, severity, aliases, published, modified, url, fixed {package: [versions]}, fetched
//   platform/kev      the CVE ids of CISA's catalogue, fetched (once a day)
import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { db, newId, notify, now } from './db.ts';
import * as GH from './github.ts';
import { allSites, siteAnyState, type Site } from './sites.ts';
import { brandOf, orgOf, securityOn } from './billing.ts';
import { hosted } from './extension.ts';
import { layout, mailOn, sendMail } from './mail.ts';
import { fetchWithHeaders } from './monitor.ts';

const exec = promisify(execFile);
const DAY = 86_400_000;
const AGAIN_FREE = DAY;            // without the add-on, a site may be checked on request once a day
const AGAIN_PAID = 10 * 60_000;    // with it, once every ten minutes
const KEEP_FIXED_DAYS = 30;        // fixed findings stay listed this long
const KEEP_BACKUP_DAYS = 90;
const ADVISORY_DAYS = 7;           // an advisory read from OSV is read again after this many days
const AT_ONCE = 2;                 // sites checked at the same time
const PER_TICK = 3;                // sites started by one tick, so a server woken by the scheduler answers in time

const origin = () => (config.publicUrl || `http://${config.host || 'localhost'}:${process.env.PORT || config.port || 4400}`).replace(/\/$/, '');

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const WEIGHT: Record<Severity, number> = { critical: 35, high: 20, medium: 8, low: 3, info: 0 };
type Section = 'live' | 'domain' | 'deps' | 'repo';

export interface Finding {
  key: string; check: string; section: Section; severity: Severity; vars: Record<string, any>;
  first?: string; fixed?: string | null;
}
interface SecurityDoc {
  id: string; site_id: string; org_id: string | null; checked: string | null; sha: string | null; score: number | null; grade: string | null;
  findings: Finding[]; scripts: string[] | null; accepted: Record<string, { by: string; at: string }>; error: string | null; auto: boolean;
}

const docOf = async (s: Site): Promise<SecurityDoc> => ({ id: s.id, site_id: s.id, org_id: s.orgId ?? null, checked: null, sha: null, score: null,
  grade: null, findings: [], scripts: null, accepted: {}, error: null, auto: false, ...(await db.get<SecurityDoc>('security', s.id)) });

// ---- what each finding says, in French and English: findings keep only their check and its values, so the
// screens and e-mails speak the reader's language

type Text = { title: string; detail: string; fix: string };
const HEADERS_FIX = (fr: boolean) => fr
  ? 'Ajoutez ces en-têtes chez l’hébergeur : Netlify (_headers), Vercel (vercel.json, "headers"), Cloudflare Pages (_headers), Firebase (firebase.json, hosting.headers). Par exemple :\nStrict-Transport-Security: max-age=31536000; includeSubDomains\nX-Content-Type-Options: nosniff\nX-Frame-Options: SAMEORIGIN\nReferrer-Policy: strict-origin-when-cross-origin'
  : 'Add these headers at the host: Netlify (_headers), Vercel (vercel.json, "headers"), Cloudflare Pages (_headers), Firebase (firebase.json, hosting.headers). For example:\nStrict-Transport-Security: max-age=31536000; includeSubDomains\nX-Content-Type-Options: nosniff\nX-Frame-Options: SAMEORIGIN\nReferrer-Policy: strict-origin-when-cross-origin';
const ROTATE = (fr: boolean) => fr
  ? 'Révoquez cette clé chez le service qui l’a émise et créez-en une nouvelle, gardée côté serveur uniquement. La retirer du site ne suffit pas : elle a pu être copiée.'
  : 'Revoke this key at the service that issued it and create a new one, kept on the server only. Removing it from the site is not enough: it may have been copied.';

const TEXTS: Record<string, (v: any, fr: boolean) => Text> = {
  unreachable: (_v, fr) => fr
    ? { title: 'Le site en ligne n’a pas répondu', detail: 'Les vérifications du site en ligne reprendront au prochain passage.', fix: '' }
    : { title: 'The live site did not respond', detail: 'The live site’s checks will run again next time.', fix: '' },
  unverified: (_v, fr) => fr
    ? { title: 'Vérifications approfondies en attente', detail: 'ClaudePress ne cherche les fichiers sensibles et les bases ouvertes que sur un site dont il sait qu’il est construit depuis ce dépôt. Ce sera le cas dès qu’un changement publié depuis ClaudePress apparaîtra sur le site.', fix: '' }
    : { title: 'Deeper checks waiting', detail: 'ClaudePress only looks for sensitive files and open databases on a site it knows is built from this repository. That will be the case as soon as a change published from ClaudePress shows on the site.', fix: '' },
  https: (_v, fr) => fr
    ? { title: 'Le site n’est pas servi en HTTPS', detail: 'Les visiteurs voient « Non sécurisé », et ce qu’ils envoient (formulaires) peut être lu en chemin.', fix: 'Activez le certificat gratuit de l’hébergeur (Let’s Encrypt) et changez l’adresse du site en https:// dans ClaudePress.' }
    : { title: 'The site is not served over HTTPS', detail: 'Visitors see “Not secure”, and what they send (forms) can be read on the way.', fix: 'Turn on the host’s free certificate (Let’s Encrypt) and change the site’s address to https:// in ClaudePress.' },
  'http-redirect': (_v, fr) => fr
    ? { title: 'La version http:// ne redirige pas vers https://', detail: 'Un visiteur qui tape l’adresse sans https arrive sur une version non chiffrée du site.', fix: 'Activez « Forcer HTTPS » chez l’hébergeur.' }
    : { title: 'The http:// version does not redirect to https://', detail: 'A visitor who types the address without https lands on an unencrypted version of the site.', fix: 'Turn on “Force HTTPS” at the host.' },
  hsts: (v, fr) => fr
    ? { title: v.short ? 'La durée HSTS est trop courte' : 'En-tête HSTS absent', detail: v.short ? `max-age vaut ${v.age} secondes : six mois au moins (15552000) sont conseillés.` : 'Les navigateurs ne savent pas qu’ils doivent toujours utiliser HTTPS pour ce site : sur un Wi-Fi public, une première visite peut être détournée.', fix: HEADERS_FIX(fr) }
    : { title: v.short ? 'HSTS max-age is too short' : 'HSTS header missing', detail: v.short ? `max-age is ${v.age} seconds: at least six months (15552000) is advised.` : 'Browsers are not told to always use HTTPS for this site: on public Wi-Fi a first visit can be hijacked.', fix: HEADERS_FIX(fr) },
  csp: (_v, fr) => fr
    ? { title: 'Pas de Content-Security-Policy', detail: 'Sans elle, un script injecté (par un outil tiers compromis, par exemple) s’exécute sans limite.', fix: 'Ajoutez une politique, d’abord en mode rapport (Content-Security-Policy-Report-Only), puis appliquez-la. Elle doit lister les services que le site utilise (statistiques, polices, vidéos).' }
    : { title: 'No Content-Security-Policy', detail: 'Without one, an injected script (from a compromised third-party tool, for instance) runs without limits.', fix: 'Add a policy, first in report mode (Content-Security-Policy-Report-Only), then enforce it. It must list the services the site uses (analytics, fonts, videos).' },
  nosniff: (_v, fr) => fr
    ? { title: 'En-tête X-Content-Type-Options absent', detail: 'Les navigateurs peuvent interpréter un fichier comme un script alors qu’il n’en est pas un.', fix: HEADERS_FIX(fr) }
    : { title: 'X-Content-Type-Options header missing', detail: 'Browsers may treat a file as a script when it is not one.', fix: HEADERS_FIX(fr) },
  frame: (_v, fr) => fr
    ? { title: 'Le site peut être affiché dans le cadre d’un autre site', detail: 'Un site malveillant peut l’afficher en transparence pour faire cliquer les visiteurs à leur insu (clickjacking).', fix: HEADERS_FIX(fr) }
    : { title: 'The site can be shown inside another site', detail: 'A malicious site can show it transparently to make visitors click without knowing (clickjacking).', fix: HEADERS_FIX(fr) },
  'server-version': (v, fr) => fr
    ? { title: 'Le serveur annonce sa version', detail: `Il répond « ${v.value} » : cela aide un attaquant à choisir la faille à essayer.`, fix: 'Masquez la version dans la configuration du serveur (server_tokens off, expose_php Off…).' }
    : { title: 'The server announces its version', detail: `It answers “${v.value}”: that helps an attacker pick which flaw to try.`, fix: 'Hide the version in the server’s settings (server_tokens off, expose_php Off…).' },
  cookie: (v, fr) => fr
    ? { title: 'Cookie sans protection', detail: `Le cookie « ${v.name} » n’a pas ${v.missing.join(' ni ')}.`, fix: 'Ajoutez Secure (envoyé seulement en HTTPS), HttpOnly (invisible aux scripts) et SameSite=Lax au cookie.' }
    : { title: 'Cookie without protection', detail: `The cookie “${v.name}” lacks ${v.missing.join(' and ')}.`, fix: 'Add Secure (only sent over HTTPS), HttpOnly (hidden from scripts) and SameSite=Lax to the cookie.' },
  mixed: (v, fr) => fr
    ? { title: 'Contenu chargé en http:// sur une page https://', detail: `${v.url} : les navigateurs le bloquent, ou affichent le site comme non sécurisé.`, fix: 'Changez l’adresse en https:// dans le site.' }
    : { title: 'Content loaded over http:// on an https:// page', detail: `${v.url}: browsers block it, or show the site as not secure.`, fix: 'Change the address to https:// in the site.' },
  'js-secret': (v, fr) => fr
    ? { title: `Clé secrète visible sur le site : ${v.kind}`, detail: `Dans ${v.where} : ${v.masked}. N’importe quel visiteur peut la lire et l’utiliser.`, fix: ROTATE(fr) }
    : { title: `Secret key visible on the site: ${v.kind}`, detail: `In ${v.where}: ${v.masked}. Any visitor can read and use it.`, fix: ROTATE(fr) },
  sourcemap: (v, fr) => fr
    ? { title: 'Le code source des scripts est public', detail: `${v.url} : les fichiers .map redonnent le code d’origine, commentaires compris.`, fix: 'Ne publiez pas les fichiers .map (option sourcemap de la construction), ou bloquez-les chez l’hébergeur.' }
    : { title: 'The scripts’ source code is public', detail: `${v.url}: .map files give back the original code, comments included.`, fix: 'Do not publish .map files (the build’s sourcemap option), or block them at the host.' },
  exposed: (v, fr) => fr
    ? { title: `Fichier sensible accessible : ${v.path}`, detail: `${v.what}. N’importe qui peut le télécharger.`, fix: 'Retirez-le du dossier publié et bloquez les fichiers commençant par un point chez l’hébergeur. S’il contenait des mots de passe ou des clés, changez-les maintenant.' }
    : { title: `Sensitive file reachable: ${v.path}`, detail: `${v.what_en}. Anyone can download it.`, fix: 'Remove it from the published folder and block dotfiles at the host. If it held passwords or keys, change them now.' },
  'firestore-open': (v, fr) => fr
    ? { title: 'La base Firestore se lit sans connexion', detail: `Le projet ${v.project} liste ses collections à n’importe qui${v.names ? ` (${v.names})` : ''} : leurs documents sont très probablement lisibles aussi.`, fix: 'Refusez tout par défaut dans les règles Firestore, puis n’ouvrez que ce qui doit l’être, à l’utilisateur connecté. Testez-les dans le simulateur de règles avant de les publier.' }
    : { title: 'The Firestore database reads without signing in', detail: `Project ${v.project} lists its collections to anyone${v.names ? ` (${v.names})` : ''}: their documents are very likely readable too.`, fix: 'Deny everything by default in the Firestore rules, then open only what must be, to the signed-in user. Test them in the rules playground before publishing.' },
  'rtdb-open': (v, fr) => fr
    ? { title: 'La base Realtime Database se lit sans connexion', detail: `${v.url} répond à n’importe qui.`, fix: 'Mettez ".read": false et ".write": false à la racine des règles, puis ouvrez seulement ce qui doit l’être.' }
    : { title: 'The Realtime Database reads without signing in', detail: `${v.url} answers anyone.`, fix: 'Set ".read": false and ".write": false at the rules’ root, then open only what must be.' },
  'storage-open': (v, fr) => fr
    ? { title: 'Les fichiers Firebase Storage se listent sans connexion', detail: `Le bucket ${v.bucket} donne la liste de ses fichiers à n’importe qui.`, fix: 'Dans les règles Storage, refusez la liste (allow list: if false) et limitez la lecture à ce qui doit être public.' }
    : { title: 'Firebase Storage files list without signing in', detail: `Bucket ${v.bucket} lists its files to anyone.`, fix: 'In the Storage rules, deny listing (allow list: if false) and limit reads to what must be public.' },
  'new-script': (v, fr) => fr
    ? { title: `Un script inconnu est apparu : ${v.host}`, detail: `La page d’accueil charge un script de ${v.host}, absent lors des vérifications précédentes, et ce nom ne se trouve nulle part dans le dépôt. Si personne ne l’a ajouté (statistiques, chat, publicité), le site a peut-être été modifié à votre insu.`, fix: 'Vérifiez qui l’a ajouté. S’il est voulu, acceptez-le ici. Sinon, changez les mots de passe de l’hébergeur et du nom de domaine, puis remettez le site en ligne depuis GitHub.' }
    : { title: `An unknown script appeared: ${v.host}`, detail: `The home page loads a script from ${v.host}, absent at previous checks, and that name is nowhere in the repository. If nobody added it (analytics, chat, ads), the site may have been changed behind your back.`, fix: 'Check who added it. If it is wanted, accept it here. Otherwise, change the host’s and the domain’s passwords, then redeploy the site from GitHub.' },
  'domain-expiry': (v, fr) => fr
    ? { title: `Le nom de domaine expire dans ${v.days} jour(s)`, detail: `${v.domain} expire le ${v.date}. Expiré, le site et les e-mails s’arrêtent, et le nom peut être racheté par quelqu’un d’autre.`, fix: 'Renouvelez-le chez le registraire, et activez le renouvellement automatique.' }
    : { title: `The domain name expires in ${v.days} day(s)`, detail: `${v.domain} expires on ${v.date}. Once expired, the site and e-mail stop, and someone else can buy the name.`, fix: 'Renew it at the registrar, and turn on automatic renewal.' },
  spf: (v, fr) => fr
    ? { title: 'Pas d’enregistrement SPF', detail: `${v.domain} reçoit des e-mails mais ne dit pas quels serveurs peuvent en envoyer en son nom : n’importe qui peut se faire passer pour lui.`, fix: 'Ajoutez un enregistrement TXT « v=spf1 include:… -all » avec le service d’e-mail utilisé (Google, Microsoft, OVH…).' }
    : { title: 'No SPF record', detail: `${v.domain} receives e-mail but does not say which servers may send in its name: anyone can pretend to be it.`, fix: 'Add a TXT record “v=spf1 include:… -all” with the e-mail service in use (Google, Microsoft, OVH…).' },
  dmarc: (v, fr) => fr
    ? { title: v.none ? 'DMARC en mode observation seulement' : 'Pas d’enregistrement DMARC', detail: v.none ? `${v.domain} a une politique DMARC « p=none » : les faux e-mails à son nom sont signalés mais pas bloqués.` : `Sans DMARC, les messageries ne savent pas quoi faire d’un faux e-mail au nom de ${v.domain}.`, fix: 'Ajoutez un enregistrement TXT sur _dmarc avec « v=DMARC1; p=quarantine; rua=mailto:… », après avoir vérifié SPF et DKIM.' }
    : { title: v.none ? 'DMARC in monitoring mode only' : 'No DMARC record', detail: v.none ? `${v.domain} has a “p=none” DMARC policy: fake e-mails in its name are reported but not blocked.` : `Without DMARC, mailboxes do not know what to do with a fake e-mail in the name of ${v.domain}.`, fix: 'Add a TXT record on _dmarc with “v=DMARC1; p=quarantine; rua=mailto:…”, after checking SPF and DKIM.' },
  dep: (v, fr) => {
    const what = `${v.name} ${v.version}`;
    const cmd = v.fixed ? v.eco === 'npm' ? (v.direct ? `npm install ${v.name}@${v.fixed}` : `"overrides": { "${v.name}": "${v.fixed}" }`)
      : v.eco === 'PyPI' ? `${v.name}==${v.fixed}` : `bundle update ${v.name}` : null;
    return fr
      ? { title: `${v.malicious ? 'Paquet malveillant' : v.kev ? 'Faille exploitée en ce moment' : 'Faille connue'} : ${what}`,
          detail: `${v.summary || v.ids.join(', ')}${v.ids.length > 1 ? ` (et ${v.ids.length - 1} autre(s) avis)` : ''}. Dans ${v.file}${v.dev ? ', utilisé seulement pour construire le site' : ''}.`,
          fix: v.malicious ? 'Retirez ce paquet tout de suite et changez les clés auxquelles la construction du site a accès.'
            : cmd ? `Passez à la version ${v.fixed} ou plus : ${cmd}${!v.direct && v.eco === 'npm' ? ' dans package.json (ou mettez à jour le paquet qui l’utilise)' : ''}.` : 'Aucune version corrigée pour l’instant : surveillez l’avis, ou remplacez ce paquet.' }
      : { title: `${v.malicious ? 'Malicious package' : v.kev ? 'Flaw exploited right now' : 'Known flaw'}: ${what}`,
          detail: `${v.summary || v.ids.join(', ')}${v.ids.length > 1 ? ` (and ${v.ids.length - 1} more advisory(ies))` : ''}. In ${v.file}${v.dev ? ', only used to build the site' : ''}.`,
          fix: v.malicious ? 'Remove this package now and change the keys the site’s build can reach.'
            : cmd ? `Move to version ${v.fixed} or later: ${cmd}${!v.direct && v.eco === 'npm' ? ' in package.json (or update the package that uses it)' : ''}.` : 'No fixed version yet: watch the advisory, or replace this package.' };
  },
  'no-lock': (v, fr) => fr
    ? { title: 'Versions des dépendances non verrouillées', detail: `${v.file} n’a pas de fichier de verrouillage (package-lock.json, yarn.lock ou pnpm-lock.yaml) : les versions installées changent d’une construction à l’autre et ne peuvent pas être vérifiées.`, fix: 'Lancez npm install et ajoutez le package-lock.json créé au dépôt.' }
    : { title: 'Dependency versions not locked', detail: `${v.file} has no lockfile (package-lock.json, yarn.lock or pnpm-lock.yaml): installed versions change from one build to the next and cannot be checked.`, fix: 'Run npm install and add the package-lock.json it creates to the repository.' },
  'repo-secret': (v, fr) => fr
    ? { title: `Clé secrète dans le dépôt : ${v.kind}`, detail: `Dans ${v.file} : ${v.masked}. Toute personne qui a accès au dépôt (ou à une copie) peut l’utiliser.`, fix: `${ROTATE(fr)} Elle reste dans l’historique de Git même après l’avoir retirée du fichier.` }
    : { title: `Secret key in the repository: ${v.kind}`, detail: `In ${v.file}: ${v.masked}. Anyone with access to the repository (or a copy) can use it.`, fix: `${ROTATE(fr)} It stays in Git’s history even after it is removed from the file.` },
  'env-file': (v, fr) => fr
    ? { title: `Fichier d’environnement dans le dépôt : ${v.file}`, detail: 'Ces fichiers contiennent d’habitude des mots de passe et des clés.', fix: 'Retirez-le du dépôt, ajoutez-le à .gitignore et changez ce qu’il contenait : il reste dans l’historique de Git.' }
    : { title: `Environment file in the repository: ${v.file}`, detail: 'These files usually hold passwords and keys.', fix: 'Remove it from the repository, add it to .gitignore and change what it held: it stays in Git’s history.' },
};

export const findingText = (f: Finding, lang: string) => TEXTS[f.check]?.(f.vars, lang !== 'en') ?? { title: f.check, detail: '', fix: '' };

// ---- secrets: what a key of each service looks like. Google's public API keys (Firebase) are not secrets.

const SECRETS: [RegExp, string, Severity][] = [
  [/\bsk_live_[0-9a-zA-Z]{20,}/g, 'Stripe (live)', 'critical'],
  [/\brk_live_[0-9a-zA-Z]{20,}/g, 'Stripe (live, restricted)', 'high'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS', 'critical'],
  [/\bsk-ant-[a-z]{3,5}\d{2}-[\w-]{20,}/g, 'Anthropic', 'critical'],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/g, 'OpenAI', 'critical'],
  [/\bsk-proj-[A-Za-z0-9_-]{80,}/g, 'OpenAI', 'critical'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, 'GitHub', 'critical'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}/g, 'GitHub', 'critical'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack', 'high'],
  [/\bSG\.[\w-]{22}\.[\w-]{43}\b/g, 'SendGrid', 'high'],
  [/\b[0-9a-f]{32}-us\d{1,2}\b/g, 'Mailchimp', 'high'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, 'clé privée', 'critical'],
];
const mask = (s: string) => `${s.slice(0, 8)}… (${s.length})`;
// a placeholder (sk_live_xxxxxxxxxxxxxxxxxxxx) is not a key
const looksReal = (s: string) => s.startsWith('-----') || new Set(s.slice(8)).size >= 8;

function secretsIn(text: string): { kind: string; masked: string; severity: Severity }[] {
  const out = new Map<string, { kind: string; masked: string; severity: Severity }>();
  for (const [re, kind, severity] of SECRETS) for (const m of text.matchAll(re)) if (looksReal(m[0])) out.set(m[0], { kind, masked: mask(m[0]), severity });
  // Supabase: its public key is fine in a page; its service_role key bypasses every rule
  for (const m of text.matchAll(/\beyJ[\w-]{10,}\.(eyJ[\w-]{10,})\.[\w-]{20,}/g)) {
    try { if (JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')).role === 'service_role') out.set(m[0], { kind: 'Supabase service_role', masked: mask(m[0]), severity: 'critical' }); } catch {}
  }
  return [...out.values()];
}

// ---- the repository's files: GitHub's archive of the branch (or git archive, for a repository on this machine)

/** The commit of the site's branch and its files as a .tar.gz. */
async function snapshot(s: Site): Promise<{ sha: string; tgz: Buffer; strip: boolean }> {
  const repo = GH.repoOf(s.repo);
  if (repo) {
    const sha = await GH.headSha(repo, s.branch);
    return { sha, tgz: await GH.tarball(repo, sha), strip: true };
  }
  const sha = (await exec('git', ['-C', s.repo, 'rev-parse', s.branch])).stdout.trim();
  const out = await exec('git', ['-C', s.repo, 'archive', '--format=tar.gz', sha], { encoding: 'buffer', maxBuffer: 300 << 20 });
  return { sha, tgz: out.stdout as unknown as Buffer, strip: false };
}

const SKIP_DIR = /(^|\/)(node_modules|\.git|vendor|bower_components|\.cache|__pycache__)\//;
/** The text files of an archive (at most 1 MB each), by path. GitHub's archive puts everything under one top folder. */
function textFiles(tgz: Buffer, strip: boolean) {
  const tar = zlib.gunzipSync(tgz, { maxOutputLength: 1 << 30 });
  const files = new Map<string, string>();
  let long: string | null = null;
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every(b => b === 0)) break;
    const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { long = /(?:^|\n)\d+ path=([^\n]*)/.exec(body.toString('utf8'))?.[1] ?? null; continue; }
    if (type === 'L') { long = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    let name = long ?? (str(345, 155) ? `${str(345, 155)}/${str(0, 100)}` : str(0, 100));
    long = null;
    if (type !== '0' && type !== '\0') continue;
    if (strip) name = name.replace(/^[^/]+\//, '');
    if (!name || SKIP_DIR.test(name) || size > 1 << 20 || body.subarray(0, 1000).includes(0)) continue;
    files.set(name, body.toString('utf8'));
  }
  return files;
}

// ---- dependencies, from the lockfiles

interface Dep { eco: 'npm' | 'PyPI' | 'RubyGems'; name: string; version: string; dev: boolean; direct: boolean; file: string }

function depsOf(files: Map<string, string>): { deps: Dep[]; unlocked: string[] } {
  const deps = new Map<string, Dep>();
  const add = (d: Dep) => {
    const k = `${d.eco}:${d.name}@${d.version}`, had = deps.get(k);
    deps.set(k, had ? { ...had, dev: had.dev && d.dev, direct: had.direct || d.direct } : d);
  };
  const unlocked: string[] = [];
  for (const [file, text] of files) {
    const dir = file.includes('/') ? file.replace(/[^/]+$/, '') : '';
    const base = file.slice(dir.length);
    const pkg = (() => { try { return JSON.parse(files.get(`${dir}package.json`) || '{}'); } catch { return {}; } })();
    const direct = (n: string) => !!(pkg.dependencies?.[n] || pkg.devDependencies?.[n] || pkg.optionalDependencies?.[n]);
    try {
      if (base === 'package-lock.json') {
        const j = JSON.parse(text);
        if (j.packages) for (const [k, p] of Object.entries<any>(j.packages)) {
          if (!k || !p.version || p.link) continue;
          const name = p.name || k.slice(k.lastIndexOf('node_modules/') + 13);
          add({ eco: 'npm', name, version: p.version, dev: !!(p.dev || p.devOptional), direct: direct(name), file });
        } else {
          const walk = (o: any) => { for (const [name, p] of Object.entries<any>(o || {})) { add({ eco: 'npm', name, version: p.version, dev: !!p.dev, direct: direct(name), file }); walk(p.dependencies); } };
          walk(j.dependencies);
        }
      } else if (base === 'yarn.lock') {
        for (const block of text.split(/\n\s*\n/)) {
          const head = /^"?((?:@[^@\s"/]+\/)?[^@\s"]+)@/m.exec(block), v = /^\s+version:?\s+"?([^"\s]+)"?/m.exec(block);
          if (head && v) add({ eco: 'npm', name: head[1], version: v[1], dev: false, direct: direct(head[1]), file });
        }
      } else if (base === 'pnpm-lock.yaml') {
        const packages = text.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] || '';
        for (const m of packages.matchAll(/^ {2}['"]?\/?((?:@[^@/\s'"]+\/)?[^@/\s'"(]+)@(\d[^\s'"():]*)/gm))
          add({ eco: 'npm', name: m[1], version: m[2], dev: false, direct: direct(m[1]), file });
      } else if (/(^|\/)requirements[^/]*\.txt$/.test(file)) {
        for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([\w.]+)/gm)) add({ eco: 'PyPI', name: m[1], version: m[2], dev: false, direct: true, file });
      } else if (base === 'Gemfile.lock') {
        for (const m of text.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(([\w.]+)\)$/gm)) add({ eco: 'RubyGems', name: m[1], version: m[2], dev: false, direct: false, file });
      } else if (base === 'package.json' && !['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lockb', 'bun.lock'].some(l => files.has(dir + l))) {
        if (Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length) unlocked.push(file);
      }
    } catch {}
  }
  return { deps: [...deps.values()], unlocked };
}

// ---- the advisories: OSV.dev for what affects each dependency, CISA's catalogue for what attackers use now

export interface Advisory { id: string; summary: string; severity: Severity; aliases: string[]; published: string | null; modified: string | null;
  url: string; fixed: Record<string, string[]>; malicious: boolean; fetched: string }

const SEV: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };

async function osvBatch(deps: Dep[]): Promise<string[][]> {
  const out: string[][] = [];
  for (let i = 0; i < deps.length; i += 500) {
    const part = deps.slice(i, i + 500);
    const res = await fetch('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ queries: part.map(d => ({ package: { name: d.name, ecosystem: d.eco }, version: d.version })) }) });
    if (!res.ok) throw new Error(`OSV : ${res.status}`);
    const j: any = await res.json();
    out.push(...part.map((_, k) => (j.results?.[k]?.vulns || []).map((v: any) => v.id as string)));
  }
  return out;
}

/** An advisory, from the cache or OSV.dev; read again after a week (they get fixed versions and scores later). */
async function advisory(id: string): Promise<Advisory | null> {
  const had = await db.get<Advisory>('advisories', id);
  if (had && Date.now() - Date.parse(had.fetched) < ADVISORY_DAYS * DAY) return had;
  const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return had;
  const v: any = await res.json();
  if (v.withdrawn) { await db.remove('advisories', id); return null; }
  const fixed: Record<string, string[]> = {};
  for (const a of v.affected || []) for (const r of a.ranges || []) for (const e of r.events || [])
    if (e.fixed && a.package?.name) (fixed[`${a.package.ecosystem}:${a.package.name}`] ??= []).push(e.fixed);
  const adv: Advisory = {
    id, summary: String(v.summary || v.details || '').split('\n')[0].slice(0, 200), aliases: v.aliases || [],
    severity: id.startsWith('MAL-') ? 'critical' : SEV[String(v.database_specific?.severity || '').toUpperCase()] ?? 'medium',
    published: v.published || null, modified: v.modified || null, url: `https://osv.dev/vulnerability/${id}`, fixed, malicious: id.startsWith('MAL-'), fetched: now(),
  };
  await db.set('advisories', id, adv as any);
  return adv;
}

let kev: { ids: Set<string>; at: number } | null = null;
async function kevIds() {
  if (kev && Date.now() - kev.at < DAY) return kev.ids;
  const doc = await db.get('platform', 'kev');
  if (doc && Date.now() - Date.parse(doc.fetched) < DAY) return (kev = { ids: new Set(doc.ids), at: Date.parse(doc.fetched) }).ids;
  try {
    const res = await fetch('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', { signal: AbortSignal.timeout(30_000) });
    const ids: string[] = (await res.json() as any).vulnerabilities.map((v: any) => v.cveID);
    await db.set('platform', 'kev', { ids, fetched: now() });
    return (kev = { ids: new Set(ids), at: Date.now() }).ids;
  } catch { return new Set<string>(doc?.ids || []); }
}

const parts = (v: string) => v.split(/[.+-]/).map(x => parseInt(x, 10) || 0);
const cmp = (a: string, b: string) => { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const LOWER: Record<Severity, Severity> = { critical: 'high', high: 'medium', medium: 'low', low: 'low', info: 'info' };

async function depFindings(files: Map<string, string>): Promise<Finding[]> {
  const { deps, unlocked } = depsOf(files);
  const out: Finding[] = unlocked.map(file => ({ key: `no-lock:${file}`, check: 'no-lock', section: 'deps', severity: 'low', vars: { file } }));
  if (!deps.length) return out;
  const hits = await osvBatch(deps);
  const exploited = await kevIds();
  for (const [i, d] of deps.entries()) {
    if (!hits[i].length) continue;
    const advs = (await Promise.all(hits[i].map(advisory))).filter((a): a is Advisory => !!a);
    // one flaw is often published under several ids (GHSA, CVE, PYSEC): kept once
    // the worst first, those attackers use right now before all: its summary is the one shown
    const used = (a: Advisory) => a.aliases.some(x => exploited.has(x));
    const kept = advs.filter((a, k) => !advs.some((b, j) => j < k && (b.aliases.includes(a.id) || a.aliases.includes(b.id))))
      .sort((a, b) => Number(used(b)) - Number(used(a)) || ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
    if (!kept.length) continue;
    const isKev = kept.some(used);
    const malicious = kept.some(a => a.malicious);
    const worst = ORDER[Math.min(...kept.map(a => ORDER.indexOf(a.severity)))];
    // the lowest version that fixes every advisory: for each one, its first fixed version above the one in use
    const need = kept.map(a => (a.fixed[`${d.eco}:${d.name}`] || []).filter(f => cmp(f, d.version) > 0).sort(cmp)[0]);
    const fixed = need.every(Boolean) ? need.sort(cmp).at(-1)! : null;
    out.push({ key: `dep:${d.eco}:${d.name}@${d.version}`, check: 'dep', section: 'deps',
      severity: isKev || malicious ? 'critical' : d.dev ? LOWER[worst] : worst,
      vars: { eco: d.eco, name: d.name, version: d.version, file: d.file, dev: d.dev, direct: d.direct, fixed, kev: isKev, malicious,
        ids: kept.map(a => a.id), summary: kept[0].summary } });
  }
  return out;
}

function repoFindings(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    if (/(^|\/)\.env(\.[\w-]+)?$/.test(file) && !/\.(example|sample|template|dist|defaults?)$/.test(file))
      out.push({ key: `env-file:${file}`, check: 'env-file', section: 'repo', severity: 'high', vars: { file } });
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file)) continue;
    for (const x of secretsIn(text)) out.push({ key: `repo-secret:${file}:${x.masked}`, check: 'repo-secret', section: 'repo', severity: x.severity, vars: { kind: x.kind, file, masked: x.masked } });
  }
  return out.slice(0, 50);
}

// ---- the live site

const PROBES: { path: string; severity: Severity; what: string; what_en: string; sig: RegExp }[] = [
  { path: '/.env', severity: 'critical', what: 'Le fichier de configuration (.env), avec ses mots de passe', what_en: 'The configuration file (.env), with its passwords', sig: /^\s*[A-Z][A-Z0-9_]{2,}\s*=.+/m },
  { path: '/.git/config', severity: 'critical', what: 'Le dépôt Git du site, tout son code et son historique', what_en: 'The site’s Git repository, all its code and history', sig: /\[(core|remote)[^\]]*\]/ },
  { path: '/.git/HEAD', severity: 'critical', what: 'Le dépôt Git du site, tout son code et son historique', what_en: 'The site’s Git repository, all its code and history', sig: /^ref: refs\//m },
  { path: '/serviceAccountKey.json', severity: 'critical', what: 'Une clé de compte de service Google', what_en: 'A Google service account key', sig: /"private_key"/ },
  { path: '/id_rsa', severity: 'critical', what: 'Une clé SSH privée', what_en: 'A private SSH key', sig: /BEGIN (RSA|OPENSSH) PRIVATE KEY/ },
  { path: '/backup.sql', severity: 'critical', what: 'Une copie de base de données', what_en: 'A database dump', sig: /CREATE TABLE|INSERT INTO/i },
  { path: '/dump.sql', severity: 'critical', what: 'Une copie de base de données', what_en: 'A database dump', sig: /CREATE TABLE|INSERT INTO/i },
  { path: '/wp-config.php.bak', severity: 'critical', what: 'Une copie de la configuration WordPress', what_en: 'A copy of the WordPress configuration', sig: /DB_PASSWORD/ },
  { path: '/.npmrc', severity: 'high', what: 'Le fichier .npmrc, qui peut contenir des jetons', what_en: 'The .npmrc file, which may hold tokens', sig: /_authToken|registry\s*=/ },
  { path: '/.htpasswd', severity: 'high', what: 'Le fichier des mots de passe du serveur', what_en: 'The server’s password file', sig: /^[^:\s]+:(\$apr1\$|\{SHA\}|\$2[aby]\$)/m },
  { path: '/phpinfo.php', severity: 'medium', what: 'La page phpinfo(), qui décrit tout le serveur', what_en: 'The phpinfo() page, which describes the whole server', sig: /PHP Version|phpinfo\(\)/ },
  { path: '/firebase-debug.log', severity: 'medium', what: 'Un journal de Firebase', what_en: 'A Firebase log', sig: /\[debug\]|firebase/i },
  { path: '/.DS_Store', severity: 'low', what: 'Un fichier .DS_Store, qui liste les fichiers du dossier', what_en: 'A .DS_Store file, which lists the folder’s files', sig: /Bud1/ },
];

const PLATFORM = /(^|\.)(netlify\.app|vercel\.app|github\.io|pages\.dev|web\.app|firebaseapp\.com|hostingersite\.com|onrender\.com|herokuapp\.com|surge\.sh|azurestaticapps\.net|localhost)$/i;
const registrable = (host: string) => {
  const p = host.split('.');
  return p.slice(p.length > 2 && /^(co|com|org|net|ac|gov|edu)$/.test(p.at(-2)!) && p.at(-1)!.length === 2 ? -3 : -2).join('.');
};

async function liveFindings(s: Site, files: Map<string, string> | null, doc: SecurityDoc): Promise<{ findings: Finding[]; scripts: string[] | null; ok: boolean }> {
  const out: Finding[] = [];
  const f = (check: string, severity: Severity, vars: Record<string, any> = {}, subject = '') => out.push({ key: `${check}${subject ? `:${subject}` : ''}`, check, section: 'live', severity, vars });
  const home = await fetchWithHeaders(s.liveUrl, { max: 2 << 20 });
  if (!home?.status || home.status >= 500) { f('unreachable', 'info'); return { findings: out, scripts: null, ok: false }; }
  const base = new URL(home.url), h = home.headers, html = home.body;
  const https = base.protocol === 'https:';

  if (!https) f('https', 'high');
  else {
    const plain = await fetchWithHeaders(`http://${base.host}/`, { follow: false, timeout: 8_000, max: 4096 });
    if (plain?.status && !plain.location?.startsWith('https://')) f('http-redirect', 'medium');
    const hsts = String(h['strict-transport-security'] || ''), age = Number(/max-age=(\d+)/i.exec(hsts)?.[1] || 0);
    if (!hsts) f('hsts', 'medium');
    else if (age < 15_552_000) f('hsts', 'low', { short: true, age });
  }
  const csp = String(h['content-security-policy'] || '');
  if (!csp) f('csp', 'low');
  if (String(h['x-content-type-options'] || '').toLowerCase() !== 'nosniff') f('nosniff', 'low');
  if (!h['x-frame-options'] && !/frame-ancestors/i.test(csp)) f('frame', 'low');
  const banner = [h['server'], h['x-powered-by']].map(x => String(x || '')).find(x => /\d+\.\d+/.test(x));
  if (banner) f('server-version', 'low', { value: banner.slice(0, 60) });
  for (const c of [h['set-cookie'] || []].flat()) {
    const name = c.split('=')[0].trim(), missing = [https && !/;\s*secure/i.test(c) && 'Secure', !/;\s*httponly/i.test(c) && /sess|auth|token|sid|login/i.test(name) && 'HttpOnly'].filter(Boolean);
    if (missing.length) f('cookie', 'medium', { name, missing }, name);
  }
  if (https) for (const m of html.matchAll(/<(?:script|iframe|img|link)\b[^>]*\b(?:src|href)=["'](http:\/\/[^"']+)["']/gi))
    if (!/<link\b(?![^>]*stylesheet)/i.test(m[0])) { f('mixed', 'medium', { url: m[1].slice(0, 120) }, m[1]); if (out.filter(x => x.check === 'mixed').length >= 3) break; }

  // the scripts: those of the site are read for keys; the hosts of the others are compared with earlier checks
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => { try { return new URL(m[1], base); } catch { return null; } }).filter((u): u is URL => !!u);
  const own = srcs.filter(u => u.host === base.host).slice(0, 15);
  const hosts = [...new Set(srcs.filter(u => u.host !== base.host && /^https?:$/.test(u.protocol)).map(u => u.hostname))];
  const scripts = [{ where: base.pathname, text: html }];
  for (const u of own) { const r = await fetchWithHeaders(u.toString(), { max: 3 << 20, timeout: 10_000 }); if (r?.status === 200) scripts.push({ where: u.pathname, text: r.body }); }
  for (const sc of scripts) for (const x of secretsIn(sc.text)) f('js-secret', x.severity, { kind: x.kind, where: sc.where, masked: x.masked }, x.masked);

  const allText = files ? [...files.values()] : [];
  const inRepo = (needle: string) => !!files && allText.some(t => t.includes(needle));
  let known = doc.scripts;
  if (known) for (const host of hosts) {
    if (known.includes(host)) continue;
    if (inRepo(host) || !files) known = [...known, host];   // in the repository: someone put it there on purpose
    else f('new-script', 'high', { host }, host);
  }
  else known = hosts;   // the first check sets what the site normally loads

  // probes beyond the page: only on a site ClaudePress knows is built from this repository
  // the title's parts, as sites build it ("Page – Business"): one of 8 characters or more must be in the files
  const title = /<title[^>]*>([^<]{4,})<\/title>/i.exec(html)?.[1] ?? '';
  const named = title.split(/\s+[–—|·:-]\s+/).map(x => x.trim()).filter(x => x.length >= 8);
  const owned = !!(await db.get('golive', s.id))?.seen_live || named.some(inRepo);
  if (!owned) f('unverified', 'info');
  else {
    for (const p of PROBES) {
      const r = await fetchWithHeaders(new URL(p.path, base).toString(), { follow: false, max: 65_536, timeout: 8_000 });
      if (r?.status === 200 && p.sig.test(r.body) && !out.some(x => x.check === 'exposed' && x.vars.what === p.what)) f('exposed', p.severity, { path: p.path, what: p.what, what_en: p.what_en }, p.path);
    }
    for (const sc of scripts.slice(1)) {
      const map = /\/\/[#@] sourceMappingURL=([^\s'"]+\.map)/.exec(sc.text)?.[1];
      if (!map) continue;
      const u = new URL(map, new URL(sc.where, base)).toString(), r = await fetchWithHeaders(u, { max: 4096, timeout: 8_000 });
      if (r?.status === 200 && /"mappings"|"sources"/.test(r.body)) { f('sourcemap', 'low', { url: new URL(u).pathname }); break; }
    }
    out.push(...await firebaseFindings(scripts.map(x => x.text).join('\n')));
  }
  return { findings: out, scripts: known, ok: true };
}

/** Read-only questions to the site's own Firebase backend, as a visitor who is not signed in. */
async function firebaseFindings(text: string): Promise<Finding[]> {
  const pick = (k: string) => new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']{3,})["']`).exec(text)?.[1];
  const project = pick('projectId');
  if (!project || !/^[a-z][a-z0-9-]{3,}$/.test(project) || !/AIza/.test(text)) return [];
  const out: Finding[] = [];
  const get = (url: string, init: RequestInit = {}) => fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const fs = await get(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:listCollectionIds`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  if (fs?.status === 200) {
    let names = ''; try { names = ((await fs.json() as any).collectionIds || []).slice(0, 6).join(', '); } catch {}
    out.push({ key: 'firestore-open', check: 'firestore-open', section: 'live', severity: 'critical', vars: { project, names } });
  }
  const rtdb = pick('databaseURL');
  if (rtdb && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)\/?$/.test(rtdb)) {
    const r = await get(`${rtdb.replace(/\/$/, '')}/.json?shallow=true`);
    if (r?.status === 200) out.push({ key: 'rtdb-open', check: 'rtdb-open', section: 'live', severity: 'critical', vars: { url: rtdb } });
  }
  const bucket = pick('storageBucket');
  if (bucket && /^[a-z0-9.-]+$/.test(bucket)) {
    const r = await get(`https://firebasestorage.googleapis.com/v0/b/${bucket}/o?maxResults=1`);
    if (r?.status === 200) out.push({ key: 'storage-open', check: 'storage-open', section: 'live', severity: 'high', vars: { bucket } });
  }
  return out;
}

async function domainFindings(s: Site): Promise<Finding[]> {
  const host = new URL(s.liveUrl).hostname;
  if (net.isIP(host) || PLATFORM.test(host) || !host.includes('.')) return [];
  const domain = registrable(host);
  const out: Finding[] = [];
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, { signal: AbortSignal.timeout(15_000) });
    const exp = r.ok ? ((await r.json() as any).events || []).find((e: any) => e.eventAction === 'expiration')?.eventDate : null;
    const days = exp ? Math.floor((Date.parse(exp) - Date.now()) / DAY) : null;
    if (days !== null && days <= 30) out.push({ key: 'domain-expiry', check: 'domain-expiry', section: 'domain', severity: days <= 7 ? 'critical' : 'high', vars: { domain, days: Math.max(0, days), date: exp.slice(0, 10) } });
  } catch {}
  const mx = await dns.resolveMx(domain).catch(() => []);
  if (mx.length) {
    const txt = (await dns.resolveTxt(domain).catch(() => [])).map(x => x.join(''));
    if (!txt.some(t => /^v=spf1\b/i.test(t))) out.push({ key: 'spf', check: 'spf', section: 'domain', severity: 'medium', vars: { domain } });
    const dmarc = (await dns.resolveTxt(`_dmarc.${domain}`).catch(() => [])).map(x => x.join('')).find(t => /^v=DMARC1/i.test(t));
    if (!dmarc) out.push({ key: 'dmarc', check: 'dmarc', section: 'domain', severity: 'medium', vars: { domain } });
    else if (/;\s*p=none/i.test(dmarc)) out.push({ key: 'dmarc', check: 'dmarc', section: 'domain', severity: 'low', vars: { domain, none: true } });
  }
  return out;
}

// ---- who is covered: every site of an account with the add-on (or a plan that includes it), every site of a
// self-hosted server; looked up again every two minutes, or at once when the account changes it

const covers = new Map<string, { on: boolean; at: number }>();
async function covered(orgId: string | null | undefined) {
  if (!orgId) return !hosted();
  const c = covers.get(orgId);
  if (c && Date.now() - c.at < 120_000) return c.on;
  const on = securityOn(await orgOf(orgId));
  covers.set(orgId, { on, at: Date.now() });
  return on;
}
export const forgetSecurity = (orgId: string) => covers.delete(orgId);

// ---- a check

const grade = (score: number) => score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
const counted = (d: SecurityDoc) => d.findings.filter(f => !f.fixed && !d.accepted[f.key] && f.severity !== 'info');
const running = new Map<string, Promise<void>>();

/** Checks one site now; `auto` for the daily check of a covered site, else a check asked by an administrator. */
export function checkSite(siteId: string, auto = false): Promise<void> {
  const s = siteAnyState(siteId);
  if (!s) return Promise.resolve();
  const was = running.get(siteId);
  if (was) return was;
  const p = run(s, auto).catch(e => console.error(`[security] ${siteId}:`, e)).finally(() => running.delete(siteId));
  running.set(siteId, p);
  return p;
}

async function run(s: Site, auto: boolean) {
  const doc = await docOf(s);
  const paid = await covered(s.orgId);
  let files: Map<string, string> | null = null, sha: string | null = null, error: string | null = null;
  try {
    const snap = await snapshot(s);
    sha = snap.sha;
    if (paid) await backup(s, snap.sha, snap.tgz).catch(e => console.error(`[security] ${s.id}: backup failed:`, (e as Error).message));
    files = textFiles(snap.tgz, snap.strip);
  } catch (e) { error = `Dépôt illisible : ${(e as Error).message.slice(0, 200)}`; }

  // each part on its own: a part that could not run keeps what it found last time, rather than calling it fixed
  const before = doc.findings.filter(f => !f.fixed);
  const keep = (section: Section) => before.filter(f => f.section === section);
  const live = await liveFindings(s, files, doc).catch(() => ({ findings: [], scripts: doc.scripts, ok: false }));
  const parts = await Promise.all([
    domainFindings(s).catch(() => keep('domain')),
    files ? depFindings(files).catch(e => { error ??= `Avis de sécurité indisponibles : ${(e as Error).message}`; return keep('deps'); }) : keep('deps'),
    files ? repoFindings(files) : keep('repo'),
  ]);
  const found = [...(live.ok ? live.findings : [...keep('live'), ...live.findings]), ...parts.flat()];
  // the same key once (the part kept from last time may overlap the new one)
  const current = [...new Map(found.map(f => [f.key, f])).values()];
  const prev = new Map(before.map(f => [f.key, f]));
  for (const f of current) { f.first = prev.get(f.key)?.first ?? now(); f.fixed = null; }
  const fixedNow = before.filter(f => !current.some(c => c.key === f.key)).map(f => ({ ...f, fixed: now() }));
  const oldFixed = doc.findings.filter(f => f.fixed && Date.now() - Date.parse(f.fixed) < KEEP_FIXED_DAYS * DAY && !current.some(c => c.key === f.key));
  const first = !doc.checked;
  const fresh = current.filter(f => !prev.has(f.key) && !doc.accepted[f.key] && f.severity !== 'info');

  Object.assign(doc, { org_id: s.orgId ?? null, checked: now(), sha, error, auto, scripts: live.scripts ?? doc.scripts,
    findings: [...current, ...fixedNow, ...oldFixed].slice(0, 200) });
  // a site whose live address did not answer, with nothing known of it from before, gets no grade: an A would be a lie
  if (!live.ok && !keep('live').some(f => f.check !== 'unreachable')) Object.assign(doc, { score: null, grade: null, error: error ?? 'Le site en ligne n’a pas répondu : sa note sera donnée à la prochaine vérification.' });
  else { const score = Math.max(0, 100 - counted(doc).reduce((t, f) => t + WEIGHT[f.severity], 0)); Object.assign(doc, { score, grade: grade(score) }); }
  await db.set('security', s.id, { ...doc });
  if (paid && !first && (fresh.length || fixedNow.length)) await tell(s, doc, fresh, fixedNow);
  else if (first) await tellFirst(s, doc);
}

// ---- backups: the repository's files each time they changed, kept 90 days (the last one always)

async function backup(s: Site, sha: string, tgz: Buffer) {
  const list = (await db.find('security_backups', { site_id: s.id })).sort((a, b) => b.at.localeCompare(a.at));
  if (list[0]?.sha !== sha) {
    const file = `backups/${s.id}/${now().slice(0, 10)}-${sha.slice(0, 10)}.tar.gz`;
    await db.putFile(file, tgz);
    await db.set('security_backups', newId(14), { site_id: s.id, org_id: s.orgId ?? null, sha, at: now(), size: tgz.length, file });
  }
  for (const b of list.slice(list[0]?.sha === sha ? 1 : 0)) {
    if (Date.now() - Date.parse(b.at) < KEEP_BACKUP_DAYS * DAY) continue;
    await db.removeFile(b.file).catch(() => {});
    await db.remove('security_backups', b.id);
  }
}

/** One backup's file, for its download. */
export async function backupFile(siteId: string, backupId: string) {
  const b = await db.get('security_backups', backupId);
  if (!b || b.site_id !== siteId) return null;
  const data = await db.getFile(b.file);
  return data ? { data, name: `${siteId}-${b.at.slice(0, 10)}-${b.sha.slice(0, 7)}.tar.gz` } : null;
}

// ---- alerts: in the app for every new finding or fix; by e-mail when something high or critical is new

type Lang = 'fr' | 'en';
const admins = async (s: Site) => s.orgId ? db.find('users', { agency: 1, active: 1, org_id: s.orgId }) : db.find('users', { agency: 1, active: 1 });

async function tell(s: Site, doc: SecurityDoc, fresh: Finding[], fixed: Finding[]) {
  const people = await admins(s);
  const link = `#/admin/site/${s.id}`;
  const worst = fresh.filter(f => f.severity === 'critical' || f.severity === 'high');
  const notice = [fresh.length ? `Sécurité de ${s.name} : ${fresh.length} nouveau(x) point(s) à corriger${worst.length ? `, dont ${worst.length} important(s) : ${findingText(worst[0], 'fr').title}` : ''}.` : '',
    fixed.length ? `${fixed.length} point(s) corrigé(s) sur ${s.name}.` : ''].filter(Boolean).join(' ');
  await notify(people.map(p => p.id), null, notice, link);
  if (!worst.length || !mailOn()) return;
  const org = await orgOf(s.orgId), brand = brandOf(org);
  const agency = brand?.name || org?.name || config.agencyName || 'ClaudePress';
  for (const p of people) {
    const lang: Lang = p.lang === 'en' ? 'en' : 'fr', fr = lang === 'fr';
    const lines = worst.slice(0, 5).map(f => { const t = findingText(f, lang); return `• ${t.title}. ${t.detail}`; });
    const { html, text } = layout([
      fr ? `La vérification de sécurité de ${s.name} a trouvé ${worst.length} problème(s) important(s) :` : `The security check of ${s.name} found ${worst.length} serious problem(s):`,
      ...lines, fr ? 'Chacun vient avec la façon de le corriger.' : 'Each one comes with how to fix it.'],
      { label: fr ? 'Voir la sécurité du site' : 'See the site’s security', url: `${origin()}/${link}` },
      [fr ? `Vérification quotidienne de ${s.liveUrl.replace(/^https?:\/\/|\/$/g, '')}, note ${doc.grade}.` : `Daily check of ${s.liveUrl.replace(/^https?:\/\/|\/$/g, '')}, grade ${doc.grade}.`],
      brand?.color || '#ea580c', fr ? ' : ' : ': ');
    await sendMail({ to: p.email, subject: fr ? `🔴 Sécurité de ${s.name} : ${worst.length} problème(s) important(s)` : `🔴 ${s.name} security: ${worst.length} serious problem(s)`, html, text, fromName: agency });
  }
}

async function tellFirst(s: Site, doc: SecurityDoc) {
  const n = counted(doc).length;
  if (!doc.grade) return;
  await notify((await admins(s)).map(p => p.id), null, `Vérification de sécurité de ${s.name} terminée : note ${doc.grade}, ${n ? `${n} point(s) à corriger` : 'rien à corriger'}.`, `#/admin/site/${s.id}`);
}

// ---- the timer

let ticking: Promise<number> | null = null;
/** Starts the daily checks that are due, a few per tick (they take a minute or two each). */
export function securityTick() {
  return ticking ??= (async () => {
    try {
      const due: Site[] = [];
      for (const s of allSites()) {
        if (s.status !== 'ready' || !/^https?:\/\//.test(s.liveUrl || '') || running.has(s.id) || !(await covered(s.orgId))) continue;
        const d = await db.get<SecurityDoc>('security', s.id);
        if (!d?.checked || Date.now() - Date.parse(d.checked) >= DAY - 5 * 60_000) due.push(s);
        if (due.length >= PER_TICK) break;
      }
      const queue = [...due];
      await Promise.all(Array.from({ length: AT_ONCE }, async () => { for (let s = queue.shift(); s; s = queue.shift()) await checkSite(s.id, true); }));
      return due.length;
    } finally { ticking = null; }
  })();
}

export function startSecurity() {
  const go = () => securityTick().catch(e => console.error('[security]', e));
  setTimeout(go, 60_000);
  setInterval(go, 5 * 60_000);
}

// ---- what the screens show

const bySeverity = (a: Finding, b: Finding) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity);
const counts = (list: Finding[]) => Object.fromEntries(ORDER.slice(0, 4).map(k => [k, list.filter(f => f.severity === k).length]));

/** When this site may be checked again on request: now, or a date. */
async function nextCheck(s: Site, d: SecurityDoc | null) {
  if (!d?.checked) return null;
  const at = Date.parse(d.checked) + ((await covered(s.orgId)) ? AGAIN_PAID : AGAIN_FREE);
  return at > Date.now() ? new Date(at).toISOString() : null;
}

/** A site's security as its page shows it, in the reader's language. */
export async function securityView(siteId: string, lang: string) {
  const s = siteAnyState(siteId)!;
  const d = await db.get<SecurityDoc>('security', siteId);
  const show = (f: Finding) => ({ key: f.key, check: f.check, severity: f.severity, first: f.first, fixed: f.fixed || null,
    accepted: d!.accepted[f.key] ? { at: d!.accepted[f.key].at } : null, ...findingText(f, lang),
    advisories: f.check === 'dep' ? f.vars.ids.map((id: string) => ({ id, url: `https://osv.dev/vulnerability/${id}` })) : undefined });
  const backups = (await db.find('security_backups', { site_id: siteId })).sort((a, b) => b.at.localeCompare(a.at)).map(b => ({ id: b.id, at: b.at, sha: b.sha, size: b.size }));
  return {
    name: s.name, url: s.liveUrl, covered: await covered(s.orgId), running: running.has(siteId), next: await nextCheck(s, d),
    checked: d?.checked ?? null, auto: !!d?.auto, score: d?.score ?? null, grade: d?.grade ?? null, error: d?.error ?? null,
    counts: d ? counts(counted(d)) : null,
    open: d ? d.findings.filter(f => !f.fixed && !d.accepted[f.key]).sort(bySeverity).map(show) : [],
    accepted: d ? d.findings.filter(f => !f.fixed && d.accepted[f.key]).sort(bySeverity).map(show) : [],
    fixed: d ? d.findings.filter(f => f.fixed).sort((a, b) => b.fixed!.localeCompare(a.fixed!)).slice(0, 20).map(show) : [],
    backups,
  };
}

/** The short state for lists of sites: grade and what is open; null before the first check. */
export async function securityState(siteId: string) {
  const d = await db.get<SecurityDoc>('security', siteId);
  return d?.checked ? { grade: d.grade, score: d.score, checked: d.checked, counts: counts(counted(d)) } : null;
}

/**
 * Every site of an account, then the bulletin: the advisories that affect its sites, newest first, each with the
 * sites and versions it touches and the version that fixes it.
 */
export async function securityOverview(orgId: string) {
  const sites = allSites().filter(s => s.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
  const docs = new Map((await Promise.all(sites.map(s => db.get<SecurityDoc>('security', s.id)))).filter(Boolean).map(d => [d!.site_id, d!]));
  const exploited = await kevIds().catch(() => new Set<string>());
  const bulletin = new Map<string, any>();
  for (const s of sites) {
    const d = docs.get(s.id);
    for (const f of d ? d.findings.filter(x => x.check === 'dep' && !x.fixed) : []) for (const id of f.vars.ids) {
      const a = await db.get<Advisory>('advisories', id);
      if (!a) continue;
      // one attackers use right now is critical, whatever score it was published with (as the sites' findings say)
      const kev = a.aliases.some(x => exploited.has(x));
      const e = bulletin.get(id) ?? { id, summary: a.summary, severity: kev || a.malicious ? 'critical' : a.severity, published: a.published, url: a.url, malicious: a.malicious,
        kev, cve: a.aliases.find(x => x.startsWith('CVE-')) ?? null, sites: [] };
      e.sites.push({ id: s.id, name: s.name, pkg: f.vars.name, version: f.vars.version, fixed: f.vars.fixed, accepted: !!d!.accepted[f.key] });
      bulletin.set(id, e);
    }
  }
  return {
    covered: await covered(orgId),
    sites: await Promise.all(sites.map(async s => {
      const d = docs.get(s.id);
      return { id: s.id, name: s.name, url: s.liveUrl, running: running.has(s.id), checked: d?.checked ?? null, grade: d?.grade ?? null, score: d?.score ?? null,
        counts: d ? counts(counted(d)) : null, next: await nextCheck(s, d ?? null),
        backup: (await db.find('security_backups', { site_id: s.id })).reduce((m, b) => !m || b.at > m ? b.at : m, null as string | null) };
    })),
    bulletin: [...bulletin.values()].sort((a, b) => (Number(b.kev) - Number(a.kev)) || bySeverity(a, b) || String(b.published).localeCompare(String(a.published))),
  };
}

/** A check asked for: refused while one runs, or before the site may be checked again. */
export async function askCheck(siteId: string) {
  const s = siteAnyState(siteId)!;
  if (running.has(siteId)) return;
  const next = await nextCheck(s, await db.get<SecurityDoc>('security', siteId));
  if (next) throw new Error((await covered(s.orgId)) ? 'Ce site vient d’être vérifié : réessayez dans quelques minutes.'
    : 'Sans l’option Sécurité, un site se vérifie une fois par jour. Avec elle, chaque jour automatiquement et à la demande.');
  checkSite(siteId);
}

/** A finding accepted (it no longer counts nor alerts) or counted again. */
export async function acceptFinding(siteId: string, key: string, on: boolean, by: string) {
  const d = await db.get<SecurityDoc>('security', siteId);
  if (!d?.findings.some(f => f.key === key)) throw new Error('Ce point n’existe plus.');
  const accepted = { ...d.accepted };
  if (on) accepted[key] = { by, at: now() }; else delete accepted[key];
  const score = Math.max(0, 100 - counted({ ...d, accepted }).reduce((t, f) => t + WEIGHT[f.severity], 0));
  await db.update('security', siteId, d.grade ? { accepted, score, grade: grade(score) } : { accepted });
}

/** A site removed: its checks and backups go with it. */
export async function dropSecurity(siteId: string) {
  for (const b of await db.find('security_backups', { site_id: siteId })) { await db.removeFile(b.file).catch(() => {}); await db.remove('security_backups', b.id); }
  await db.remove('security', siteId);
}
