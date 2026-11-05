// Google Analytics 4 behind a consent banner, only on a server whose config names a measurement id (the hosted service).
// Nothing from Google loads before the person accepts: no gtag.js, no _ga cookie, no cookieless ping.
// Refusing is as easy as accepting (two equal buttons), the choice is kept, and "Cookies" in the account menu changes it.
// What is measured: which screen (without ids), and a few steps (sign-up, site added, message sent, published, checkout).
// Never page contents, conversations, site names or addresses.

const KEY = 'claudepress-consent';   // 'granted' | 'denied'; absent = not answered yet, so the banner shows
let id = null;
let quiet = false;                   // the platform's own staff: not counted

const read = () => { try { const v = localStorage.getItem(KEY); return v === 'granted' || v === 'denied' ? v : null; } catch { return null; } };

window.dataLayer = window.dataLayer || [];
function gtag() { window.dataLayer.push(arguments); }

/** The screen without ids: #/site/abc → /site, #/admin/site/abc/x → /admin/site. */
const screen = () => {
  const [, page = '', tab = ''] = location.hash.split('?')[0].split('/');
  return '/' + [page, page === 'admin' ? tab : ''].filter(Boolean).join('/');
};
const where = () => ({ page_location: location.origin + screen(), page_path: screen(), page_title: 'ClaudePress' });

function load() {
  if (!id || document.getElementById('cp-gtag')) return;
  const s = document.createElement('script');
  s.id = 'cp-gtag';
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);
  gtag('js', new Date());
  gtag('config', id, { send_page_view: false, ...where() });
  pageView();
}

/** Keeps the choice and tells Google in one go, so the two never disagree. */
export function setConsent(choice) {
  try { localStorage.setItem(KEY, choice); } catch {}
  gtag('consent', 'update', { analytics_storage: choice, ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  if (choice === 'granted') load();
  else for (const c of document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(c => c.startsWith('_ga'))) {
    for (const domain of ['', `; domain=${location.hostname.split('.').slice(-2).join('.')}`]) document.cookie = `${c}=; Max-Age=0; path=/${domain}`;
  }
  document.querySelector('.consent')?.remove();
}

export function pageView() {
  if (id && !quiet && read() === 'granted') gtag('event', 'page_view', where());
}

/** One of the measured steps; params are counts or kinds, never what people wrote. */
export function track(name, params = {}) {
  if (id && !quiet && read() === 'granted') gtag('event', name, { ...params, ...where() });
}

/** Staff of the platform are not counted in its own figures. */
export function notCounted(yes) { quiet = !!yes; }

/** Whether this server measures anything (and so whether "Cookies" is offered). */
export const measured = () => !!id;

/** Starts measurement for an id from the server's config (none: nothing at all happens). */
export function startAnalytics(measurementId) {
  if (!/^G-[A-Z0-9]{4,20}$/i.test(measurementId || '') || id) return;
  id = measurementId;
  gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied',
    functionality_storage: 'granted', security_storage: 'granted', wait_for_update: 500 });
  if (read() === 'granted') { gtag('consent', 'update', { analytics_storage: 'granted' }); load(); }
  else if (read() === null) banner();
}

// Not modal: it neither traps the focus nor blocks the page, and there is no "close" that would count as a yes.
function banner() {
  const b = document.createElement('div');
  b.className = 'consent';
  b.setAttribute('role', 'dialog');
  b.setAttribute('aria-labelledby', 'consent-title');
  b.innerHTML = `<div><strong id="consent-title">Un cookie pour mesurer les visites ?</strong>
    <p>Nous aimerions savoir quels écrans servent et où l’on bloque, pour améliorer ClaudePress. Rien de ce que vous écrivez ni le contenu de vos sites n’est envoyé, rien ne sert à la publicité.</p></div>
    <div class="consent-actions"><button class="btn" data-c="denied">Refuser</button><button class="btn primary" data-c="granted">Accepter</button></div>`;
  b.querySelectorAll('[data-c]').forEach(x => x.addEventListener('click', () => setConsent(x.dataset.c)));
  document.body.appendChild(b);
}

/** The choice can be changed at any time: "Cookies" in the account menu. */
export function cookieChoices() {
  const d = document.createElement('dialog');
  const on = read() === 'granted';
  d.innerHTML = `<form method="dialog" class="stack"><h2>Cookies</h2>
    <label class="consent-row"><input type="checkbox" checked disabled><span><strong>Nécessaires</strong><br><span class="muted small">Votre connexion et la sécurité. Toujours actifs, ils ne mesurent pas votre navigation.</span></span></label>
    <label class="consent-row"><input type="checkbox" name="analytics" ${on ? 'checked' : ''}><span><strong>Mesure d’audience (Google Analytics)</strong><br><span class="muted small">Désactivée tant que vous ne l’activez pas. Quels écrans servent, sans vos textes ni le contenu de vos sites.</span></span></label>
    <label class="consent-row"><input type="checkbox" disabled><span><strong>Publicité</strong><br><span class="muted small">Aucun cookie publicitaire, jamais.</span></span></label>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" value="save">Enregistrer</button></div></form>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => {
    if (d.returnValue === 'save') setConsent(d.querySelector('[name=analytics]').checked ? 'granted' : 'denied');
    d.remove();
  });
  d.showModal();
}
