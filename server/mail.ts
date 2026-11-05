// E-mails to people: invitations and new access. Sent through Resend (config.mail.resendKey or RESEND_API_KEY);
// without a key nothing is sent and the administrator gets the link to pass on themselves.
import { config } from './config.ts';

const key = () => config.mail?.resendKey || process.env.RESEND_API_KEY || '';
export const mailOn = () => !!key() && !!config.mail?.from;

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Sends one e-mail; false when it could not leave (no key, or Resend refused it): the caller then shows the link instead. */
export async function sendMail(m: { to: string; subject: string; text: string; html: string; fromName?: string; replyTo?: string }) {
  if (!mailOn()) return false;
  const from = config.mail!.from;
  // "Agence Dupont <invite@claudepress.org>": the agency's name, the server's verified address
  const sender = m.fromName ? `${m.fromName.replace(/[<>"]/g, '')} <${from.replace(/^.*<|>.*$/g, '')}>` : from;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sender, to: [m.to], subject: m.subject, text: m.text, html: m.html, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error('mail: Resend refused', r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) { console.error('mail: not sent', String(e)); return false; }
}

type Lang = 'fr' | 'en';
const T = {
  fr: {
    inviteSubject: (agency: string, site: string) => `${agency} vous invite à modifier ${site}`,
    inviteHello: (name: string) => `Bonjour ${name},`,
    inviteBody: (agency: string, site: string, on: string) => `${agency} vous donne accès à votre site ${site}${on ? ` sur ${on}` : ''}. Vous y changez vos textes et vos photos en demandant simplement ce que vous voulez, et vous voyez le résultat avant qu’il soit en ligne.`,
    inviteStep: (google: boolean) => `Cliquez sur le bouton pour créer votre accès : vous choisissez votre mot de passe${google ? ' (ou vous continuez avec Google)' : ''}, et vous êtes dans votre site.`,
    inviteButton: 'Créer mon accès',
    inviteExpires: (days: number) => `Ce lien est personnel et reste valable ${days} jours.`,
    accessSubject: (agency: string, site: string) => `${agency} vous donne accès à ${site}`,
    accessBody: (agency: string, site: string) => `${agency} vous donne accès au site ${site}. Connectez-vous avec votre adresse habituelle : il apparaît dans vos sites.`,
    accessButton: 'Ouvrir mon site',
    colon: ' : ',
    question: (agency: string) => `Une question ? Répondez à cet e-mail : il arrive chez ${agency}.`,
  },
  en: {
    inviteSubject: (agency: string, site: string) => `${agency} invites you to edit ${site}`,
    inviteHello: (name: string) => `Hello ${name},`,
    inviteBody: (agency: string, site: string, on: string) => `${agency} is giving you access to your website ${site}${on ? ` on ${on}` : ''}. You change your texts and photos by simply asking for what you want, and you see the result before it goes live.`,
    inviteStep: (google: boolean) => `Click the button to create your access: you choose your password${google ? ' (or continue with Google)' : ''}, and you are in your site.`,
    inviteButton: 'Create my access',
    inviteExpires: (days: number) => `This link is personal and stays valid for ${days} days.`,
    accessSubject: (agency: string, site: string) => `${agency} gives you access to ${site}`,
    accessBody: (agency: string, site: string) => `${agency} is giving you access to the website ${site}. Sign in with your usual address: it is in your sites.`,
    accessButton: 'Open my site',
    colon: ': ',
    question: (agency: string) => `A question? Reply to this e-mail: it goes to ${agency}.`,
  },
};

/** A plain e-mail: a few paragraphs and one button, in the agency's colour. */
export function layout(paragraphs: string[], button: { label: string; url: string }, after: string[], color: string, colon: string) {
  const p = (t: string) => `<p style="margin:0 0 16px;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2a1d14">${esc(t)}</p>`;
  const html = `<div style="max-width:520px;margin:0 auto;padding:24px">${paragraphs.map(p).join('')}
    <p style="margin:24px 0"><a href="${esc(button.url)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:${esc(color)};color:#fff;text-decoration:none;font:600 16px -apple-system,Segoe UI,Helvetica,Arial,sans-serif">${esc(button.label)}</a></p>
    ${after.map(t => `<p style="margin:0 0 8px;font:13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#7a6a5e">${esc(t)}</p>`).join('')}</div>`;
  const text = [...paragraphs, `${button.label}${colon}${button.url}`, ...after].join('\n\n');
  return { html, text };
}

/** `whiteLabel`: the agency shows its own name, so the e-mail does not name ClaudePress. */
interface From { agency: string; color?: string | null; replyTo?: string; lang: Lang; whiteLabel?: boolean }

/** The invitation of someone new: one link to create their access. */
export function sendInvite(to: { email: string; name: string }, site: string, url: string, days: number, f: From) {
  const t = T[f.lang];
  const { html, text } = layout([t.inviteHello(to.name.split(' ')[0]), t.inviteBody(f.agency, site, f.whiteLabel ? '' : 'ClaudePress'), t.inviteStep(!!config.firebase)],
    { label: t.inviteButton, url }, [t.inviteExpires(days), t.question(f.agency)], f.color || '#ea580c', t.colon);
  return sendMail({ to: to.email, subject: t.inviteSubject(f.agency, site), html, text, fromName: f.agency, replyTo: f.replyTo });
}

/** Someone who already has an account was given one more site. */
export function sendAccess(to: { email: string; name: string }, site: string, url: string, f: From) {
  const t = T[f.lang];
  const { html, text } = layout([t.inviteHello(to.name.split(' ')[0]), t.accessBody(f.agency, site)],
    { label: t.accessButton, url }, [t.question(f.agency)], f.color || '#ea580c', t.colon);
  return sendMail({ to: to.email, subject: t.accessSubject(f.agency, site), html, text, fromName: f.agency, replyTo: f.replyTo });
}
