import { seoChecks } from './seo.js';
import { cookieChoices, measured, notCounted, pageView, startAnalytics, track } from './analytics.js';
import { authMessage, createWithPassword, currentUser, resetPassword, sendVerification, signOutFirebase, withGitHub, withGoogle, withPassword } from './firebase-auth.js';

// ------------------------------------------------------------------ helpers

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString(document.documentElement.lang || 'fr');   // credits and token counts
const strip = h => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const app = $('#app');

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { location.hash = '#/login'; throw new Error(data.error || 'Connectez-vous'); }
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

function toast(text, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

const P = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  post: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  page: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h8"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  clip: '<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  send: '<path d="M4 12l16-8-6 16-2-7z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  out: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16l4-5 3 3 5-7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>',
};
const icon = (n, size = 20) => `<svg class="i" viewBox="0 0 24 24" style="width:${size}px;height:${size}px">${P[n]}</svg>`;

// ------------------------------------------------------------------ white label

// ------------------------------------------------------------------ extensions
// A hosted service's screens (server/extension.ts) add to named places of the app: `hook(name, fn)` from its app.js,
// loaded before the first screen. extHtml joins what they show there; extRun calls their `name:wire` hooks to wire it.
const hooks = {};
const hook = (name, fn) => { (hooks[name] ||= []).push(fn); };
const extHtml = (name, ...args) => (hooks[name] || []).map(fn => fn(...args) || '').join('');
const extRun = (name, ...args) => (hooks[name + ':wire'] || []).forEach(fn => fn(...args));

// Accounts with white label show their own name, logo and colour instead of ClaudePress's (server/billing.ts brandOf).
// The last one seen is remembered on this browser, so the sign-in screen already wears it.
const BRAND_KEY = 'claudepress-brand';
let brand = null;
const remembered = () => { try { return JSON.parse(localStorage.getItem(BRAND_KEY)); } catch { return null; } };
const productName = () => brand?.name || 'ClaudePress';
const mascot = () => brand?.mascot !== false;

const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgbHex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const mixRgb = (a, b, k) => a.map((v, i) => v * (1 - k) + b[i] * k);
const luminance = c => { const [r, g, b] = c.map(v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * r + .7152 * g + .0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };

/** The colour tokens of style.css from one accent: text in it darkened until readable on white, light tints for backgrounds. */
function accentTokens(hex) {
  const c = hexRgb(hex), W = [255, 255, 255];
  let strong = c;
  for (let k = .05; k <= 1 && contrast(strong, W) < 4.5; k += .05) strong = mixRgb(c, [0, 0, 0], k);
  return { '--brand': hex, '--brand-strong': rgbHex(strong), '--brand-ink': contrast(c, W) >= 3 ? '#ffffff' : '#1c1917',
    '--brand-soft': rgbHex(mixRgb(c, W, .86)), '--brand-glow': rgbHex(mixRgb(c, W, .3)), '--soft': rgbHex(mixRgb(c, W, .94)),
    '--line': rgbHex(mixRgb(mixRgb(c, W, .88), [232, 232, 232], .5)) };
}
const TOKENS = Object.keys(accentTokens('#000000'));
function applyAccent(hex) {
  const root = document.documentElement.style;
  TOKENS.forEach(t => root.removeProperty(t));
  if (/^#[0-9a-f]{6}$/i.test(hex || '')) for (const [t, v] of Object.entries(accentTokens(hex))) root.setProperty(t, v);
}

/** A tab icon from the name's first letter on the accent, instead of Nini. */
function letterIcon(name, color) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color || '#2b1d14'; g.beginPath(); g.roundRect(0, 0, 64, 64, 16); g.fill();
  g.fillStyle = color && contrast(hexRgb(color), [255, 255, 255]) < 3 ? '#1c1917' : '#ffffff';
  g.font = '800 40px "Plus Jakarta Sans", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText((name.trim()[0] || '·').toUpperCase(), 32, 35);
  return c.toDataURL('image/png');
}

/** A logo about square, fitted in the tab icon's square; null for a wide logo, which would be unreadable there. */
function squareIcon(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h || w / h > 1.4 || h / w > 1.4) return null;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const k = 64 / Math.max(w, h);
  c.getContext('2d').drawImage(img, (64 - w * k) / 2, (64 - h * k) / 2, w * k, h * k);
  return c.toDataURL('image/png');
}

/** The white label's tab icon: its own icon, else its logo when it is about square, else its first letter on its colour. */
function setTabIcon(b) {
  const set = (href, sel = 'link[rel=icon]') => $$(sel).forEach(l => { l.dataset.href ||= l.getAttribute('href'); l.href = href ?? l.dataset.href; });
  // the home-screen icon (iPhone, iPad) only takes an icon of its own: ClaudePress's stays otherwise
  set(b?.icon ?? null, 'link[rel=apple-touch-icon]');
  if (!b) return set(null);
  if (b.icon) return set(b.icon);
  set(letterIcon(b.name, b.color));
  if (!b.logo) return;
  const img = new Image();
  img.onload = () => { const icon = squareIcon(img); if (icon && brand === b) set(icon); };
  img.src = b.logo;
}

function applyBrand(b, { remember = true } = {}) {
  brand = b || null;
  if (remember) try { brand ? localStorage.setItem(BRAND_KEY, JSON.stringify(brand)) : localStorage.removeItem(BRAND_KEY); } catch {}
  applyAccent(brand?.color);
  document.title = productName();
  setTabIcon(brand);
}
applyBrand(remembered(), { remember: false });

// Nini, the ClaudePress mascot: one pose per moment (web/brand/nini/*.webp); a white label may hide it
const logo = () => `<a class="logo${brand ? ' own' : ''}" href="#/">${!brand ? '<img src="/brand/logo.webp" alt="ClaudePress" width="430" height="144">'
  : brand.logo ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}">` : `<span class="no-translate">${esc(brand.name)}</span>`}</a>`;
const nini = (pose, cls = 'nini') => mascot() ? `<img class="${cls}" src="/brand/nini/${pose}.webp" alt="" width="512" height="512" decoding="async">` : '';
const emptyNini = (text, pose = 'empty') => mascot() ? `<div class="empty nini">${nini(pose, '')}<span>${text}</span></div>` : `<div class="empty">${text}</div>`;

const STATUS = {
  draft: 'Brouillon', pending: 'En attente de validation', changes_requested: 'Correction demandée', scheduled: 'Programmé', published: 'Publié',
  discarded: 'Abandonné', agency: 'Chez l’agence', done: 'Traité par l’agence',
};
const TYPE = { edit: 'Modification', post: 'Article', request: 'Demande' };
const when = iso => {
  if (!iso) return '';
  const d = new Date(iso), diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'à l’instant';
  if (diff < 3600) return `il y a ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.round(diff / 3600)} h`;
  return d.toLocaleDateString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE', { day: 'numeric', month: 'long' });
};

/** A day asked for ("2026-11-09", midnight where the person is) or a moment, as a Date. */
const atOf = v => new Date(v.length === 10 ? `${v}T00:00:00` : v);
/** "lundi 9 novembre à 00:00": when a scheduled change goes live, in the person's time, never translated word by word. */
const atText = v => {
  const d = atOf(v), lang = document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE';
  return `<span class="no-translate">${d.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' })} ${lang === 'en-GB' ? 'at' : 'à'} ${d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })}</span>`;
};
/** The day suggested for a change (by the assistant, or asked by its author), while it is still ahead. */
const suggestion = c => c.suggested_at && atOf(c.suggested_at) > Date.now() + 60_000 ? c.suggested_at : null;

/** Word-level diff of two plain texts, as HTML with <del> and <ins>. */
function diff(a, b) {
  const A = strip(a).split(/(\s+)/), B = strip(b).split(/(\s+)/);
  if (A.length * B.length > 250000) return `<del>${esc(strip(a))}</del> <ins>${esc(strip(b))}</ins>`;
  const m = A.length, n = B.length, L = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, out = '', same = 0;
  const push = (tag, s) => { out += tag ? `<${tag}>${esc(s)}</${tag}>` : esc(s); };
  while (i < m && j < n) {
    if (A[i] === B[j]) { if (A[i].trim()) same++; push('', A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < m) push('del', A[i++]);
  while (j < n) push('ins', B[j++]);
  // a text rewritten from scratch reads better as old, then new, than as a mix of crossed-out words
  const most = Math.max(A.filter(t => t.trim()).length, B.filter(t => t.trim()).length);
  if (most > 4 && same < 0.5 * most) return `<del>${esc(strip(a))}</del><br><ins>${esc(strip(b))}</ins>`;
  return out.replace(/<\/del><del>/g, '').replace(/<\/ins><ins>/g, '');
}

/** Photos are resized in the browser before upload: lighter for everyone, and plenty for the site. */
async function upload(file) {
  let blob = file, type = file.type;
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 2400 / Math.max(img.width, img.height));
    if (k < 1 || file.size > 3e6) {
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      type = file.type === 'image/png' && file.size < 4e6 ? 'image/png' : 'image/jpeg';
      blob = await new Promise(r => c.toBlob(r, type, 0.88));
    }
  }
  const r = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': type, 'x-file-name': encodeURIComponent(file.name) }, body: blob });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}

// ------------------------------------------------------------------ shell

let me = null;
let timer = null;
const stopPolling = () => { clearTimeout(timer); timer = null; };

function topbar(crumbs = '') {
  const unread = me.notices.filter(n => !n.read).length;
  return `<header class="top">
    ${logo()}${crumbs}
    <span class="spacer"></span>
    ${me.user.agency ? `<button class="btn ghost small" id="adminmenu" title="Administration" aria-haspopup="menu">${icon('gear', 18)}<span class="hide-sm">Administration</span><span aria-hidden="true">▾</span></button>` : ''}
    <button class="icon-btn bell" id="bell" title="Notifications">${icon('bell')}${unread ? `<b>${unread}</b>` : ''}</button>
    <button class="btn ghost small" id="account" title="Votre compte">${esc(me.user.name)}</button>
  </header>`;
}

/** The administration pages, in the order of the menu: the daily work, then the account's settings. */
let adminPage = null;   // the admin page on screen, for the menu
const ADMIN_PAGES = [
  ['start', 'Bien démarrer'], ['sites', 'Sites'], ['people', 'Personnes'], ['requests', 'Demandes'], ['monitoring', 'Surveillance'], ['security', 'Sécurité'], null,
  ['account', 'Formule et facturation'], ['usage', 'Crédits et utilisation'], ['keys', 'Clés IA (BYOK)'], ['github', 'GitHub'], ['insights', 'Statistiques Google'], ['brand', 'Marque blanche'],
];

function wireTop() {
  $('#adminmenu')?.addEventListener('click', e => {
    e.stopPropagation();
    if ($('.menu')) return $('.menu').remove();
    const m = document.createElement('div');
    m.className = 'menu account admin';
    m.setAttribute('role', 'menu');
    const here = location.hash.startsWith('#/admin') ? adminPage : null;
    m.innerHTML = ADMIN_PAGES.map(x => x ? `<a class="n ${x[0] === here ? 'on' : ''}" role="menuitem" href="#/admin/${x[0]}">${x[1]}</a>` : '<hr>').join('');
    document.body.appendChild(m);
    document.addEventListener('click', () => m.remove(), { once: true });
  });
  $('#account')?.addEventListener('click', e => {
    e.stopPropagation();
    if ($('.menu')) return $('.menu').remove();
    const m = document.createElement('div');
    m.className = 'menu account';
    m.innerHTML = `<button class="n" data-act="phone">Connecter l’iPhone</button>${measured() ? '<button class="n" data-act="cookies">Cookies</button>' : ''}<button class="n" data-act="logout">Se déconnecter</button>`;
    document.body.appendChild(m);
    document.addEventListener('click', () => m.remove(), { once: true });
    $('[data-act=phone]', m).addEventListener('click', () => connectPhone());
    $('[data-act=cookies]', m)?.addEventListener('click', () => cookieChoices());
    $('[data-act=logout]', m).addEventListener('click', async () => {
      await api('/api/logout', {});
      const st = await fetch('/api/auth/state').then(r => r.json()).catch(() => ({}));
      await signOutFirebase(st.firebase).catch(() => {});
      location.hash = '#/login';
    });
  });
  $('#bell')?.addEventListener('click', async e => {
    e.stopPropagation();
    if ($('.menu')) return $('.menu').remove();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = me.notices.length ? me.notices.map(n => `<a class="n ${n.read ? '' : 'unread'}" href="${n.change_id ? `#/change/${n.change_id}` : n.link || '#/'}">${esc(n.text)}<div class="muted small">${when(n.created)}</div></a>`).join('')
      : emptyNini('Aucune notification. Tout est calme !', 'sleeping');
    document.body.appendChild(m);
    document.addEventListener('click', () => m.remove(), { once: true });
    await api('/api/notices/read', {});
    me.notices.forEach(n => n.read = 1);
    $('#bell b')?.remove();
  });
}

/** Connects the iPhone app: a one-time code and its QR, and the phones already connected. */
async function connectPhone() {
  const d = document.createElement('dialog');
  d.className = 'pair';
  d.innerHTML = `<form method="dialog" class="stack"><h2>Connecter l’iPhone</h2>
    <p class="muted">Ouvrez l’app ClaudePress sur l’iPhone et scannez ce code, ou tapez-le. L’appareil photo de l’iPhone le reconnaît aussi.</p>
    <div class="pair-code"></div>
    <h3>iPhones connectés</h3>
    <div class="list devices"></div>
    <p class="muted small">Un iPhone connecté le reste, sans se reconnecter. S’il est perdu ou donné, retirez-le ici.</p>
    <div style="display:flex;justify-content:flex-end"><button class="btn" value="close">Fermer</button></div></form>`;
  document.body.appendChild(d);
  d.showModal();
  let tick = null, poll = null, known = null;
  d.addEventListener('close', () => { clearInterval(tick); clearTimeout(poll); d.remove(); });
  const box = $('.pair-code', d);

  const devices = async () => {
    const list = await api('/api/devices');
    $('.devices', d).innerHTML = list.length ? list.map(x => `<div class="row"><div class="t"><strong class="no-translate">${esc(x.name)}</strong>
      <div class="muted small">Ajouté ${when(x.created)} · Utilisé ${when(x.last_used)}</div></div>
      <button type="button" class="btn ghost small" data-rm="${esc(x.id)}">Retirer</button></div>`).join('')
      : '<div class="empty">Aucun iPhone connecté pour l’instant.</div>';
    $$('[data-rm]', d).forEach(b => b.addEventListener('click', async () => {
      await api(`/api/devices/${encodeURIComponent(b.dataset.rm)}/remove`, {});
      known?.delete(b.dataset.rm);
      devices();
    }));
    return list;
  };

  const showCode = async () => {
    clearInterval(tick);
    const p = await api('/api/devices/pair-code', {});
    box.innerHTML = `<div class="qr">${p.qr}</div><div class="stack"><div class="code no-translate">${esc(p.code)}</div><div class="muted small left"></div></div>`;
    const left = () => {
      const s = Math.round((Date.parse(p.expires) - Date.now()) / 1000);
      if (s > 0) { $('.left', box).textContent = `Valable encore ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; return; }
      clearInterval(tick);
      box.innerHTML = `<div class="stack"><span class="muted">Ce code a expiré.</span><button type="button" class="btn primary small" id="again">Nouveau code</button></div>`;
      $('#again', box).addEventListener('click', showCode);
    };
    left();
    tick = setInterval(left, 1000);
  };

  // the phone uses the code: a new device appears in the list
  const watch = async () => {
    const list = await devices().catch(() => null);
    if (list && list.some(x => !known.has(x.id))) {
      clearInterval(tick);
      box.innerHTML = `<div class="done">${nini('approved', '')}<div><strong>iPhone connecté !</strong><div class="muted">Vous pouvez demander vos modifications depuis l’app.</div></div></div>`;
      return;
    }
    if (d.open) poll = setTimeout(watch, 3000);
  };

  try {
    known = new Set((await devices()).map(x => x.id));
    await showCode();
    poll = setTimeout(watch, 3000);
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

async function route() {
  stopPolling();
  pageView();
  scrollTo(0, 0);   // a new screen opens at its top, not where the last one was scrolled
  $('.overlay')?.remove();
  const [, page, id] = location.hash.split('/');
  if (page === 'login') return login();
  if (page === 'invite') return invite(id);
  if (page === 'signup') return signup();
  try { me = await api('/api/me'); } catch { return; }
  applyBrand(me.brand);
  notCounted(me.user.platform);
  if (page === 'site' && (location.hash.split('/')[3] || '').startsWith('stats')) return stats(id);
  if (page === 'site') return home(id);
  if (page === 'change') return change(id);
  if (page === 'admin') return admin((id || '').split('?')[0] || undefined, location.hash.split('/')[3]);
  if (me.sites.length === 1 && !me.user.agency) { location.hash = `#/site/${me.sites[0].id}`; return; }
  return sitesList();
}
addEventListener('hashchange', route);
fetch('/api/auth/state').then(r => r.json()).then(s => startAnalytics(s.analytics)).catch(() => {});

// ------------------------------------------------------------------ sign-in, first admin, invitations

const ROLE = { approver: 'Peut publier', editor: 'Sans publication', agency: 'Administrateur' };
// how far a client may change a site (administrators: everything); "site", from before the permissions, reads as "page"
const SCOPE = { page: 'Selon les permissions', full: 'Tout, comme l’agence' };
const SCOPE_HINT = {
  page: 'ce que les permissions du site autorisent, ci-dessous.',
  full: 'tout, sans validation, et tous les fichiers du site (gabarits, styles, scripts), comme un développeur de l’agence. À réserver aux personnes de confiance.',
};
const scopeLabel = v => SCOPE[v] || SCOPE.page;
// what a site's clients may change, kind by kind (server/permissions.ts)
const KIND = { content: 'Textes et photos des pages', posts: 'Articles du blog', prices: 'Prix des produits',
  details: 'Coordonnées : adresse, téléphone, e-mail, horaires', site_texts: 'Menu et textes communs à tout le site' };
const REQUEST_KIND = { ...KIND, structure: 'Structure : sections, ajout ou retrait d’éléments', design: 'Design', forms: 'Formulaires', technical: 'Technique', other: 'Autre' };
// who changes something, as the administrator picks it: clients (by their role), clients with the agency's approval, or the agency
const PERMISSION = { allowed: 'Vos clients', approval: 'Vos clients, l’agence valide', agency: 'L’agence seulement' };
const PERM_SHORT = { allowed: 'Clients', approval: 'Clients + validation', agency: 'Agence' };
const PERMISSION_HINT = {
  allowed: 'Les personnes qui peuvent publier le mettent en ligne elles-mêmes ; celles sans publication le leur soumettent.',
  approval: 'Vos clients préparent le changement ; l’agence le valide avant la mise en ligne, même pour ceux qui peuvent publier.',
  agency: 'Vos clients envoient une demande ; l’agence fait le changement.',
};
const ROLE_HINT = {
  approver: 'Publie ses changements et valide ceux des autres.',
  editor: 'Prépare des changements ; un administrateur (ou une personne qui peut publier) les valide avant la mise en ligne.',
};

/** Every way in shares one screen: Nini on one side with a word of welcome, the form on the other. */
const SAY = {
  login: ['Bon retour !', 'On s’occupe de votre site ensemble ?'],
  setup: ['Bienvenue ! Moi, c’est Nini.', 'Je vais vous aider à gérer les sites de vos clients.'],
  signup: ['Salut ! Moi, c’est Nini.', 'Créons votre compte, ça prend une minute.'],
  invite: ['On vous attendait !', 'Je suis Nini, je vous aide à modifier votre site.'],
  verify: ['Je vous ai écrit !', 'Un petit clic dans l’e-mail et c’est parti.'],
  expired: ['Oups…', 'Ce lien ne fonctionne plus.'],
};
// without the mascot, the white label's logo (or name) takes its place, and the bubble no longer introduces Nini
const authShell = (inner, say = 'login', pose = 'welcome') => `<div class="auth">
  <aside class="auth-art">${mascot() ? `<div class="bubble">${SAY[say][0]}<small>${SAY[say][1]}</small></div>${nini(pose, '')}`
    : `<div class="bubble">${SAY[say][0]}</div><div class="auth-brand">${brand.logo ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}">` : `<strong class="no-translate">${esc(brand.name)}</strong>`}</div>`}</aside>
  <main class="auth-main"><div class="login stack">${inner}</div></main>
</div>`;

function authPage(title, intro, fields, button, say = 'login', pose = 'welcome') {
  app.innerHTML = authShell(`
    <div><h1>${esc(title)}</h1>${intro ? `<p class="muted" style="margin-top:6px">${intro}</p>` : ''}</div>
    <form class="stack" id="auth">${fields}
      <div class="banner bad" id="err" hidden></div>
      <button class="btn primary" type="submit">${esc(button)}</button>
    </form>`, say, pose);
  return $('#auth');
}
const field = (name, label, type = 'text', extra = '') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" required ${extra}></label>`;
function submitTo(form, handler) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try { await handler(Object.fromEntries(new FormData(form))); }
    catch (err) { $('#err').hidden = false; $('#err').textContent = err.message; btn.disabled = false; }
  });
}

async function login() {
  const state = await fetch('/api/auth/state').then(r => r.json());
  if (state.firebase) return fbLogin(state, state.setupNeeded ? 'setup' : 'login');
  if (state.setupNeeded) return setup();
  const form = authPage('Connexion', '', field('email', 'E-mail', 'email', 'autocomplete="username" autofocus') +
    field('password', 'Mot de passe', 'password', 'autocomplete="current-password"'), 'Se connecter');
  form.insertAdjacentHTML('beforeend', '<p class="hint">Mot de passe oublié ? Demandez un nouveau lien à votre administrateur.</p>'
    + (state.signup ? '<p class="hint">Pas encore de compte ? <a href="#/signup">Créez-le gratuitement</a>.</p>' : ''));
  submitTo(form, async v => { await api('/api/login', v); track('login', { method: 'password' }); location.hash = '#/'; });
}

function setup() {
  const form = authPage('Bienvenue dans ClaudePress', 'Créez le compte administrateur : c’est lui qui ajoute les sites et invite les clients.',
    field('name', 'Votre nom', 'text', 'autocomplete="name" autofocus') + field('email', 'E-mail', 'email', 'autocomplete="username"') +
    field('password', 'Mot de passe (10 caractères minimum)', 'password', 'autocomplete="new-password" minlength="10"'), 'Créer le compte administrateur', 'setup');
  submitTo(form, async v => { await api('/api/setup', v); location.hash = '#/admin'; });
}

async function invite(token) {
  let who;
  const state = await fetch('/api/auth/state').then(r => r.json());
  try { who = await api(`/api/invite/${token}`); }
  catch (e) { authPage('Lien expiré', esc(e.message), '', 'Aller à la connexion', 'expired', 'error'); $('#auth').addEventListener('submit', ev => { ev.preventDefault(); location.hash = '#/login'; }); return; }
  applyBrand(who.brand);
  if (state.firebase) return fbLogin(state, 'invite', { token, ...who });
  const form = authPage(`Bienvenue ${who.name.split(' ')[0]}`, `Choisissez votre mot de passe pour le compte <strong>${esc(who.email)}</strong>.`,
    `<label class="field"><span>Votre nom</span><input name="name" value="${esc(who.name)}" required autocomplete="name"></label>` +
    `<input type="email" value="${esc(who.email)}" autocomplete="username" hidden>` +
    field('password', 'Mot de passe (10 caractères minimum)', 'password', 'autocomplete="new-password" minlength="10" autofocus'), 'Enregistrer et entrer', 'invite');
  submitTo(form, async v => { await api(`/api/invite/${token}`, v); location.hash = '#/'; });
}

/** The site as it looks online: its share image, filled in after the page from /api/sites/:id/peek, with when it last changed. */
const peekBox = s => `<div class="peek" data-peek="${s.id}" aria-hidden="true"><span>${esc((s.name || '?').trim().charAt(0).toUpperCase())}</span></div>`;
const peeks = {};
const updatedLine = v => {
  // what ClaudePress published, unless the host shows a later change (made outside ClaudePress)
  const ours = v.published && (!v.modified || v.published >= v.modified);
  const at = ours ? v.published : v.modified;
  const w = when(at), on = /^\d/.test(w) ? (document.documentElement.lang === 'en' ? 'on ' : 'le ') : '';
  return at ? `<span>${ours ? 'Publié via ClaudePress' : 'Site mis à jour'}</span> <span class="no-translate">${on}</span><span>${w}</span>` : '';
};
function fillPeeks(root = document) {
  $$('[data-peek]', root).forEach(async el => {
    const id = el.dataset.peek;
    const v = await (peeks[id] ||= api(`/api/sites/${id}/peek`).catch(() => null));
    if (!v || !el.isConnected) return;
    if (v.image && !$('img', el)) {
      const img = Object.assign(new Image(), { alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' });
      img.onload = () => el.classList.add('shown');
      img.onerror = () => img.remove();
      img.src = v.image;
      el.prepend(img);
    }
    $$(`[data-updated="${id}"]`, root).forEach(x => { x.innerHTML = updatedLine(v); });
  });
}

function sitesList() {
  const card = s => `<a class="site-tile" href="#/site/${s.id}">${peekBox(s)}
    <div class="site-tile-body"><div class="site-tile-name"><strong>${esc(s.name)}</strong>
        ${s.status !== 'ready' ? `<span class="pill ${s.status === 'error' ? 'changes_requested' : 'pending'}">${s.status === 'error' ? 'Erreur' : 'Installation…'}</span>` : ''}
        ${s.paused ? '<span class="pill changes_requested">En pause</span>' : ''}
        ${s.pending ? `<span class="pill pending">${s.pending} à valider</span>` : ''}</div>
      <span class="muted small no-translate">${esc(s.liveUrl.replace(/^https?:\/\/(www\.)?|\/$/g, ''))}</span>
      <span class="muted small" data-updated="${s.id}"></span></div></a>`;
  app.innerHTML = topbar() + `<main class="page"><div class="hello"><div class="hello-nini">${nini('welcome', '')}<h1>Vos sites</h1></div>
      ${me.user.agency ? `<a class="btn primary" href="#/admin/new-site">+ Ajouter un site</a>` : ''}</div>
    ${me.sites.length ? `<div class="site-tiles">${me.sites.map(card).join('')}</div>` : `<div class="list">${emptyNini(me.user.agency ? 'Aucun site pour l’instant. Ajoutez le premier !' : 'Aucun site ne vous est encore attribué.')}</div>`}</main>`;
  wireTop();
  fillPeeks(app);
}

// ------------------------------------------------------------------ home of a site

async function home(siteId) {
  const d = await api(`/api/sites/${siteId}`);
  const first = me.user.name.split(/[\s(]/)[0];
  const row = c => `<a class="row" href="#/change/${c.id}">
      <span class="muted">${icon(c.type === 'post' ? 'post' : c.type === 'request' ? 'page' : 'edit')}</span>
      <div class="t"><strong>${esc(c.title)}</strong><span class="muted small">${TYPE[c.type]} · ${esc(c.author)} · ${c.status === 'scheduled' ? atText(c.publish_at) : when(c.published || c.updated)}${c.count ? ` · ${c.count} changement${c.count > 1 ? 's' : ''}` : ''}</span></div>
      ${c.status === 'published' && LIVE_PILL[c.live] ? `<span class="pill ${LIVE_PILL[c.live][0]}">${LIVE_PILL[c.live][1]}</span>` : `<span class="pill ${c.status}">${STATUS[c.status]}</span>`}</a>`;
  const list = (items, empty, pose) => `<div class="list">${items.map(row).join('') || emptyNini(empty, pose)}</div>`;
  const multi = me.sites.length > 1 ? `<span class="muted">/</span><a class="crumb" href="#/">${esc(d.site.name)}</a>` : '';
  // shortcuts: the site's own usual tasks (from its scan), else everyday examples this person may do
  const tasks = d.tasks.length ? d.tasks : SUGGESTIONS.filter(t => d.may?.prices !== 'agency' || !/prix/.test(t)).map(t => ({ label: t, prompt: `${t.replace(/…$/, '')} : ` }));
  app.innerHTML = topbar(multi) + `<main class="page">
    <div class="hello"><div class="hello-nini">${nini('welcome', '')}<div><h1>Bonjour ${esc(first)} !</h1><p class="muted">Que voulez-vous faire sur le site ${esc(d.site.name)} ?</p>
        ${d.monitor?.state && d.monitor.state !== 'down' ? `<div class="mon-line">${monPill(d.monitor)}<span class="muted small">${d.monitor.state === 'up' ? `depuis ${dur(minutesSince(d.monitor.since), 1)} · ` : ''}<span class="no-translate">${uptimePct(d.monitor.periods[2].uptime)}</span> de disponibilité sur 30 jours</span></div>` : ''}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${d.insights ? `<a class="btn" href="#/site/${d.site.id}/stats">${icon('chart', 18)} Statistiques</a>` : ''}
        <a class="btn" href="${esc(d.site.liveUrl)}" target="_blank" rel="noopener">${icon('out', 18)} Voir le site</a></div></div>
    ${d.monitor?.state === 'down' ? downBanner(d.monitor, d.role === 'agency') : ''}
    ${d.golive?.late ? `<div class="banner bad" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <span>${d.golive.late > 1 ? `${d.golive.late} changements publiés ne sont pas encore sur le site en ligne.` : 'Un changement publié n’est pas encore sur le site en ligne.'}</span>
      <a class="btn small" href="#/admin/site/${d.site.id}" data-to-golive>Voir comment le mettre en ligne</a></div>` : ''}
    <div class="start">
      <form class="action main" id="start">
        <div class="head"><span class="ico">${icon('edit', 24)}</span><div><strong>Modifier le contenu du site</strong>
          <span class="muted">${d.may?.prices === 'agency' ? 'Textes, photos et boutons' : 'Textes, photos, boutons et prix'} de vos pages. Dites ce que vous voulez changer : l’IA le prépare, vous voyez l’avant/après et vous validez.</span></div></div>
        <div class="ask"><input id="ask" placeholder="Ex. : remplace la photo en haut de l’accueil par une photo de l’équipe" autocomplete="off">
          <button class="btn primary" type="submit">${icon('send', 18)} Commencer</button></div>
        ${tasks.length ? `<div class="tasks"><span class="muted small">${d.tasks.length ? (d.tasks[0].page ? 'Vos pages' : 'Vos tâches courantes') : 'Par exemple'}</span>
          ${tasks.map((t, i) => `<button type="button" class="chip${d.tasks.length ? ' no-translate' : ''}" data-task="${i}">${esc(t.label)}</button>`).join('')}</div>` : ''}
      </form>
      <div class="more">
        ${d.may?.posts === 'agency' ? '' : `<button class="action" data-new="post"><span class="ico">${icon('post', 24)}</span><strong>Écrire un article</strong><span class="muted">Un article de blog rédigé avec l’IA, prêt pour Google.</span></button>`}
        <button class="action" data-new="request"><span class="ico">${icon('page', 24)}</span><strong>Demander une nouvelle page</strong><span class="muted">Décrivez-la : l’IA en fait un plan, l’agence la construit.</span></button>
      </div>
    </div>
    ${d.insights ? '<section class="section" id="glance" hidden></section>' : ''}
    ${d.toReview.length ? `<section class="section"><h2>À valider <span class="count">${d.toReview.length}</span></h2>${list(d.toReview)}</section>` : ''}
    ${d.scheduled?.length ? `<section class="section"><h2>Programmé <span class="count">${d.scheduled.length}</span></h2>${list(d.scheduled)}</section>` : ''}
    <div class="board">
      <section class="section"><h2>En cours</h2>${list(d.mine, 'Rien en cours. Commencez par une des actions ci-dessus.')}</section>
      <section class="section"><h2>Demandes à l’agence</h2>${list(d.requests, 'Aucune demande en cours auprès de l’agence.')}</section>
      <section class="section"><h2>Historique</h2>${list(d.history, `Aucune modification publiée depuis ${esc(productName())} pour l’instant.`, 'sleeping')}</section>
    </div>
  </main>`;
  wireTop();
  $$('[data-new]').forEach(b => b.addEventListener('click', async () => {
    const { id } = await api(`/api/sites/${siteId}/changes`, { type: b.dataset.new });
    location.hash = `#/change/${id}`;
  }));
  // a request typed here is sent as soon as the conversation opens; a shortcut only starts it, for the person to finish
  const startEdit = async (text, send) => {
    const { id } = await api(`/api/sites/${siteId}/changes`, { type: 'edit' });
    try { sessionStorage.setItem(`start-${id}`, JSON.stringify({ text, send })); } catch {}
    location.hash = `#/change/${id}`;
  };
  if (d.insights) glance($('#glance'), siteId);
  $('#start').addEventListener('submit', e => { e.preventDefault(); startEdit($('#ask').value.trim(), !!$('#ask').value.trim()); });
  $$('[data-task]').forEach(b => b.addEventListener('click', () => startEdit(tasks[+b.dataset.task].prompt, false)));
}

// ------------------------------------------------------------------ figures of a site (Google Analytics, Search Console)

const locale = () => document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE';
const share = (v, digits = 0) => `${(100 * v).toLocaleString(locale(), { maximumFractionDigits: digits })} %`;
const duration = sec => sec < 60 ? `${Math.round(sec)} s` : `${Math.floor(sec / 60)} min ${String(Math.round(sec % 60)).padStart(2, '0')} s`;
const shortDay = iso => new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
const CHANNEL = { 'Organic Search': 'Recherche Google', Direct: 'Accès direct', 'Organic Social': 'Réseaux sociaux', Referral: 'Autres sites',
  'Paid Search': 'Annonces Google', 'Paid Social': 'Publicité sur les réseaux', Email: 'E-mails', 'Organic Maps': 'Google Maps',
  'Organic Video': 'Vidéos', Display: 'Bannières', Unassigned: 'Non attribué', 'Cross-network': 'Campagnes Google' };
const DEVICE = { mobile: 'Téléphone', desktop: 'Ordinateur', tablet: 'Tablette', 'smart tv': 'Télévision' };
const INSIGHT_ERROR = { not_connected: 'La connexion Google de l’agence est à renouveler.', no_access: 'Le compte Google de l’agence n’a plus accès à ces chiffres.',
  unavailable: 'Google ne répond pas pour l’instant.' };

/** Change against the period before: an arrow and the figure, green when it is good news (`lowerIsBetter` for a position). */
function delta(cur, prev, lowerIsBetter = false) {
  if (!prev) return '';
  const change = (cur - prev) / prev;
  if (Math.abs(change) < .005) return '<span class="delta">=</span>';
  const good = lowerIsBetter ? change < 0 : change > 0;
  return `<span class="delta ${good ? 'up' : 'down'}" title="Par rapport à la période d’avant">${change > 0 ? '▲' : '▼'} ${Math.abs(Math.round(100 * change)).toLocaleString(locale())} %</span>`;
}
const tile = (label, value, change, hint = '') => `<div class="meter stat"><span class="muted small">${label}</span><strong>${value}</strong>${change}${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;

/** One series a day, as a line with its area; hovering a day shows its figure. */
function lineChart(points, label) {
  const W = 640, H = 160, top = 12, bottom = 22;
  const max = Math.max(1, ...points.map(p => p.value));
  const x = i => points.length < 2 ? W / 2 : (i * W) / (points.length - 1);
  const y = v => top + (H - top - bottom) * (1 - v / max);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  return `<figure class="linechart" data-points='${esc(JSON.stringify(points))}' data-label="${esc(label)}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      <line x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}" class="grid"/><line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="axis"/>
      <path d="${line}L${x(points.length - 1)},${y(0)}L0,${y(0)}Z" class="area"/><path d="${line}" class="line"/>
      <line class="cross" x1="0" x2="0" y1="${top}" y2="${y(0)}" hidden/></svg>
    <span class="ymax small muted">${num(max)}</span>
    <div class="xaxis small muted"><span>${shortDay(points[0].date)}</span><span>${shortDay(points[points.length - 1].date)}</span></div>
    <div class="tip" hidden></div></figure>`;
}
function wireCharts(root) {
  for (const f of $$('.linechart', root)) {
    const points = JSON.parse(f.dataset.points), svg = $('svg', f), cross = $('.cross', f), tip = $('.tip', f);
    const at = e => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(points.length - 1, Math.round((e.clientX - r.left) / r.width * (points.length - 1))));
      const px = points.length < 2 ? r.width / 2 : i * r.width / (points.length - 1);
      cross.setAttribute('x1', px * 640 / r.width); cross.setAttribute('x2', px * 640 / r.width); cross.hidden = false;
      tip.hidden = false;
      tip.innerHTML = `<strong>${num(points[i].value)}</strong> <span class="muted">${esc(f.dataset.label.toLowerCase())}</span><br><span class="muted">${new Date(`${points[i].date}T12:00:00`).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}</span>`;
      tip.style.left = `${Math.max(0, Math.min(r.width - tip.offsetWidth, px - tip.offsetWidth / 2))}px`;
    };
    svg.addEventListener('pointermove', at);
    svg.addEventListener('pointerleave', () => { cross.hidden = true; tip.hidden = true; });
  }
}

/** The largest first, each with a bar on the same scale; `value` and `extra` say what to show. */
function topList(title, rows, { label = r => r.label, value = r => r.value, show = v => num(v), extra = () => '', empty = 'Rien sur cette période.', translate = false } = {}) {
  const max = Math.max(1, ...rows.map(value));
  return `<div class="card stack toplist"><h3>${title}</h3>${rows.length ? `<ol>${rows.map(r => `<li>
      <div class="tl-row"><span class="tl-label ${translate ? '' : 'no-translate'}" title="${esc(label(r))}">${esc(label(r))}</span><strong>${show(value(r))}</strong></div>
      <div class="tl-bar"><i style="width:${Math.max(1, 100 * value(r) / max)}%"></i></div>${extra(r)}</li>`).join('')}</ol>` : `<p class="muted small">${empty}</p>`}</div>`;
}

const pagePath = url => { try { return decodeURI(new URL(url).pathname); } catch { return url; } };

function analyticsSection(a, err) {
  if (!a) return `<section class="section"><h2>Visites du site</h2><div class="banner">${INSIGHT_ERROR[err] || INSIGHT_ERROR.unavailable}</div></section>`;
  const c = a.current, p = a.previous;
  const total = a.devices.reduce((t, r) => t + r.value, 0) || 1;
  return `<section class="section stack"><div class="side-head"><h2>Visites du site</h2><span class="muted small">Google Analytics · ${shortDay(a.range.startDate)} – ${shortDay(a.range.endDate)}</span></div>
    ${a.stale ? `<div class="banner small">${INSIGHT_ERROR[err] || INSIGHT_ERROR.unavailable} Chiffres du ${when(a.stale)}.</div>` : ''}
    <div class="meters">
      ${tile('Visiteurs', num(c.users), delta(c.users, p.users), 'Personnes différentes')}
      ${tile('Visites', num(c.sessions), delta(c.sessions, p.sessions))}
      ${tile('Pages vues', num(c.views), delta(c.views, p.views))}
      ${tile('Temps par visite', duration(c.duration), delta(c.duration, p.duration), `${share(c.engagement)} des visites sont actives`)}
    </div>
    <div class="card">${lineChart(a.daily, 'Visiteurs')}</div>
    <div class="stat-grid">
      ${topList('Pages les plus vues', a.pages, { label: r => r.label })}
      ${topList('D’où viennent les visiteurs', a.channels.map(r => ({ ...r, label: CHANNEL[r.label] || r.label })), { translate: true, show: v => `${num(v)} visites` })}
      ${topList('Appareils', a.devices.map(r => ({ ...r, label: DEVICE[r.label] || r.label })), { translate: true, show: v => share(v / total) })}
      ${topList('Villes', a.cities, { empty: 'Pas encore assez de visites.' })}
    </div></section>`;
}

function searchSection(g, err) {
  if (!g) return `<section class="section"><h2>Sur Google</h2><div class="banner">${INSIGHT_ERROR[err] || INSIGHT_ERROR.unavailable}</div></section>`;
  const c = g.current, p = g.previous;
  const pos = v => v ? v.toLocaleString(locale(), { maximumFractionDigits: 1 }) : '–';
  const detail = r => `<span class="hint">${num(r.impressions)} apparitions · position ${pos(r.position)}</span>`;
  return `<section class="section stack"><div class="side-head"><h2>Sur Google</h2><span class="muted small">Search Console · ${shortDay(g.range.startDate)} – ${shortDay(g.range.endDate)}</span></div>
    ${g.stale ? `<div class="banner small">${INSIGHT_ERROR[err] || INSIGHT_ERROR.unavailable} Chiffres du ${when(g.stale)}.</div>` : ''}
    <div class="meters">
      ${tile('Clics depuis Google', num(c.clicks), delta(c.clicks, p.clicks), 'Visites venues des résultats de recherche')}
      ${tile('Apparitions', num(c.impressions), delta(c.impressions, p.impressions), 'Fois où le site s’est affiché dans Google')}
      ${tile('Taux de clic', share(c.ctr, 1), delta(c.ctr, p.ctr))}
      ${tile('Position moyenne', pos(c.position), delta(c.position, p.position, true), '1 = tout en haut de Google')}
    </div>
    <div class="card">${lineChart(g.daily, 'Clics depuis Google')}</div>
    <div class="stat-grid">
      ${topList('Recherches qui mènent au site', g.queries, { value: r => r.clicks, show: v => `${num(v)} clics`, extra: detail })}
      ${topList('Pages les plus trouvées', g.pages, { label: r => pagePath(r.label), value: r => r.clicks, show: v => `${num(v)} clics`, extra: detail })}
    </div></section>`;
}

/** The site's figures: visits, then Google searches, over 7, 28 or 90 days. */
async function stats(siteId) {
  const days = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('days')) || 28;
  const s = me.sites.find(x => x.id === siteId) || { id: siteId, name: '' };
  app.innerHTML = topbar(`<span class="muted">/</span><a class="crumb no-translate" href="#/site/${siteId}">${esc(s.name)}</a><span class="muted">/</span><span>Statistiques</span>`) + `<main class="page">
    <div class="hello"><div><h1>Statistiques</h1><p class="muted">Qui visite le site et comment on le trouve sur Google.</p></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <div class="seg" role="group" aria-label="Période">${[7, 28, 90].map(n => `<button type="button" data-days="${n}" class="${n === days ? 'on' : ''}">${n} jours</button>`).join('')}</div>
        ${me.user.agency ? `<button class="btn small ghost" id="refresh" title="Redemander les chiffres à Google">${icon('refresh', 16)}</button>` : ''}</div></div>
    <div id="figures">${emptyNini('Je demande les chiffres à Google…', 'loading')}</div></main>`;
  wireTop();
  $$('[data-days]').forEach(b => b.addEventListener('click', () => { location.hash = `#/site/${siteId}/stats?days=${b.dataset.days}`; }));
  const load = async (refresh = false) => {
    try {
      const d = await api(`/api/sites/${siteId}/insights?days=${days}${refresh ? '&refresh=1' : ''}`);
      const a = d.analytics, g = d.search;
      // one sentence in plain words, written in both languages here (the translation layer works text by text)
      const en = document.documentElement.lang === 'en';
      const change = a?.previous.users ? ` (${a.current.users >= a.previous.users ? '+' : '−'}${Math.abs(Math.round(100 * (a.current.users - a.previous.users) / a.previous.users))} % ${en ? `on the ${days} days before` : `par rapport aux ${days} jours d’avant`})` : '';
      const said = [a && (en ? `<strong>${num(a.current.users)}</strong> people visited the site${change}` : `<strong>${num(a.current.users)}</strong> personnes ont visité le site${change}`),
        g && (en ? `Google showed it <strong>${num(g.current.impressions)}</strong> times in its results, for <strong>${num(g.current.clicks)}</strong> clicks`
          : `Google l’a montré <strong>${num(g.current.impressions)}</strong> fois dans ses résultats, pour <strong>${num(g.current.clicks)}</strong> clics`)].filter(Boolean);
      $('#figures').innerHTML = `${said.length ? `<div class="banner info no-translate">${en ? `Over the last ${days} days, ${said.join(', and ')}.` : `Ces ${days} derniers jours, ${said.join(', et ')}.`}</div>` : ''}
        ${d.analytics || d.analyticsError ? analyticsSection(a, d.analyticsError) : ''}
        ${d.search || d.searchError ? searchSection(g, d.searchError) : ''}
        <p class="hint" style="margin-top:28px">Chiffres de Google, repris toutes les 6 heures (dernière fois ${when(d.at)}). Search Console donne ses chiffres avec 2 à 3 jours de retard.</p>`;
      wireCharts($('#figures'));
    } catch (e) { $('#figures').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
  };
  $('#refresh')?.addEventListener('click', () => { $('#figures').innerHTML = emptyNini('Je redemande les chiffres à Google…', 'loading'); load(true); });
  load();
}

/** On the site's home: the last 28 days in four figures, and the way to the whole page. */
async function glance(box, siteId) {
  const d = await api(`/api/sites/${siteId}/insights?days=28`).catch(() => null);
  if (!d || (!d.analytics && !d.search)) return;
  const a = d.analytics?.current, ap = d.analytics?.previous, g = d.search?.current, gp = d.search?.previous;
  box.innerHTML = `<div class="side-head" style="margin-bottom:12px"><h2>Ces 28 derniers jours</h2><a class="btn small" href="#/site/${siteId}/stats">${icon('chart', 16)} Toutes les statistiques</a></div>
    <div class="meters">${[a && tile('Visiteurs', num(a.users), delta(a.users, ap.users)), a && tile('Pages vues', num(a.views), delta(a.views, ap.views)),
      g && tile('Clics depuis Google', num(g.clicks), delta(g.clicks, gp.clicks)), g && tile('Apparitions dans Google', num(g.impressions), delta(g.impressions, gp.impressions))].filter(Boolean).join('')}</div>`;
  box.hidden = false;
}

// ------------------------------------------------------------------ one change

async function change(id) {
  const c = await api(`/api/changes/${id}`);
  if (c.type === 'post') return postEditor(c);
  if (c.type === 'request') return requestScreen(c);
  return workspace(c);
}

function crumbsFor(c) {
  return `<span class="muted">/</span><a class="crumb" href="#/site/${c.site.id}">${esc(c.site.name)}</a>`;
}

/** The before/after card of one operation. */
function opCard(c, it) {
  const val = (v, side) => {
    if (it.field === 'src') {
      const src = side === 'a' && it.afterMedia ? it.afterMedia : v ? c.liveOrigin + v : '';
      return src ? `<img src="${esc(src)}" alt="">` : '<span class="muted">—</span>';
    }
    if (Array.isArray(v)) return `<ul>${v.map(x => `<li>${esc(strip(x))}</li>`).join('')}</ul>`;
    return v == null || v === '' ? '<span class="muted">(vide)</span>' : esc(strip(v));
  };
  let body;
  if (it.field === 'src') body = `<div class="ba"><div class="b"><label>Avant</label>${val(it.before, 'b')}</div><div class="a"><label>Après</label>${val(it.after, 'a')}</div></div>`;
  else if (it.field === 'file') body = `<pre class="patch no-translate">${esc(it.patch || '').split('\n').map(l => `<span class="${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'at' : ''}">${l || ' '}</span>`).join('')}</pre>`;
  else if (it.field === 'post') body = `<div class="ba"><div class="a" style="grid-column:1/-1"><label>Nouvelle page</label>${esc(it.after || it.before)}</div></div>`;
  else if (Array.isArray(it.before) || Array.isArray(it.after)) body = `<div class="ba"><div class="b"><label>Avant</label>${val(it.before)}</div><div class="a"><label>Après</label>${val(it.after)}</div></div>`;
  else body = `<div class="ba"><div class="a" style="grid-column:1/-1"><label>Changement</label>${diff(it.before, it.after)}</div></div>`;
  const canSee = !['price', 'seo', 'shared', 'file'].includes(it.kind);
  const hint = { seo: 'Visible dans les résultats Google, pas sur la page.', price: 'Visible sur la fiche produit et dans la pré-commande.',
    shared: 'Texte commun : visible sur toutes les pages qui l’utilisent. Vérifiez-le sur le site de test.', file: 'Changement de code : vérifiez-le sur le site de test avant de publier.' }[it.kind];
  return `<div class="card">
    <div class="card-head"><div class="t"><strong>${esc(it.what)}</strong><div class="where">${esc(it.pageTitle)} · ${esc(it.url)}</div></div></div>
    ${body}
    <div class="card-foot">
      ${canSee ? `<button class="btn small" data-see="${esc(it.url)}" data-idx="${it.index}">${icon('eye', 16)} Voir sur la page</button>` : `<span class="hint">${hint}</span>`}
      ${c.can.edit ? `<button class="btn small ghost danger" data-remove="${it.index}">${icon('x', 16)} Retirer</button>` : ''}
    </div></div>`;
}

/** Where the preview of a change is: none, building, ready, outdated (edited since), replaced, failed. */
function previewState(c) {
  if (c.previewReady) return 'ready';
  if (c.previewReplaced) return 'replaced';
  return { building: 'building', failed: 'failed', outdated: 'outdated' }[c.preview] || 'none';
}
const previewPolls = c => previewState(c) === 'building';
const minutesSince = iso => iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)) : 0;

/** The preview line: state, and what can be done (prepare, open, share, try again). */
function previewStatus(c) {
  if (!c.items.length) return '';
  const st = previewState(c);
  const local = c.previewBy === 'local';
  if (local && st !== 'failed') return `<span class="status ${st === 'ready' ? 'ready' : 'building'}"><i></i>${st === 'ready' ? 'Aperçu prêt' : 'Préparation de l’aperçu…'}</span>`;
  const prepare = (label) => c.can.edit || c.can.approve || c.can.unschedule ? `<button class="btn small" data-preview>${icon('eye', 16)} ${label}</button>` : '';
  if (st === 'building') {
    const m = minutesSince(c.previewStarted);
    return `<span class="status building"><i></i>Aperçu en préparation${m ? ` depuis ${m} min` : ''} · prêt en 1 à 5 minutes</span>`;
  }
  if (st === 'ready') return `<span class="status ready"><i></i>Aperçu prêt</span>`
    + (c.previewLink ? ` <button class="btn small ghost" data-share="${esc(c.previewLink)}">Lien à partager</button>` : '');
  if (st === 'failed') return `<span class="status failed" title="${esc(c.preview_log || '')}"><i></i>L’aperçu n’a pas pu être construit</span> ${prepare('Réessayer')}`;
  const why = st === 'outdated' ? 'L’aperçu ne montre plus les derniers changements.' : st === 'replaced' ? 'L’adresse d’aperçu montre maintenant un autre changement.' : '';
  return `<span class="hint">${why ? why + ' ' : ''}Un aperçu complet du site est prêt en 1 à 5 minutes : utile pour les gros changements. Pour un texte ou une photo, l’avant/après ci-dessous suffit.</span> ${prepare(st === 'none' ? 'Voir l’aperçu complet' : 'Refaire l’aperçu')}`;
}

/** Buttons of the preview line. */
function wirePreview(c, root, after) {
  $$('[data-preview]', root).forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/api/changes/${c.id}/preview`, {}); toast('Aperçu demandé : il sera prêt dans 1 à 5 minutes. Vous pouvez continuer en attendant.', 5000); }
    catch (e) { toast(e.message); }
    after?.();
  }));
  $$('[data-share]', root).forEach(b => b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.dataset.share);
    toast('Lien copié : il montre l’aperçu en cours du site, sans compte, jusqu’à sa publication.', 5000);
  }));
}

/** Above the proposed changes: where the staging site stands, and one click to see it, open it or bring it up to date. */
function stagingStrip(c) {
  if (!c.items.length) return '';
  const st = previewState(c), may = c.can.edit || c.can.approve || c.can.unschedule;
  const see = `<button class="btn small" data-pane-go="staging">${icon('eye', 16)} Voir le site de test</button>`;
  const open = c.stagingVersion && st !== 'replaced'
    ? `<a class="btn small ghost" href="${esc(c.previewOrigin + (c.items.find(it => it.url)?.url || '/'))}" target="_blank" rel="noopener">${icon('out', 16)} Ouvrir dans un onglet</a>` : '';
  const build = label => may ? `<button class="btn small primary" data-preview>${icon('refresh', 16)} ${label}</button>` : '';
  const [dot, text, btns] = st === 'ready' ? ['ready', 'Le site de test montre ces changements.', see + open]
    : st === 'building' ? ['building', 'Le site de test se met à jour : prêt en 1 à 5 minutes.', see]
    : st === 'failed' ? ['failed', 'Le site de test n’a pas pu être mis à jour.', build('Réessayer')]
    : st === 'outdated' ? ['building', 'Le site de test montre une version précédente.', build('Mettre à jour') + see]
    : st === 'replaced' ? ['', 'Le site de test montre maintenant un autre changement.', build('Y remettre ce changement')]
    : ['', 'Voyez tout le site avec ces changements avant de publier.', build('Préparer le site de test')];
  return `<div class="staging-strip">${dot ? `<span class="status ${dot}"><i></i></span>` : icon('eye', 16)}<span class="hint">${text}</span>${btns}</div>`;
}

// ---- the staging site, live in the side panel: one test address per site, updated on request

const STEPS = { sending: 'Envoi des changements', queued: 'En attente d’une machine', clone: 'Copie du site',
  'restore-cache': 'Reprise des images déjà préparées', build: 'Construction des pages', upload: 'Mise en ligne du site de test' };

function stagingPanel(c, root, after) {
  if (!c.items.length) { root.innerHTML = ''; return; }
  const st = previewState(c);
  const may = (c.can.edit || c.can.approve || c.can.unschedule) && c.previewBy !== 'local';
  const shows = c.stagingVersion && st !== 'replaced';
  const pages = [...new Map(c.items.filter(it => it.url).map(it => [it.url, it.pageTitle])).entries()];
  if (!root.dataset.page || !pages.some(([u]) => u === root.dataset.page)) root.dataset.page = pages[0]?.[0] || '/';
  root.dataset.device ||= 'desktop';

  const update = !may || st === 'building' ? ''
    : st === 'ready' ? `<button class="btn ghost small" data-preview title="Reconstruit le site de test, par exemple si le site en ligne a changé depuis">${icon('refresh', 16)} Refaire</button>`
    : `<button class="btn primary small" data-preview>${icon('refresh', 16)} ${st === 'none' ? 'Préparer le site de test' : 'Mettre à jour le site de test avec les derniers changements'}</button>`;
  const note = st === 'outdated' ? 'Le site de test montre une version précédente : mettez-le à jour pour voir vos derniers changements.'
    : st === 'replaced' ? 'Le site de test montre maintenant un autre changement.'
    : st === 'failed' ? 'Le site de test n’a pas pu être mis à jour.'
    : st === 'none' ? 'Tout le site avec vos changements, prêt en 1 à 5 minutes : utile pour les gros changements. Pour un texte ou une photo, l’avant/après des changements proposés suffit.' : '';
  const p = c.previewProgress, pct = st === 'building' ? Math.max(1, p?.pct ?? 1) : 0, m = minutesSince(c.previewStarted);

  const head = `<div class="staging-head">
      <h3>Site de test</h3>
      ${st === 'ready' ? '<span class="status ready"><i></i>À jour</span>' : st === 'building' ? '<span class="status building"><i></i>Mise à jour…</span>' : st === 'failed' ? '<span class="status failed"><i></i>Échec</span>' : ''}
      <span class="spacer"></span>
      ${shows ? `<div class="seg mini"><button data-dev="desktop" class="${root.dataset.device === 'desktop' ? 'on' : ''}">Ordinateur</button><button data-dev="mobile" class="${root.dataset.device === 'mobile' ? 'on' : ''}">Mobile</button></div>` : ''}
    </div>
    ${pages.length > 1 && shows ? `<div class="chips">${pages.map(([u, t]) => `<button class="chip ${u === root.dataset.page ? 'on' : ''}" data-page="${esc(u)}">${esc(t || u)}</button>`).join('')}</div>` : ''}
    ${st === 'building' ? `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
      <div class="progress-line"><span>${esc(STEPS[p?.step] || STEPS.sending)}</span><span class="no-translate">${pct} %</span>${m ? `<span class="no-translate">${m} min</span>` : ''}<span class="spacer"></span><span class="hint">Prêt en 1 à 5 minutes. Vous pouvez continuer en attendant.</span></div>` : ''}
    ${note || update || c.previewLink || shows ? `<div class="preview-line">${note ? `<span class="hint">${note}</span>` : ''}${update}${c.previewLink ? `<button class="btn small ghost" data-share="${esc(c.previewLink)}">Lien à partager</button>` : ''}${shows ? `<a class="btn small ghost" href="${esc(c.previewOrigin + root.dataset.page)}" target="_blank" rel="noopener">${icon('out', 16)} Ouvrir dans un onglet</a>` : ''}</div>` : ''}`;

  // the frame is kept while the same version is shown, so polling never reloads the page being looked at
  let stage = $('.stage', root);
  const key = shows ? `${c.stagingVersion}|${root.dataset.page}|${root.dataset.device}` : '';
  if (!stage || stage.dataset.key !== key) {
    root.innerHTML = '<div class="staging-top"></div><div class="stage"></div>';
    stage = $('.stage', root);
    stage.dataset.key = key;
    stage.classList.toggle('mobile', root.dataset.device === 'mobile');
    stage.innerHTML = shows
      ? `<iframe src="${esc(`${c.previewOrigin}${root.dataset.page}?v=${encodeURIComponent(c.stagingVersion)}#claudepress=${marks(c, root.dataset.page)}`)}" title="Site de test"></iframe>`
      : `<div class="none">${nini('preview')}<span>${st === 'building' ? 'Le site de test se prépare. Il s’affichera ici.' : 'Le site de test n’est pas encore préparé.'}</span></div>`;
    fitStage(stage);
  }
  stage.classList.toggle('dim', st === 'building' || st === 'outdated');
  $('.staging-top', root).innerHTML = head;
  wirePreview(c, root, after);
  $$('[data-dev]', root).forEach(b => b.addEventListener('click', () => { root.dataset.device = b.dataset.dev; stagingPanel(c, root, after); }));
  $$('[data-page]', root).forEach(b => b.addEventListener('click', () => { root.dataset.page = b.dataset.page; stagingPanel(c, root, after); }));
}

// labels drawn inside the site's own pages, which the interface translation does not reach
const inPage = t => document.documentElement.lang === 'en' ? { Modifié: 'Changed', Avant: 'Before' }[t] : t;

/** The changed texts and photos of a page, highlighted in the staging frame. */
const marks = (c, url) => {
  const items = c.items.filter(it => it.url === url);
  return encodeURIComponent(JSON.stringify({ t: items.flatMap(it => it.hlAfter.texts).filter(Boolean), i: items.flatMap(it => it.hlAfter.images).filter(Boolean), label: inPage('Modifié') }));
};

// A preview frame says how many of the changed texts and photos it could outline on its page: when some are
// nowhere to be seen, the site's templates do not display them, and publishing would change nothing visible.
addEventListener('message', e => {
  if (e.data?.claudepress !== 'found' || !(e.data.wanted > 0)) return;
  const f = $$('iframe').find(x => x.contentWindow === e.source);
  if (!f || f.dataset.side === 'b') return;
  const box = f.parentElement, { wanted, count } = e.data, missing = wanted - count;
  $('.frame-note', box)?.remove();
  if (missing <= 0) return;
  const what = wanted === 1 ? 'Ce changement ne se voit pas sur cette page.' : missing === wanted ? 'Ces changements ne se voient pas sur cette page.' : `${missing} changements sur ${wanted} ne se voient pas sur cette page.`;
  box.insertAdjacentHTML('beforeend', `<div class="frame-note"><strong>${what}</strong> <span>Le site ne l’affiche peut-être pas : regardez bien avant de publier, ou demandez à l’agence.</span></div>`);
});

/** Shows the site at desktop width, scaled down to the panel. */
function fitStage(stage) {
  const f = $('iframe', stage);
  if (!f) return;
  const fit = () => {
    if (stage.classList.contains('mobile')) { f.style.cssText = ''; return; }
    const s = Math.min(1, stage.clientWidth / 1280);
    f.style.cssText = `width:${100 / s}%;height:${100 / s}%;transform:scale(${s});transform-origin:0 0`;
  };
  new ResizeObserver(fit).observe(stage);
  fit();
}

function actionBar(c) {
  const b = [], day = suggestion(c);
  // a day asked for makes scheduling the first choice; publishing at once stays one click away
  const schedule = (label, other) => day
    ? `<button class="btn primary" data-act="schedule" data-at="${esc(day)}">${icon('clock', 18)} ${label} ${atText(day)}</button><button class="btn" data-act="${other}">${other === 'approve' ? 'Approuver et publier maintenant' : 'Publier maintenant'}</button><button class="btn ghost" data-act="schedule">Autre date…</button>`
    : `<button class="btn" data-act="schedule">${icon('clock', 18)} Programmer…</button>`;
  if (c.can.approve) {
    if (day) b.push(schedule('Approuver et programmer pour le', 'approve'));
    else b.push(`<button class="btn primary" data-act="approve">${icon('check', 18)} Approuver et publier</button>`, schedule());
    b.push('<button class="btn" data-act="request-changes">Demander une correction</button>');
  }
  if (c.can.publish) b.push((day ? schedule('Programmer pour le', 'publish') : `<button class="btn primary" data-act="publish">${icon('check', 18)} Publier sur le site</button>${schedule()}`)
    + (c.previewBy !== 'local' && !c.previewReady ? '<span class="hint">Sans aperçu, c’est possible : ce qui est listé est exactement ce qui sera publié.</span>' : ''));
  if (c.can.unschedule) b.push(`<button class="btn" data-act="publish">${icon('check', 18)} Publier maintenant</button><button class="btn" data-act="unschedule">Annuler la programmation</button>`);
  if (c.can.submit) b.push(`<button class="btn primary" data-act="submit">${icon('send', 18)} Demander la validation</button>`
    + (c.agencyApproval?.length ? `<span class="hint">L’agence valide avant la mise en ligne : ${c.agencyApproval.map(k => `<span>${KIND[k]}</span>`).join(', ')}</span>` : ''));
  if (c.can.undo) b.push(`<button class="btn" data-act="undo">${icon('undo', 18)} Annuler cette modification</button>`);
  if (c.can.discard) b.push('<span class="spacer"></span><button class="btn ghost danger" data-act="discard">Abandonner</button>');
  return b.length ? `<div class="bar">${b.join('')}</div>` : '';
}

function reviewBanner(c) {
  const failed = c.schedule_error ? `<div class="banner bad">La publication programmée n’a pas pu se faire : ${esc(c.schedule_error)}</div>` : '';
  const wished = c.suggested_at ? `<div style="margin-top:6px">Mise en ligne souhaitée le ${atText(c.suggested_at)}</div>` : '';
  if (c.status === 'scheduled') return `<div class="banner info">${icon('clock', 18)} Programmé pour le ${atText(c.publish_at)}${c.scheduledBy ? `, par ${esc(c.scheduledBy)}` : ''}. Le site ne change pas d’ici là.</div>`;
  if (c.status === 'pending') return failed + `<div class="banner">${c.can.approve ? `<strong>${esc(c.author)}</strong> demande à publier ces changements.` : 'En attente de validation.'}${c.review_comment ? `<div style="margin-top:6px">« ${esc(c.review_comment)} »</div>` : ''}${wished}</div>`;
  if (c.status === 'draft' && failed) return failed;
  if (c.status === 'changes_requested') return `<div class="banner bad"><strong>${esc(c.reviewer)}</strong> demande une correction : « ${esc(c.review_comment)} »</div>`;
  if (c.status === 'published') {
    if (c.live && !['live', 'unverified', 'local'].includes(c.live.state)) setTimeout(() => followLive(c));
    return `<div class="banner info">Publié ${when(c.published)}${c.reviewer ? `, validé par ${esc(c.reviewer)}` : ''}.${c.commit_sha ? ` <span class="muted small">Version ${esc(c.commit_sha)}</span>` : ''}</div>
      ${c.live ? `<div id="live-${c.id}">${liveLine(c)}</div>` : ''}`;
  }
  if (c.status === 'discarded') return '<div class="banner bad">Cette modification a été abandonnée.</div>';
  return '';
}

// ------------------------------------------------------------------ going live (server/golive.ts)

/** Once published, is the change on the live site: checking, live, late, failed. Clients get a calm word, administrators the cause. */
function liveLine(c) {
  const l = c.live, agency = me.user.agency;
  if (!l) return '';
  const check = c.can.checkLive ? ' <button class="btn small" data-live-check>Vérifier maintenant</button>' : '';
  const why = agency ? ` <a class="btn small" href="#/admin/site/${c.site.id}" data-to-golive>Voir comment le mettre en ligne</a>` : '';
  if (l.state === 'checking') return `<div class="banner live-line checking"><i class="live-dot"></i><span>Mise en ligne en cours : ClaudePress vérifie que le changement apparaît sur le site en ligne.</span></div>`;
  if (l.state === 'live') return `<div class="banner live-line ok">${icon('check', 16)} <span>Sur le site en ligne</span> <span>${when(l.at)}</span>${l.url ? ` · <a href="${esc(l.url)}" target="_blank" rel="noopener">${icon('out', 14)}</a>` : ''}</div>`;
  if (l.state === 'local') return '<div class="banner live-line">Publié sur ce serveur seulement : l’envoi vers GitHub est désactivé pour ce site.</div>';
  if (l.state === 'unverified') return '<div class="banner live-line">Publié sur GitHub. Ce changement ne se voit pas sur une page : ClaudePress n’a pas pu le vérifier sur le site en ligne.</div>';
  if (!agency) return '<div class="banner live-line">La mise en ligne prend plus de temps que d’habitude. Votre agence est prévenue.</div>';
  if (l.state === 'failed') return `<div class="banner bad live-line"><div><div><strong>La mise en ligne a échoué.</strong>${l.detail ? ` <span class="no-translate">${esc(l.detail)}</span>` : ''}</div>
    <div class="live-actions">${l.url ? `<a class="btn small" href="${esc(l.url)}" target="_blank" rel="noopener">${icon('out', 16)} Voir le journal</a>` : ''}${check}${why}</div></div></div>`;
  return `<div class="banner bad live-line"><div><div><strong>Pas encore sur le site en ligne</strong> · <span>${dur(minutesSince(c.published), 1)} après la publication.</span></div>
    <div>Le changement est sur GitHub, mais le site en ligne montre toujours l’ancienne version : rien ne semble le mettre en ligne.</div>
    <div class="live-actions">${check}${why}</div></div></div>`;
}

/** While a change is on its way, its line is read again every 15 seconds (as long as it is on screen). */
const liveFollowed = new Set();
function followLive(c) {
  const box = $(`#live-${c.id}`);
  if (!box) return;
  const draw = () => { box.innerHTML = liveLine(c); wire(); };
  function wire() {
    $('[data-live-check]', box)?.addEventListener('click', async e => {
      e.target.disabled = true;
      try { await api(`/api/changes/${c.id}/live`, {}); Object.assign(c, await api(`/api/changes/${c.id}`)); draw(); toast(c.live?.state === 'live' ? 'Le changement est sur le site en ligne.' : 'Toujours pas sur le site en ligne.'); }
      catch (err) { toast(err.message); e.target.disabled = false; }
    });
  }
  wire();
  if (c.live?.state !== 'checking' || liveFollowed.has(c.id)) return;
  liveFollowed.add(c.id);
  const poll = async () => {
    if (!box.isConnected) return liveFollowed.delete(c.id);
    try { Object.assign(c, await api(`/api/changes/${c.id}`)); if (box.isConnected) draw(); } catch {}
    if (c.live?.state === 'checking' && box.isConnected) setTimeout(poll, 15000); else liveFollowed.delete(c.id);
  };
  setTimeout(poll, 15000);
}

const LIVE_PILL = { checking: ['pending', 'Mise en ligne…'], late: ['changes_requested', 'Pas encore en ligne'], failed: ['changes_requested', 'Mise en ligne échouée'] };
// a link to a site's page that should open on its go-live card
document.addEventListener('click', e => { if (e.target.closest?.('[data-to-golive]')) try { sessionStorage.setItem('to-golive', '1'); } catch {} });

/** A site's go-live in a line, for the list of sites. */
const liveSiteLine = s => {
  const g = s.golive;
  if (!g) return '';
  if (g.late) return `<span class="pill changes_requested">${g.late > 1 ? `${g.late} changements pas encore en ligne` : '1 changement pas encore en ligne'}</span> <a href="#/admin/site/${s.id}" data-to-golive>Voir pourquoi</a>`;
  if (g.kind === 'local') return '<span class="muted">Publications gardées sur ce serveur</span>';
  if (g.kind === 'host' || g.kind === 'workflow') return `<span class="muted">Mise en ligne automatique :</span> <span class="no-translate">${esc(g.host || 'GitHub Actions')}</span>`;
  if (g.seenLive) return '<span class="muted">Mise en ligne vérifiée sur le site</span>';
  if (g.kind === 'none') return `<span class="warn-ink">Rien ne semble mettre ce site en ligne quand GitHub change.</span> <a href="#/admin/site/${s.id}" data-to-golive>Vérifier</a>`;
  return '';
};
const liveOk = g => !!g && !g.late && (g.kind === 'host' || g.kind === 'workflow' || !!g.seenLive);

// how to set up a deploy with each kind of host: the steps, in plain words
const HOST_GUIDES = {
  Netlify: ['Dans Netlify, choisissez « Add new site », puis « Import an existing project » et GitHub.',
    'Choisissez le dépôt et la branche indiqués ci-dessus, avec la commande de construction et le dossier construit.',
    'Netlify met ensuite le site en ligne à chaque changement publié, en une à deux minutes.'],
  Vercel: ['Dans Vercel, choisissez « Add New », puis « Project », et importez le dépôt depuis GitHub.',
    'Dans « Settings », puis « Git », vérifiez que la branche de production est celle indiquée ci-dessus.',
    'Vercel met ensuite le site en ligne à chaque changement publié, en une à deux minutes.'],
  'Cloudflare Pages': ['Dans Cloudflare, ouvrez « Workers & Pages », puis « Create », « Pages » et « Connect to Git ».',
    'Choisissez le dépôt, la branche de production indiquée ci-dessus, la commande de construction et le dossier construit.',
    'Cloudflare met ensuite le site en ligne à chaque changement publié, en une à deux minutes.'],
  'GitHub Pages': ['Dans GitHub, ouvrez le dépôt, puis « Settings » et « Pages ».',
    'Sous « Source », choisissez « GitHub Actions » si le site doit être construit, sinon « Deploy from a branch » et la branche indiquée ci-dessus.',
    'GitHub met ensuite le site en ligne à chaque changement publié.'],
  'Firebase Hosting': ['Dans le dossier du site, lancez la commande firebase init hosting:github : Firebase ajoute au dépôt l’action qui met le site en ligne.',
    'Répondez oui quand il propose de déployer le site en ligne à chaque fusion, et indiquez la branche ci-dessus.',
    'Firebase met ensuite le site en ligne à chaque changement publié.'],
  Hostinger: ['Dans hPanel, ouvrez le site, puis « Avancé » et « GIT », et ajoutez le dépôt avec la branche indiquée ci-dessus.',
    'Activez le déploiement automatique : hPanel donne une adresse de webhook. Dans GitHub, ouvrez le dépôt, puis « Settings », « Webhooks » et « Add webhook », et collez-la.',
    'Hostinger copie le dépôt tel quel, sans le construire : si le site doit être construit, choisissez plutôt « Un hébergement FTP ».'],
  FTP: ['Ajoutez cette action GitHub au dépôt, dans le fichier .github/workflows/deploy.yml : elle construit le site et envoie le dossier construit par FTP à chaque changement.',
    'Dans GitHub, ouvrez le dépôt, puis « Settings », « Secrets and variables » et « Actions », et ajoutez FTP_SERVER, FTP_USERNAME et FTP_PASSWORD (votre hébergeur les donne).',
    'Vérifiez le dossier du site sur le serveur (server-dir) : souvent public_html.'],
  unknown: ['Copiez ce message dans Claude Code, ouvert dans le dossier du site : il trouve où le site est hébergé et met en place la mise en ligne automatique avec vous.'],
};
const HOST_NAMES = { FTP: 'Un hébergement FTP', unknown: 'Je ne sais pas' };

/** A workflow that builds the site and sends it by FTP: a starting point for hosts that only offer FTP. */
const ftpWorkflow = v => `name: Deploy
on:
  push:
    branches: [${v.branch}]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: if [ -f package-lock.json ]; then npm ci; fi; if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
${v.build ? `      - run: ${v.build}\n` : ''}      - uses: SamKirkland/FTP-Deploy-Action@v4.3.5
        with:
          server: \${{ secrets.FTP_SERVER }}
          username: \${{ secrets.FTP_USERNAME }}
          password: \${{ secrets.FTP_PASSWORD }}
          local-dir: ./${(v.outDir || 'site').replace(/^\.?\/|\/$/g, '')}/
          server-dir: ./public_html/
`;

/** What to ask Claude Code when the host is unknown, in the interface's language. */
const deployPrompt = v => document.documentElement.lang === 'en'
  ? `The website ${v.liveUrl} is built from the GitHub repository ${v.repo || '(this folder)'}, branch ${v.branch}${v.build ? ` (build command: ${v.build}, output folder: ${v.outDir})` : ''}. When that branch changes on GitHub, the live site does not update. Find out where the site is hosted (the domain's DNS, the repository's config files, the site's HTTP headers), then set up an automatic deploy on every push to ${v.branch}: preferably the host's own GitHub connection, otherwise a GitHub Actions workflow in .github/workflows/ with its credentials as repository secrets. Tell me what I have to do myself (accounts, secrets), and after a push, check that the live site changed.`
  : `Le site ${v.liveUrl} est construit depuis le dépôt GitHub ${v.repo || '(ce dossier)'}, branche ${v.branch}${v.build ? ` (commande de construction : ${v.build}, dossier construit : ${v.outDir})` : ''}. Quand cette branche change sur GitHub, le site en ligne ne se met pas à jour. Trouve où le site est hébergé (DNS du domaine, fichiers de configuration du dépôt, en-têtes HTTP du site), puis mets en place le déploiement automatique à chaque push sur ${v.branch} : de préférence la connexion GitHub de l’hébergeur, sinon une action GitHub dans .github/workflows/ avec ses identifiants en secrets du dépôt. Dis-moi ce que je dois faire moi-même (comptes, secrets), et vérifie après un push que le site en ligne a changé.`;

/** A site's page: how it goes live (what deploys it, how fast, its last changes) and, when nothing does, how to set it up. */
async function liveCard(box, s) {
  let v;
  try { v = await api(`/api/admin/sites/${s.id}/golive`); } catch (e) { box.hidden = true; return; }
  if (!v || !box.isConnected) return;
  const m = v.method || { kind: 'unknown' };
  const late = v.recent.filter(c => c.live === 'late' || c.live === 'failed');
  const ok = m.kind === 'host' || m.kind === 'workflow' || !!v.seenLive;
  const state = m.kind === 'local' ? '<div class="banner">Les publications restent sur ce serveur : « Publier envoie sur GitHub » est décoché dans les réglages ci-dessous.</div>'
    : late.length && m.kind !== 'none' ? ''
    : m.kind === 'host' || m.kind === 'workflow' ? `<p class="live-head ok">${icon('check', 18)} <span>Mise en ligne automatique à chaque changement publié.</span></p>`
    : v.seenLive ? `<p class="live-head ok">${icon('check', 18)} <span>Les changements publiés apparaissent bien sur le site en ligne.</span></p>
      <p class="hint">Votre hébergeur ne signale pas ses déploiements à GitHub : ClaudePress vérifie chaque changement sur le site en ligne.</p>`
    : m.kind === 'none' ? `<div class="banner bad"><strong>ClaudePress ne voit rien qui mette ce site en ligne quand GitHub change.</strong>
      <div>Aucun hébergeur n’a signalé de déploiement sur les derniers changements de la branche, et aucune action GitHub ne la déploie. Sans cela, ce que vos clients publient reste sur GitHub et le site ne change pas.</div>
      <div class="hint" style="margin-top:6px">Si votre hébergeur se met à jour sans le signaler à GitHub (par un webhook, par exemple), publiez un petit changement : ClaudePress vérifiera qu’il apparaît sur le site.</div></div>`
    : '<p class="hint">ClaudePress n’a pas pu lire comment ce site est mis en ligne. Chaque changement publié est vérifié sur le site en ligne, et vous êtes prévenu s’il n’y apparaît pas.</p>';
  const facts = [
    m.host || m.workflow ? ['Par', `<span class="no-translate">${esc(m.host || 'GitHub Actions')}</span>${m.workflow ? ` · <span class="no-translate">${esc(m.workflow)}</span>` : ''}`] : null,
    v.repo ? ['Dépôt', `<code class="no-translate">${esc(v.repo)}</code>`] : null,
    ['Branche', `<code class="no-translate">${esc(v.branch)}</code>`],
    v.seenLive ? ['Dernier changement vu en ligne', when(v.seenLive)] : null,
    v.median !== null ? ['Temps habituel', `${dur(v.median, 1)} après la publication`] : null,
  ].filter(Boolean);
  const row = c => `<a class="row" href="#/change/${c.id}"><div class="t"><strong class="no-translate">${esc(c.title)}</strong><span class="muted small">${when(c.published)}${c.live === 'live' ? ` · <span>en ligne en ${dur(c.minutes, 1)}</span>` : ''}</span></div>
    <span class="pill ${(LIVE_PILL[c.live] || ['published'])[0]}">${(LIVE_PILL[c.live] || [0, c.live === 'live' ? 'Sur le site' : c.live === 'local' ? 'Sur ce serveur' : 'Publié'])[1]}</span></a>`;
  const pick = HOST_GUIDES[m.host] ? m.host : 'unknown';
  const guide = `<div class="stack live-guide">
    <span class="muted small">Où le site est-il hébergé ?</span>
    <div class="chips">${Object.keys(HOST_GUIDES).map(h => `<button type="button" class="chip${h === pick ? ' on' : ''}${HOST_NAMES[h] ? '' : ' no-translate'}" data-host="${esc(h)}">${esc(HOST_NAMES[h] || h)}</button>`).join('')}</div>
    <div id="hostguide"></div></div>`;
  box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2>Mise en ligne</h2>
      ${m.kind !== 'local' ? '<button type="button" class="btn small" id="relive">Vérifier à nouveau</button>' : ''}</div>
    ${late.length ? `<div class="banner bad">${late.length > 1 ? `${late.length} changements publiés ne sont pas encore sur le site en ligne.` : 'Un changement publié n’est pas encore sur le site en ligne.'}</div>` : ''}
    ${state}
    <dl class="live-facts">${facts.map(([k, x]) => `<div><dt>${k}</dt><dd>${x}</dd></div>`).join('')}</dl>
    ${v.recent.length ? `<div><span class="muted small">Derniers changements publiés</span><div class="list">${v.recent.map(row).join('')}</div></div>` : ''}
    ${m.kind === 'local' ? '' : !ok || late.length ? guide : `<details class="live-more"><summary>Changer d’hébergeur ou revoir la mise en ligne</summary>${guide}</details>`}`;
  const showGuide = h => {
    $$('[data-host]', box).forEach(b => b.classList.toggle('on', b.dataset.host === h));
    const code = h === 'FTP' ? ftpWorkflow(v) : h === 'unknown' ? deployPrompt(v) : null;
    $('#hostguide', box).innerHTML = `<ol class="deploy-steps">${HOST_GUIDES[h].map(t => `<li>${t}</li>`).join('')}</ol>
      ${code ? `<pre class="live-code no-translate">${esc(code)}</pre><div><button type="button" class="btn small" id="copycode">${icon('clip', 16)} ${h === 'FTP' ? 'Copier l’action' : 'Copier le message'}</button></div>` : ''}
      <p class="hint">Une fois la mise en ligne en place, cliquez sur « Vérifier à nouveau » : ClaudePress la détecte, puis vérifie chaque changement publié sur le site.</p>`;
    $('#copycode', box)?.addEventListener('click', () => navigator.clipboard.writeText(code).then(() => toast('Copié.'), () => toast('Copie impossible.')));
  };
  if ($('#hostguide', box)) { showGuide(pick); $$('[data-host]', box).forEach(b => b.addEventListener('click', () => showGuide(b.dataset.host))); }
  $('#relive', box)?.addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Lecture du dépôt…';
    try { await api(`/api/admin/sites/${s.id}/golive`, {}); toast('Mise en ligne vérifiée.'); liveCard(box, s); }
    catch (err) { toast(err.message); e.target.disabled = false; }
  });
  try { if (sessionStorage.getItem('to-golive')) { sessionStorage.removeItem('to-golive'); box.scrollIntoView({ block: 'start' }); window.scrollBy(0, -72); } } catch {}
}

function wireActions(c, root, beforePublish) {
  $$('[data-act]', root).forEach(btn => btn.addEventListener('click', async () => {
    const act = btn.dataset.act;
    try {
      if (act === 'discard' && !confirm('Abandonner ces modifications ? Rien ne sera publié.')) return;
      if (act === 'request-changes') {
        const comment = await ask('Demander une correction', 'Qu’est-ce qui doit être corrigé ?', 'Envoyer');
        if (!comment) return;
        await api(`/api/changes/${c.id}/request-changes`, { comment });
        toast('Demande de correction envoyée.');
        return route();
      }
      if (act === 'submit') {
        if (beforePublish) await beforePublish();
        const note = await ask('Demander la validation', 'Un mot pour la personne qui valide (facultatif) :', 'Envoyer', true, suggestion(c) || '');
        if (note === null) return;
        await api(`/api/changes/${c.id}/submit`, { note: note.text, at: note.at });
        track('approval_requested');
        toast('Demande de validation envoyée.');
        return route();
      }
      if (act === 'schedule') {
        if (beforePublish) await beforePublish();
        const at = btn.dataset.at ? atOf(btn.dataset.at) : await pickDate(suggestion(c));
        if (!at) return;
        btn.disabled = true;
        await api(`/api/changes/${c.id}/schedule`, { at: at.toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
        track('scheduled');
        toast('Programmé. Le site ne change pas d’ici là.');
        return route();
      }
      if (act === 'unschedule') {
        await api(`/api/changes/${c.id}/unschedule`, {});
        toast('Programmation annulée.');
        return route();
      }
      if (act === 'undo') {
        const { id } = await api(`/api/changes/${c.id}/undo`, {});
        location.hash = `#/change/${id}`;
        return;
      }
      if (act === 'publish' || act === 'approve') {
        if (beforePublish) await beforePublish();
        btn.disabled = true; btn.innerHTML = 'Publication…';
        const r = await api(`/api/changes/${c.id}/${act}`, {});
        track('published');
        toast(r.steps?.includes('deployed') ? 'Publié : le site est à jour.' : r.steps?.length ? 'Publié. ClaudePress vérifie qu’il apparaît sur le site en ligne.' : 'Publié sur ce serveur : l’envoi vers GitHub est désactivé pour ce site.');
        location.hash = `#/site/${c.site.id}`;
        return;
      }
      await api(`/api/changes/${c.id}/${act}`, {});
      location.hash = `#/site/${c.site.id}`;
    } catch (e) { toast(e.message); btn.disabled = false; }
  }));
}

/**
 * Asks for a text. With `withDate` (a day already asked for, or ''), also an optional day to go live:
 * the answer is then { text, at } (at: ISO, or null to publish as soon as approved).
 */
function ask(title, label, ok, optional = false, withDate) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    const dated = withDate !== undefined;
    d.innerHTML = `<form method="dialog" class="stack"><h2>${esc(title)}</h2><label class="field"><span>${esc(label)}</span><textarea rows="4"></textarea></label>
      ${dated ? `<label class="field"><span>Mise en ligne le (facultatif : sinon, dès la validation)</span><input type="date" name="day" min="${dayOf(new Date())}" value="${withDate ? dayOf(atOf(withDate)) : ''}"></label>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" value="cancel">Annuler</button><button class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
    document.body.appendChild(d);
    d.showModal();
    d.addEventListener('close', () => {
      const v = $('textarea', d).value.trim(), day = $('[name=day]', d)?.value;
      d.remove();
      const answer = d.returnValue === 'ok' && (v || optional) ? v : null;
      resolve(dated && answer !== null ? { text: answer, at: day ? atOf(day).toISOString() : null } : answer);
    });
  });
}

const dayOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Asks when a change goes live: a day and an hour, midnight by default. Resolves to a Date, or null. */
function pickDate(initial) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    const start = initial ? atOf(initial) : new Date(Date.now() + 86_400_000);
    d.innerHTML = `<form method="dialog" class="stack"><h2>Programmer la publication</h2>
      <p class="muted">Les changements se publient seuls à ce moment-là. D’ici là, le site ne change pas, et vous pouvez annuler.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><label class="field" style="flex:1"><span>Jour</span><input type="date" name="day" required min="${dayOf(new Date())}" value="${dayOf(start)}"></label>
        <label class="field"><span>Heure</span><input type="time" name="time" required value="${initial?.length > 10 ? start.toTimeString().slice(0, 5) : '00:00'}"></label></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" value="cancel" formnovalidate>Annuler</button><button class="btn primary" value="ok">Programmer</button></div></form>`;
    document.body.appendChild(d);
    d.showModal();
    d.addEventListener('close', () => {
      const v = `${$('[name=day]', d).value}T${$('[name=time]', d).value || '00:00'}:00`;
      d.remove();
      resolve(d.returnValue === 'ok' && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
    });
  });
}

// ---- the edit workspace: conversation on the left, proposed changes on the right

const SUGGESTIONS = ['Changer un texte sur la page d’accueil', 'Remplacer une photo', 'Mettre à jour un prix', 'Améliorer la description Google d’une page'];

/** What Claude used for a change, as it is counted: tokens read (some from the cache), tokens written, credits. For administrators. */
function usageLine(c) {
  if (!me.user.agency || !(c.tokens_in || c.tokens_out)) return '';
  const read = (c.tokens_in || 0) + (c.tokens_cached || 0);
  return `Claude pour ce changement : ${num(read)} jetons lus${c.tokens_cached ? ` (dont ${num(c.tokens_cached)} en cache)` : ''}, ${num(c.tokens_out)} écrits · `
    + (c.credits ? `${num(c.credits)} crédits` : 'payé avec votre clé Claude');
}

function workspace(c) {
  const pending = { images: [], files: [] };
  let busy = false;
  app.innerHTML = topbar(crumbsFor(c)) + `
    <div class="tabs"><div class="seg"><button data-tab="chat" class="on">Conversation</button><button data-tab="side">Changements (${c.items.length})</button></div></div>
    <div class="work">
      <section class="chat">
        ${c.paused ? `<div class="banner" style="margin:12px 20px 0">${esc(c.paused)}</div>` : ''}
        <div class="msgs" id="msgs"></div>
        <div class="hint" id="usage" style="padding:8px 20px;border-top:1px solid var(--line)" hidden></div>
        ${c.can.edit ? `<div class="composer">
          <div class="attach" id="attach"></div>
          <div class="box">
            <label class="icon-btn" title="Joindre une photo ou un PDF">${icon('clip')}<input type="file" accept="image/*,application/pdf" multiple hidden id="file"></label>
            <textarea id="text" rows="1" placeholder="Écrivez ce que vous voulez changer…"></textarea>
            <button class="btn primary" id="send" title="Envoyer">${icon('send', 18)}</button>
          </div>
          <div class="hint">L’IA prépare les changements. Rien n’est publié sans votre accord.</div>
        </div>` : ''}
      </section>
      <section class="side">
        <div class="side-body">
          ${reviewBanner(c)}
          <div class="side-head" id="sidetabs"></div>
          <div class="pane" data-pane="changes"><div id="stagingstrip"></div><div id="cards" class="stack"></div></div>
          <div class="pane pane-staging" data-pane="staging" hidden><div id="staging" class="staging"></div></div>
        </div>
        ${actionBar(c)}
      </section>
    </div>`;
  wireTop();
  wireActions(c, app);
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => {
    $$('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    $('.work').classList.toggle('show-side', b.dataset.tab === 'side');
  }));

  // the side panel: the proposed changes, or the staging site at full height
  let pane = 'changes';
  function renderTabs() {
    if (!c.items.length) pane = 'changes';
    const st = previewState(c), dot = { ready: 'ready', building: 'building', outdated: 'building', failed: 'failed', replaced: '' }[st] ?? '';
    $('#sidetabs').innerHTML = c.items.length
      ? `<div class="seg side-tabs"><button data-pane="changes" class="${pane === 'changes' ? 'on' : ''}"><span>Changements proposés</span> <b class="count no-translate">${c.items.length}</b></button><button data-pane="staging" class="${pane === 'staging' ? 'on' : ''}"><span>Site de test</span>${dot ? ` <span class="status ${dot}"><i></i></span>` : ''}</button></div>`
      : '<h2>Changements proposés</h2>';
    $$('.pane').forEach(el => { el.hidden = el.dataset.pane !== pane; });
    $$('[data-pane]', $('#sidetabs')).forEach(b => b.addEventListener('click', () => { pane = b.dataset.pane; renderTabs(); }));
  }

  const msgs = $('#msgs');
  // when the AI stopped for want of credit, the administrator gets a way out right under the message
  const needLink = need => `<div style="margin-top:8px"><a class="btn small primary" href="#/admin/account?credits">${need === 'credits' ? 'Ajouter des crédits' : 'Activer l’assistant'}</a></div>`;
  function renderChat(extra = '') {
    const intro = !c.chat.length && c.can.edit ? `<div class="hero-empty">${nini('welcome')}
        <strong style="color:var(--ink)">Dites simplement ce que vous voulez changer</strong>
        <span>Par exemple : « Sur la page boutique, remplace “Commander” par “Pré-commander” ». Vous pouvez aussi joindre une photo, ou un PDF comme un nouveau tarif.</span>
        <div class="chips" style="justify-content:center;margin-top:8px">${SUGGESTIONS.map(s => `<button class="chip">${esc(s)}</button>`).join('')}</div></div>` : '';
    msgs.innerHTML = intro + c.chat.map(m => (m.steps ? workLog(m.steps) : '') + `<div class="msg ${m.role}">${m.role === 'user' && m.by && m.by !== me.user.name ? `<div class="who">${esc(m.by)}</div>` : ''}${msgMedia(m)}${esc(m.text)}${m.need && me.user.agency ? needLink(m.need) : ''}</div>`).join('') + extra;
    msgs.scrollTop = msgs.scrollHeight;
    $$('.chip', msgs).forEach(ch => ch.addEventListener('click', () => { $('#text').value = ch.textContent.replace(/…$/, '') + ' : '; $('#text').focus(); }));
    const usage = usageLine(c);
    $('#usage').textContent = usage;
    $('#usage').hidden = !usage;
  }
  function renderCards() {
    $('#cards').innerHTML = c.items.length ? c.items.map(it => opCard(c, it)).join('')
      : `<div class="hero-empty">${nini('preview')}<span>Les changements apparaîtront ici, avec un avant/après et un aperçu de la page.</span></div>`;
    stagingPanel(c, $('#staging'), refresh);
    const strip = $('#stagingstrip');
    strip.innerHTML = stagingStrip(c);
    // asked from the strip: the staging tab shows how far it got
    wirePreview(c, strip, () => { pane = 'staging'; return refresh(); });
    $$('[data-pane-go]', strip).forEach(b => b.addEventListener('click', () => { pane = b.dataset.paneGo; renderTabs(); }));
    renderTabs();
    const tab = $('[data-tab="side"]'); if (tab) tab.textContent = `Changements (${c.items.length})`;
    $$('[data-see]').forEach(b => b.addEventListener('click', () => compare(c, b.dataset.see, +b.dataset.idx)));
    $$('[data-remove]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/changes/${c.id}/remove`, { index: +b.dataset.remove });
      await refresh();
    }));
  }
  async function refresh() {
    Object.assign(c, await api(`/api/changes/${c.id}`));
    renderCards();
    $('.bar')?.replaceWith(...(actionBar(c) ? [Object.assign(document.createElement('div'), { innerHTML: actionBar(c) }).firstElementChild] : []));
    if (!$('.bar') && actionBar(c)) $('.side').insertAdjacentHTML('beforeend', actionBar(c));
    wireActions(c, $('.side'));
    stopPolling();
    if (previewPolls(c) || (c.previewBy === 'local' && c.items.length && !c.previewReady && c.preview !== 'failed')) timer = setTimeout(refresh, c.previewBy === 'local' ? 1500 : 5000);
  }
  renderChat(); renderCards();
  if (previewPolls(c) || (c.previewBy === 'local' && c.items.length && !c.previewReady && c.preview !== 'failed')) timer = setTimeout(refresh, 1500);
  if (!c.can.edit) return;

  const text = $('#text');
  let start = null;
  try { start = JSON.parse(sessionStorage.getItem(`start-${c.id}`)); sessionStorage.removeItem(`start-${c.id}`); } catch {}
  text.addEventListener('input', () => { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 180) + 'px'; });
  text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('#send').addEventListener('click', send);
  const addFiles = async files => {
    for (const f of files) {
      const list = f.type.startsWith('image/') ? pending.images : f.type === 'application/pdf' ? pending.files : null;
      if (!list) { toast(`« ${f.name} » : seules les photos et les PDF peuvent être joints.`); continue; }
      try { list.push(await upload(f)); } catch (e) { toast(e.message); }
    }
    $('#attach').innerHTML = pending.images.map((im, i) => `<span><img src="${esc(im.url)}" alt=""><button data-k="images" data-i="${i}" title="Retirer">×</button></span>`).join('')
      + pending.files.map((f, i) => `<span class="doc">${icon('post', 18)}<em>${esc(f.name)}</em><button data-k="files" data-i="${i}" title="Retirer">×</button></span>`).join('');
    $$('#attach button').forEach(b => b.addEventListener('click', () => { pending[b.dataset.k].splice(+b.dataset.i, 1); addFiles([]); }));
  };
  $('#file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  text.addEventListener('paste', e => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); addFiles(f); } });
  $('.chat').addEventListener('dragover', e => e.preventDefault());
  $('.chat').addEventListener('drop', e => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  if (start?.text) {
    text.value = start.text;
    if (start.send) send();
    else { text.focus(); text.setSelectionRange(text.value.length, text.value.length); text.dispatchEvent(new Event('input')); }
  }

  async function send() {
    const t = text.value.trim();
    if (busy || (!t && !pending.images.length && !pending.files.length)) return;
    busy = true;
    const images = pending.images.splice(0), files = pending.files.splice(0);
    $('#attach').innerHTML = ''; text.value = ''; text.style.height = 'auto';
    c.chat.push({ role: 'user', text: t, images: images.map(i => i.url), files: files.map(f => ({ name: f.name, url: f.url })), by: me.user.name });
    // each step the AI takes stays on screen, ticked off when the next one starts; a pause to think gives way to the next step
    const steps = [{ text: 'Je lis votre demande…', thinking: true, at: Date.now() }];
    const stepLine = (st, last) => `<li class="${last ? 'now' : 'done'}"><span class="mark">${last ? '<span class="dots"><i></i><i></i><i></i></span>' : icon('check', 16)}</span>
        <span class="what">${esc(st.text)}${st.image ? `<a class="made" href="${esc(st.image)}" target="_blank" rel="noopener"><img src="${esc(st.image)}" alt=""></a>` : ''}</span>
        <span class="secs">${last ? '' : seconds(st.s)}</span></li>`;
    const thinking = () => `<div class="thinking">${nini('working', '')}<ol class="live-steps">${steps.map((st, i) => stepLine(st, i === steps.length - 1)).join('')}</ol></div>`;
    const redraw = () => { $('.thinking') && ($('.thinking').outerHTML = thinking()); msgs.scrollTop = msgs.scrollHeight; };
    // the step under way counts its seconds, so a long one (an image, a video) visibly moves
    const tick = setInterval(() => { const el = $('.live-steps .now .secs'); const s = Math.round((Date.now() - steps.at(-1).at) / 1000); if (el && s >= 3) el.textContent = seconds(s); }, 1000);
    renderChat(thinking());
    try {
      const r = await fetch(`/api/changes/${c.id}/message`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: t, images: images.map(({ file, name, mediaType }) => ({ file, name, mediaType })), files: files.map(({ file, name }) => ({ file, name })) }) });
      if (!r.ok) throw new Error((await r.json()).error);
      track('message_sent', { images: images.length, files: files.length });
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n')) >= 0) {
          const ev = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1);
          if (ev.progress) {
            const prev = steps.at(-1);
            if (prev.thinking) steps.pop(); else prev.s = Math.round((Date.now() - prev.at) / 1000);
            steps.push({ text: ev.progress, thinking: !!ev.thinking, image: ev.image, at: Date.now() });
            redraw();
          }
        }
      }
    } catch (e) { toast(e.message); }
    clearInterval(tick);
    busy = false;
    stopPolling();
    const before = c.items.length;
    Object.assign(c, await api(`/api/changes/${c.id}`));
    if (c.items.length !== before || c.preview === 'outdated') pane = 'changes';   // show what the AI just did
    renderChat();
    await refresh();
    if (innerWidth <= 860 && c.items.length) toast('Les changements sont dans l’onglet « Changements ».');
  }
}

/** "8 s", "1 min 05 s": how long a step took. Under 2 seconds says nothing. */
const seconds = s => s < 2 ? '' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;

/** The steps the AI took for an answer, folded above it: what it read, changed and made, and how long each took. */
function workLog(steps) {
  const total = steps.reduce((n, st) => n + st.s, 0);
  return `<details class="work-log"><summary>${steps.length} étape${steps.length > 1 ? 's' : ''}${total >= 2 ? ` · ${seconds(total)}` : ''}</summary>
    <ol>${steps.map(st => `<li><span class="mark">${icon('check', 14)}</span><span class="what">${esc(st.text)}</span><span class="secs">${seconds(st.s)}</span></li>`).join('')}</ol></details>`;
}

/** Photos and documents attached to a message; images and videos the assistant made open full size or download. */
function msgMedia(m) {
  const made = m.role === 'assistant';
  return (m.images || []).map(src => made
      ? `<a class="made" href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="Image créée par l’assistant"></a>`
      : `<img src="${esc(src)}" alt="">`).join('')
    + (m.files || []).map(f => `<a class="doc" href="${esc(f.url)}" target="_blank" rel="noopener">${icon('post', 18)}<span>${esc(f.name)}</span></a>`).join('')
    + (m.videos || []).map(src => `<video class="made" src="${esc(src)}" controls muted loop playsinline preload="metadata"></video>`
      + `<a class="made-dl" href="${esc(src)}" download>Télécharger la vidéo</a>`).join('');
}

// ---- before / after on the real page

function compare(c, url, focus = -1) {
  // the clicked change first, so the page scrolls to it
  const items = c.items.filter(it => it.url === url).sort((a, b) => (b.index === focus) - (a.index === focus));
  const isNew = items.some(it => it.kind === 'create_post');
  const spec = (side, label) => encodeURIComponent(JSON.stringify({
    t: items.flatMap(it => it[side].texts).filter(Boolean), i: items.flatMap(it => it[side].images).filter(Boolean), label,
  }));
  let mode = isNew ? 'after' : (innerWidth > 1100 ? 'both' : 'after'), device = 'desktop';
  const ov = document.createElement('div');
  ov.className = 'overlay';
  document.body.appendChild(ov);
  const page = items[0]?.pageTitle || url;

  function draw() {
    const before = `${c.liveOrigin}${url}#claudepress=${spec('hlBefore', inPage('Avant'))}`;
    const after = `${c.previewOrigin}${url}#claudepress=${spec('hlAfter', inPage('Modifié'))}`;
    const frame = (side, src, label, color) => `<div class="frame ${device}"><label><i style="background:${color}"></i>${label}</label>${src}</div>`;
    const beforeEl = isNew ? '<div class="none">Cette page n’existe pas encore sur le site.</div>' : `<iframe src="${esc(before)}" data-side="b"></iframe>`;
    const st = previewState(c);
    const afterEl = c.previewReady ? `<iframe src="${esc(after)}" data-side="a"></iframe>`
      : `<div class="none stack" style="align-items:center">${st === 'building' ? `<span>Aperçu en préparation · prêt en 1 à 5 minutes.</span><span class="hint">Cette fenêtre se met à jour toute seule.</span>`
        : st === 'failed' ? '<span>L’aperçu n’a pas pu être construit.</span>' : '<span>L’aperçu complet du site n’est pas encore préparé.</span><span class="hint">Il est prêt en 1 à 5 minutes. Les changements à gauche, eux, sont exactement ce qui sera publié.</span>'}
        ${st !== 'building' && (c.can.edit || c.can.approve || c.can.unschedule) ? `<button class="btn primary" data-preview>${icon('eye', 18)} Préparer l’aperçu</button>` : ''}</div>`;
    ov.innerHTML = `<div class="ov-head">
        <button class="icon-btn" data-close title="Fermer">${icon('x')}</button>
        <div><strong>${esc(page)}</strong><div class="muted small">${esc(url)}</div></div>
        <span class="spacer"></span>
        <div class="seg">${isNew ? '' : `<button data-mode="both" class="${mode === 'both' ? 'on' : ''}">Côte à côte</button><button data-mode="before" class="${mode === 'before' ? 'on' : ''}">Avant</button>`}<button data-mode="after" class="${mode === 'after' ? 'on' : ''}">Après</button></div>
        <div class="seg"><button data-dev="desktop" class="${device === 'desktop' ? 'on' : ''}">Ordinateur</button><button data-dev="mobile" class="${device === 'mobile' ? 'on' : ''}">Mobile</button></div>
      </div>
      <div class="frames ${mode === 'both' ? 'two' : ''}">
        ${mode !== 'after' ? frame('b', beforeEl, 'Avant · en ligne aujourd’hui', 'var(--muted)') : ''}
        ${mode !== 'before' ? frame('a', afterEl, 'Après · aperçu, pas encore publié', 'var(--mark)') : ''}
      </div>`;
    $('[data-close]', ov).addEventListener('click', close);
    $$('[data-mode]', ov).forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; draw(); }));
    $$('[data-dev]', ov).forEach(b => b.addEventListener('click', () => { device = b.dataset.dev; draw(); }));
    $$('iframe', ov).forEach(f => f.addEventListener('mouseenter', () => active = f));
    wirePreview(c, ov, async () => { Object.assign(c, await api(`/api/changes/${c.id}`)); if (ov.isConnected) draw(); });
    if (previewPolls(c) || (c.previewBy === 'local' && !c.previewReady && c.preview !== 'failed')) setTimeout(async () => { Object.assign(c, await api(`/api/changes/${c.id}`)); if (ov.isConnected) draw(); }, 5000);
  }
  let active = null;
  const onMsg = e => {
    if (e.data?.claudepress !== 'scroll' || mode !== 'both') return;
    const frames = $$('iframe', ov);
    const src = frames.find(f => f.contentWindow === e.source);
    if (!src || src !== active) return;
    frames.filter(f => f !== src).forEach(f => f.contentWindow.postMessage({ claudepress: 'scrollTo', ratio: e.data.ratio }, '*'));
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() { ov.remove(); removeEventListener('message', onMsg); removeEventListener('keydown', onKey); }
  addEventListener('message', onMsg);
  addEventListener('keydown', onKey);
  draw();
}

// ------------------------------------------------------------------ blog post

const BLOCK_NAMES = { h2: 'Intertitre', h3: 'Sous-titre', p: 'Paragraphe', ul: 'Liste', ol: 'Liste numérotée', quote: 'Citation' };

async function postEditor(c) {
  if (!c.post) return postBrief(c);
  const post = c.post;
  const ro = !c.can.edit;
  // where the site publishes its posts, e.g. /blog/{slug}/
  const postPattern = (c.site.postUrl || '/{slug}/').split('{slug}'), postAt = slug => postPattern.join(slug);
  const images = await api(`/api/sites/${c.site.id}/images`).catch(() => []);
  let dirty = false;

  app.innerHTML = topbar(crumbsFor(c)) + `<main class="page" style="max-width:1240px">
    <div class="stack">
      ${reviewBanner(c)}
      ${post.note && c.can.edit ? `<div class="banner"><strong>À vérifier :</strong> ${esc(post.note)}</div>` : ''}
      <div class="post-grid">
        <div class="stack">
          <div class="cover" id="cover"></div>
          <div class="post-title" ${ro ? '' : 'contenteditable'} id="ptitle">${esc(post.title)}</div>
          <div class="blocks" id="blocks"></div>
          ${ro ? '' : `<div class="add-blocks">${Object.entries(BLOCK_NAMES).map(([k, v]) => `<button class="btn small ghost" data-add="${k}">+ ${v}</button>`).join('')}</div>
          <div class="card stack">
            <strong>${icon('spark', 18)} Demander à l’IA</strong>
            <div class="chips">${['Plus court', 'Ton plus chaleureux', 'Ajoute une conclusion qui invite à commander', 'Améliore le référencement'].map(s => `<button class="chip" data-rev="${esc(s)}">${esc(s)}</button>`).join('')}</div>
            <div class="box" style="display:flex;gap:8px"><input class="input" id="rev" placeholder="Ex. : ajoute un paragraphe sur l’accord avec le vin blanc"><button class="btn" id="revgo">Appliquer</button></div>
          </div>`}
        </div>
        <div class="stack">
          <div class="card stack" id="seo"></div>
          <div class="card stack">
            <strong>Pour Google</strong>
            <label class="field"><span>Mot-clé principal</span><input id="kw" value="${esc(post.focusKeyword)}" ${ro ? 'disabled' : ''}></label>
            <label class="field"><span>Titre dans Google <em id="mtc"></em></span><input id="mt" value="${esc(post.metaTitle)}" ${ro ? 'disabled' : ''}></label>
            <label class="field"><span>Description dans Google <em id="mdc"></em></span><textarea id="md" rows="3" ${ro ? 'disabled' : ''}>${esc(post.metaDescription)}</textarea></label>
            <label class="field"><span>Adresse de la page</span><input id="slug" value="${esc(post.slug)}" ${ro ? 'disabled' : ''}><span class="hint">${esc(c.site.liveUrl)}${esc(postPattern[0])}<b id="slugv"></b>${esc(postPattern[1] ?? '')}</span></label>
            <label class="field"><span>Date de publication</span><input id="date" type="date" value="${esc((post.published || '').slice(0, 10))}" ${ro ? 'disabled' : ''}></label>
          </div>
        </div>
      </div>
    </div>
  </main>
  <div class="bar" style="position:sticky;bottom:0">
    ${c.can.edit ? `<button class="btn" id="save">${icon('eye', 18)} Enregistrer et voir l’aperçu (1 à 5 min)</button>` : c.previewReady ? `<button class="btn" id="see">${icon('eye', 18)} Voir l’aperçu</button>` : ''}
    <span id="pstatus">${c.items.length ? previewStatus(c) : ''}</span>
    <span class="spacer"></span>
    ${actionBar(c).replace(/^<div class="bar">|<\/div>$/g, '')}
  </div>`;
  wireTop();

  const blocksEl = $('#blocks');
  function drawBlocks() {
    blocksEl.innerHTML = post.blocks.map((b, i) => `<div class="blk ${b.type}" data-i="${i}"><span class="k">${b.type.toUpperCase()}</span>
      ${b.type === 'ul' || b.type === 'ol' ? `<${b.type} ${ro ? '' : 'contenteditable'}>${(b.items || []).map(x => `<li>${x}</li>`).join('')}</${b.type}>` : `<div ${ro ? '' : 'contenteditable'}>${b.html || ''}</div>`}
      ${ro ? '' : `<span class="tools"><button data-up="${i}" title="Monter">↑</button><button data-down="${i}" title="Descendre">↓</button><button data-del="${i}" title="Supprimer">✕</button></span>`}</div>`).join('');
    $$('[data-up]').forEach(b => b.addEventListener('click', () => { collect(); const i = +b.dataset.up; if (i > 0) [post.blocks[i - 1], post.blocks[i]] = [post.blocks[i], post.blocks[i - 1]]; changed(); drawBlocks(); }));
    $$('[data-down]').forEach(b => b.addEventListener('click', () => { collect(); const i = +b.dataset.down; if (i < post.blocks.length - 1) [post.blocks[i + 1], post.blocks[i]] = [post.blocks[i], post.blocks[i + 1]]; changed(); drawBlocks(); }));
    $$('[data-del]').forEach(b => b.addEventListener('click', () => { collect(); post.blocks.splice(+b.dataset.del, 1); changed(); drawBlocks(); }));
  }
  function drawCover() {
    $('#cover').innerHTML = post.cover?.src
      ? `<img src="${esc(post.cover.media ? `/api/uploads/${post.cover.media.upload}` : c.liveOrigin + post.cover.src)}" alt="${esc(post.cover.alt)}">`
        + (ro ? '' : `<div class="btns"><button class="btn small" id="pick">Choisir une photo du site</button><label class="btn small">Envoyer une photo<input type="file" accept="image/*" hidden id="cfile"></label></div>`)
      : (ro ? '<span class="muted">Pas de photo</span>' : `<div class="stack" style="align-items:center;padding:20px"><span class="muted">${icon('photo', 28)}</span><div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn small" id="pick">Choisir une photo du site</button><label class="btn small primary">Envoyer une photo<input type="file" accept="image/*" hidden id="cfile"></label></div></div>`);
    $('#cfile')?.addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      const up = await upload(f).catch(err => toast(err.message));
      if (!up) return;
      // the server picks the file's place in the site when the article is saved
      post.cover = { src: `upload:${up.file}`, alt: post.cover?.alt || '', media: { upload: up.file, path: '' } };
      changed(); drawCover();
    });
    $('#pick')?.addEventListener('click', () => {
      const d = document.createElement('dialog');
      d.innerHTML = `<div class="stack"><h2>Photos du site</h2><div class="gallery">${images.map(src => `<img src="${esc(c.liveOrigin + src)}" data-src="${esc(src)}" loading="lazy" alt="">`).join('')}</div>
        <div style="text-align:right"><button class="btn" data-x>Fermer</button></div></div>`;
      document.body.appendChild(d); d.showModal();
      $('[data-x]', d).addEventListener('click', () => d.close());
      d.addEventListener('close', () => d.remove());
      $$('[data-src]', d).forEach(img => img.addEventListener('click', () => { post.cover = { src: img.dataset.src, alt: post.cover?.alt || '' }; changed(); drawCover(); d.close(); }));
    });
  }
  if (!$('#coveralt') && !ro) $('#cover').insertAdjacentHTML('afterend', `<label class="field"><span>Description de la photo (pour les malvoyants et Google)</span><input id="coveralt" value="${esc(post.cover?.alt || '')}"></label>`);
  function collect() {
    if (ro) return;
    post.title = $('#ptitle').innerText.trim();
    $$('.blk').forEach(el => {
      const b = post.blocks[+el.dataset.i];
      if (!b) return;
      if (b.type === 'ul' || b.type === 'ol') b.items = $$('li', el).map(li => li.innerHTML.trim()).filter(x => strip(x));
      else b.html = $('[contenteditable]', el).innerHTML.trim();
    });
    post.focusKeyword = $('#kw').value.trim();
    post.metaTitle = $('#mt').value.trim();
    post.metaDescription = $('#md').value.trim();
    post.slug = $('#slug').value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-/, '');
    if ($('#date').value) post.published = `${$('#date').value}T09:00:00+00:00`;
    if (post.cover) post.cover.alt = $('#coveralt')?.value.trim() || post.cover.alt;
  }
  function drawSeo() {
    const r = seoChecks(post, []);
    const color = r.score >= 80 ? '#2fb36e' : r.score >= 55 ? '#e8a317' : 'var(--mark)';
    $('#seo').innerHTML = `<div class="score"><div class="ring" style="--p:${r.score};--c:${color}"><b>${r.score}</b></div>
        <div><strong>Prêt pour Google ?</strong><div class="muted small">${r.score >= 80 ? 'Très bien, l’article est bien préparé.' : 'Quelques points à améliorer ci-dessous.'}</div></div></div>
      <div class="serp"><div class="u">${esc(c.site.liveUrl.replace(/^https?:\/\//, ''))} › ${esc(post.slug)}</div><div class="t">${esc(post.metaTitle || post.title)}</div><div class="d">${esc(post.metaDescription)}</div></div>
      <ul class="checks">${r.checks.map(k => `<li class="${k.ok ? '' : 'no'}" title="${esc(k.tip || '')}">${esc(k.label)}</li>`).join('')}</ul>`;
    const mt = post.metaTitle.length, md = post.metaDescription.length;
    $('#mtc').textContent = `${mt}/60`; $('#mtc').className = mt > 60 || mt < 30 ? 'bad' : '';
    $('#mdc').textContent = `${md}/160`; $('#mdc').className = md > 160 || md < 70 ? 'bad' : '';
    $('#slugv').textContent = post.slug;
  }
  function changed() { dirty = true; collect(); drawSeo(); }

  drawCover(); drawBlocks(); drawSeo();
  if (!ro) {
    $('.page').addEventListener('input', changed);
    $$('[data-add]').forEach(b => b.addEventListener('click', () => {
      collect();
      const t = b.dataset.add;
      post.blocks.push(t === 'ul' || t === 'ol' ? { type: t, items: ['…'] } : { type: t, html: '' });
      changed(); drawBlocks();
      $$('.blk [contenteditable]').pop()?.focus();
    }));
    const revise = async instruction => {
      collect();
      const box = $('#revgo'); box.disabled = true; box.textContent = 'L’IA réécrit…';
      try {
        const r = await api(`/api/changes/${c.id}/post/revise`, { instruction, post });
        Object.assign(post, r.post);
        dirty = true;
        postEditor({ ...c, post });
        toast('Article mis à jour. Relisez les changements.');
      } catch (e) { toast(e.message); box.disabled = false; box.textContent = 'Appliquer'; }
    };
    $$('[data-rev]').forEach(b => b.addEventListener('click', () => revise(b.dataset.rev)));
    $('#revgo').addEventListener('click', () => $('#rev').value.trim() && revise($('#rev').value.trim()));
  }
  const save = async () => {
    collect();
    await api(`/api/changes/${c.id}/post`, { post });
    dirty = false;
    Object.assign(c, await api(`/api/changes/${c.id}`));
    $('#pstatus').innerHTML = previewStatus(c);
  };
  $('#save')?.addEventListener('click', async () => {
    try {
      await save();
      if (c.previewBy !== 'local' && !c.previewReady && c.preview !== 'building') {
        await api(`/api/changes/${c.id}/preview`, {});
        toast('Aperçu demandé : il sera prêt dans 1 à 5 minutes.', 5000);
        Object.assign(c, await api(`/api/changes/${c.id}`));
      }
      const poll = async () => {
        Object.assign(c, await api(`/api/changes/${c.id}`));
        $('#pstatus').innerHTML = previewStatus(c);
        wirePreview(c, $('#pstatus'), poll);
        if (previewPolls(c) || (c.previewBy === 'local' && !c.previewReady && c.preview !== 'failed')) timer = setTimeout(poll, 5000);
      };
      compare(c, postAt(post.slug));
      poll();
    } catch (e) { toast(e.message); }
  });
  $('#see')?.addEventListener('click', () => compare(c, postAt(post.slug)));
  wireActions(c, document, async () => { if (dirty || !c.items.length) await save(); });
}

function postBrief(c) {
  const photos = [];
  app.innerHTML = topbar(crumbsFor(c)) + `<main class="page"><div class="narrow stack">
    <div><h1>Écrire un article</h1><p class="muted">Donnez le sujet et quelques idées. L’IA rédige un premier jet complet, prêt pour Google, que vous relisez et modifiez.</p></div>
    <label class="field"><span>De quoi parle l’article ?</span><textarea id="topic" rows="3" placeholder="Ex. : nos conseils pour bien choisir un vin pour les fêtes, avec deux accords faciles"></textarea></label>
    <label class="field"><span>Points importants, faits, anecdotes <em>facultatif</em></span><textarea id="points" rows="4" placeholder="Ce que vous voulez absolument dire : vos produits, vos chiffres, une histoire…"></textarea></label>
    <label class="field"><span>Mot-clé visé dans Google <em>facultatif</em></span><input id="kw" placeholder="Ex. : vin pour les fêtes"><span class="hint">Laissez vide : l’IA en propose un.</span></label>
    <div class="field"><span>Photos <em>facultatif · la première devient la couverture</em></span>
      <div class="attach" id="attach"></div>
      <label class="btn" style="align-self:flex-start">${icon('photo', 18)} Ajouter des photos<input type="file" accept="image/*" multiple hidden id="file"></label></div>
    <div style="display:flex;gap:10px"><button class="btn primary" id="go">${icon('spark', 18)} Rédiger le premier jet</button><button class="btn ghost danger" data-act="discard">Abandonner</button></div>
  </div></main>`;
  wireTop();
  wireActions(c, app);
  const draw = () => {
    $('#attach').innerHTML = photos.map((p, i) => `<span><img src="${esc(p.url)}" alt=""><button data-i="${i}">×</button></span>`).join('');
    $$('#attach button').forEach(b => b.addEventListener('click', () => { photos.splice(+b.dataset.i, 1); draw(); }));
  };
  $('#file').addEventListener('change', async e => {
    for (const f of e.target.files) { try { photos.push(await upload(f)); } catch (err) { toast(err.message); } }
    e.target.value = ''; draw();
  });
  $('#go').addEventListener('click', async () => {
    const topic = $('#topic').value.trim();
    if (!topic) return toast('Indiquez le sujet de l’article.');
    const btn = $('#go');
    btn.disabled = true; btn.innerHTML = '<span class="dots"><i></i><i></i><i></i></span> L’IA rédige votre article (environ une minute)…';
    try {
      const { post } = await api(`/api/changes/${c.id}/post/draft`, { topic, points: $('#points').value.trim(), keyword: $('#kw').value.trim(),
        photos: photos.map(({ file, mediaType }) => ({ file, mediaType })) });
      postEditor({ ...c, post });
    } catch (e) { toast(e.message); btn.disabled = false; btn.innerHTML = `${icon('spark', 18)} Rédiger le premier jet`; }
  });
}

// ------------------------------------------------------------------ new page request

function requestScreen(c) {
  const r = c.request;
  const brief = r?.brief;
  const briefHtml = brief ? `<div class="card stack">
      <h2>${esc(brief.pageTitle)}</h2><p>${esc(brief.goal)}</p>
      <div><strong>Contenu proposé</strong><ol>${brief.sections.map(s => `<li><strong>${esc(s.heading)}</strong> — ${esc(s.content)}</li>`).join('')}</ol></div>
      <div class="serp"><div class="u">${esc(c.site.liveUrl.replace(/^https?:\/\//, ''))} › ${esc(brief.slug)}</div><div class="t">${esc(brief.metaTitle)}</div><div class="d">${esc(brief.metaDescription)}</div></div>
      ${brief.questions.length ? `<div class="banner"><strong>L’agence aura besoin de :</strong><ul style="margin:6px 0 0">${brief.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
    </div>` : '';
  // the photos and documents the request needs, to download; the rest stays in the conversation
  const attached = (r?.attachments || []).map(f => /\.pdf$/i.test(f)
      ? `<a class="doc" href="/api/uploads/${esc(f)}" target="_blank" rel="noopener">${icon('post', 18)}<span>${esc(f.replace(/^[a-z0-9]+-/, ''))}</span></a>`
      : `<a href="/api/uploads/${esc(f)}" download><img src="/api/uploads/${esc(f)}" alt=""></a>`).join('');
  const fromChat = r?.details ? `<div class="card stack"><strong>Demande</strong><p style="white-space:pre-wrap">${esc(r.details)}</p>
      ${attached ? `<div class="req-files">${attached}</div>` : ''}
      ${c.chat.length ? `<details><summary class="muted">Conversation d’origine</summary><div class="stack" style="margin-top:10px">${c.chat.map(m => `<div class="msg ${m.role}">${msgMedia(m)}${esc(m.text)}</div>`).join('')}</div></details>` : ''}</div>` : '';
  app.innerHTML = topbar(crumbsFor(c)) + `<main class="page"><div class="narrow stack">
    <div><h1>${c.status === 'draft' ? 'Demander une nouvelle page' : esc(c.title)}</h1>
      <p class="muted">${c.status === 'draft' ? 'Décrivez la page comme vous l’expliqueriez à quelqu’un. L’IA en fait un plan clair, puis vous l’envoyez à l’agence.' : `${STATUS[c.status]} · demandé par ${esc(c.author)} ${when(c.created)}`}</p></div>
    ${c.status === 'draft' ? `<label class="field"><span>La page souhaitée</span><textarea id="txt" rows="6" placeholder="Ex. : une page pour les traiteurs et restaurants : nos formats professionnels, la livraison, comment nous contacter pour un devis.">${esc(r?.text || '')}</textarea></label>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ${brief ? '' : 'primary'}" id="go">${icon('spark', 18)} ${brief ? 'Refaire le plan' : 'Préparer le plan'}</button>
      ${brief ? `<button class="btn primary" id="sendreq">${icon('send', 18)} Envoyer à l’agence</button>` : ''}<button class="btn ghost danger" data-act="discard">Abandonner</button></div>` : ''}
    ${briefHtml}${fromChat}
    ${c.can.close ? `<div><button class="btn primary" id="close">${icon('check', 18)} Marquer comme traitée</button></div>` : ''}
  </div></main>`;
  wireTop();
  wireActions(c, app);
  $('#go')?.addEventListener('click', async () => {
    const text = $('#txt').value.trim();
    if (!text) return toast('Décrivez la page souhaitée.');
    $('#go').disabled = true; $('#go').innerHTML = '<span class="dots"><i></i><i></i><i></i></span> Préparation…';
    try { await api(`/api/changes/${c.id}/request`, { text }); route(); } catch (e) { toast(e.message); $('#go').disabled = false; }
  });
  $('#sendreq')?.addEventListener('click', async () => { await api(`/api/changes/${c.id}/send-request`, {}); toast('Demande envoyée à l’agence.'); location.hash = `#/site/${c.site.id}`; });
  $('#close')?.addEventListener('click', async () => { await api(`/api/changes/${c.id}/close`, {}); toast('Demande marquée comme traitée.'); route(); });
}

// ------------------------------------------------------------------ administration

async function admin(tab, sub) {
  if (!me.user.agency) { location.hash = '#/'; return; }
  if (tab === 'new-site') return siteForm();
  const d = await api('/api/admin');
  if (tab === 'site') return siteForm(d.sites.find(s => s.id === sub), d);
  // a new account starts with the checklist; then the sites
  tab = ADMIN_PAGES.some(x => x && x[0] === tab) ? tab : d.sites.length ? 'sites' : 'start';
  adminPage = tab;
  const count = { sites: d.sites.length, people: d.users.length, requests: d.requests.length }[tab];
  const title = ADMIN_PAGES.find(x => x && x[0] === tab)[1];
  app.innerHTML = topbar(`<span class="muted">/</span><a href="#/admin/sites">Administration</a><span class="muted">/</span><span>${title}</span>`) + `<main class="page">
    <div class="hello"><h1>${title}${count ? ` <span class="muted">${count}</span>` : ''}</h1></div>
    <div id="pane"></div></main>`;
  wireTop();
  const pane = $('#pane');
  if (tab === 'start') return startTab(pane, d);
  if (tab === 'people') return peopleTab(pane, d);
  if (tab === 'requests') return requestsTab(pane, d);
  if (tab === 'github') return githubPanel(pane);
  if (tab === 'insights') return insightsTab(pane);
  if (tab === 'monitoring') return monitoringTab(pane);
  if (tab === 'security') return securityTab(pane);
  if (tab === 'usage') return usageTab(pane, d);
  if (['account', 'keys', 'brand'].includes(tab)) return accountTab(pane, d, tab);
  return sitesTab(pane, d);
}

/** The first steps of an account, ticked off as they are done: how AI is paid, GitHub, the first site, a client. */
async function startTab(pane, d) {
  const a = d.account, g = await api('/api/github').catch(() => null);
  const steps = [
    { done: a.ai.mode !== 'none', title: 'Choisissez comment l’IA est payée',
      did: a.aiIncluded ? 'Formule avec IA incluse.' : a.ai.keyLast4 ? 'Votre clé Claude est enregistrée (BYOK).' : 'Crédits IA en packs.',
      body: extHtml('start.ai', a) || `<p class="muted">Ajoutez votre clé Claude (BYOK) : vous payez Claude, et fal.ai pour les images, directement.
        <a href="https://claudepress.org/help/byok" target="_blank" rel="noopener">Le guide BYOK</a></p><div><a class="btn primary" href="#/admin/keys">Ajouter mes clés</a></div>` },
    { done: !!g?.installations?.length, title: 'Connectez GitHub', did: `Connecté : ${(g?.installations || []).map(i => esc(i.account)).join(', ')}.`, body: '<div id="ghstep"></div>' },
    { done: d.sites.length > 0, title: 'Ajoutez votre premier site', did: `${d.sites.length} site(s).`,
      body: '<p class="muted">Choisissez son dépôt GitHub : ClaudePress lit le site, le construit une première fois et vous propose qui peut changer quoi.</p><div><a class="btn primary" href="#/admin/new-site">+ Ajouter un site</a></div>' },
    { done: d.sites.length > 0 && d.sites.every(s => liveOk(s.golive)), title: 'Vérifiez la mise en ligne', did: 'Vos sites se mettent en ligne quand GitHub change.',
      body: `<p class="muted">Ce que vos clients publient arrive sur GitHub ; c’est l’hébergeur du site qui le met en ligne. ClaudePress vérifie qu’un hébergeur ou une action GitHub s’en charge, puis que chaque changement apparaît bien sur le site.</p>
        <div class="list">${d.sites.filter(s => !liveOk(s.golive)).map(s => `<a class="row" href="#/admin/site/${s.id}" data-to-golive><div class="t"><strong class="no-translate">${esc(s.name)}</strong>
          <span class="muted small">${s.golive?.kind === 'none' ? 'Rien ne semble mettre ce site en ligne quand GitHub change.' : s.golive?.late ? 'Des changements publiés ne sont pas encore en ligne.' : s.golive?.kind === 'local' ? 'Les publications restent sur ce serveur.' : 'Pas encore vérifié.'}</span></div>
          <span class="btn small">Vérifier</span></a>`).join('')}</div>` },
    { done: d.users.some(x => !x.agency), title: 'Invitez votre client', did: 'Votre client est invité.',
      body: '<p class="muted">Il reçoit un lien, choisit son mot de passe et modifie son site en le demandant simplement.</p><div><a class="btn" href="#/admin/people">Inviter une personne</a></div>' },
  ];
  const next = steps.findIndex(x => !x.done);
  pane.innerHTML = `<div class="stack">
    <div class="hello-nini">${nini(next < 0 ? 'published' : 'welcome', '')}<p>${next < 0 ? 'Tout est prêt. Bon travail avec vos clients !' : `Bienvenue ! ${steps.filter(x => x.done).length} étape(s) sur ${steps.length} : voici la suivante.`}</p></div>
    <ol class="steps">${steps.map((x, i) => `<li class="card stack ${x.done ? 'done' : i === next ? 'next' : ''}">
      <h2><span class="num">${x.done ? icon('check', 16) : i + 1}</span>${x.title}</h2>
      ${x.done ? `<p class="small muted">${x.did}</p>` : i === next ? x.body : ''}</li>`).join('')}</ol>
  </div>`;
  if (next === 0) extRun('start.ai', pane, a);
  if (next === 1) githubPanel($('#ghstep'), true);
}

const roleSelect = (value, attrs) => `<select class="input" ${attrs}>
  <option value="approver" ${value === 'approver' ? 'selected' : ''}>${ROLE.approver}</option>
  <option value="editor" ${value === 'editor' ? 'selected' : ''}>${ROLE.editor}</option></select>`;

const scopeSelect = (value, attrs) => `<select class="input" ${attrs}>${Object.entries(SCOPE).map(([k, l]) => `<option value="${k}" ${(value === 'full' ? 'full' : 'page') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
let pickers = 0;
/** Who changes something: three buttons side by side (radio buttons underneath), green, amber or grey like the scan's areas. */
const permissionPicker = (value, attrs) => {
  const name = `perm-${++pickers}`;
  return `<div class="perm-pick" role="radiogroup" ${attrs}>${Object.keys(PERMISSION).map(k => `<label class="p-${k}"><input type="radio" name="${name}" value="${k}"
    ${value === k ? 'checked' : ''}><span>${PERM_SHORT[k]}</span></label>`).join('')}</div>`;
};
/**
 * The site's permissions when no scan proposes them (it failed, or the site could not be fetched): saved as they are
 * picked. A page with its own setting keeps its row; set like "Texts and photos of the pages", it simply follows that.
 */
function policyEditor(box, s) {
  const pol = s.policy || { pages: {} };
  const pages = Object.keys(pol.pages || {});
  box.innerHTML = `<h3>Qui modifie quoi</h3>
    <div class="perm-rows">${Object.keys(KIND).map(k => `<div class="perm-row"><div><span>${KIND[k]}</span></div>${permissionPicker(pol[k], `data-pe-kind="${k}"`)}</div>`).join('')}
      ${pages.map(u => `<div class="perm-row"><div><span>Page <code class="no-translate">${esc(u)}</code></span></div>${permissionPicker(pol.pages[u], `data-pe-page="${esc(u)}"`)}</div>`).join('')}</div>
    ${pages.length ? '<p class="hint">Une page réglée comme « Textes et photos des pages » suit ce réglage ; les autres gardent le leur.</p>' : ''}
    ${permissionLegend()}`;
  $$('[data-pe-kind], [data-pe-page]', box).forEach(g => g.addEventListener('change', async e => {
    const v = e.target.value, page = g.dataset.pePage;
    try {
      s.policy = await api(`/api/admin/sites/${s.id}/policy`, page ? { page, value: v === s.policy.content ? 'inherit' : v } : { kind: g.dataset.peKind, value: v });
      toast('Enregistré.');
    } catch (err) { toast(err.message); }
  }));
}
const picked = group => $('input:checked', group)?.value;
/** What each choice means for the client roles. */
const permissionLegend = () => `<dl class="perm-legend">${Object.keys(PERMISSION).map(k => `<div class="p-${k}"><dt><span></span>${PERM_SHORT[k]}</dt><dd>${PERMISSION_HINT[k]}</dd></div>`).join('')}
  <div><dt></dt><dd>Les personnes réglées « Tout, comme l’agence » ne sont pas concernées : elles changent tout, sans validation.</dd></div></dl>`;

/** GitHub connection: the server's app (created once) and the accounts this administrator connected. `inStep`: inside the checklist. */
async function githubPanel(box, inStep = false) {
  const g = await api('/api/github').catch(() => null);
  if (!g) return;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const notice = { app: 'Application GitHub créée. Connectez maintenant votre compte GitHub.', connected: 'Compte GitHub connecté.',
    refused: 'GitHub n’a pas confirmé la connexion. Réessayez.', failed: 'La création de l’application GitHub a échoué. Réessayez.' }[q.get('github')];
  if (!g.app) {
    box.innerHTML = g.canCreateApp ? `<section class="card stack"><h2>GitHub</h2>
        <p>Pour que chaque compte relie ses sites, ClaudePress a besoin de sa propre application GitHub. Elle se crée une fois : GitHub vous la montre déjà remplie, vous confirmez, et ses clés reviennent directement ici, chiffrées.</p>
        <form id="mkapp" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><label class="small muted">Organisation GitHub propriétaire</label>
          <input class="input" name="owner" value="claudepress" style="max-width:220px"><button class="btn primary">Créer l’application GitHub</button></form>
        <span class="hint">Laissez vide pour la créer sur votre compte personnel.</span></section>`
      : '<div class="banner">GitHub n’est pas encore configuré sur ce serveur.</div>';
    $('#mkapp')?.addEventListener('submit', async e => {
      e.preventDefault();
      const r = await api('/api/github/app', { owner: new FormData(e.target).get('owner') }).catch(err => toast(err.message));
      if (!r) return;
      const f = Object.assign(document.createElement('form'), { method: 'post', action: r.action });
      f.appendChild(Object.assign(document.createElement('input'), { type: 'hidden', name: 'manifest', value: r.manifest }));
      document.body.appendChild(f); f.submit();
    });
    if (notice) toast(notice, 6000);
    return;
  }
  // where each connection is managed on GitHub: a personal account or an organisation
  const manage = i => i.type === 'Organization' ? `https://github.com/organizations/${encodeURIComponent(i.account)}/settings/installations/${i.id}`
    : `https://github.com/settings/installations/${i.id}`;
  const how = `<ol class="howto">
      <li><strong>Cliquez sur « Connecter GitHub ».</strong> GitHub s’ouvre.</li>
      <li><strong>Choisissez votre compte ou votre organisation</strong>, puis « Only select repositories » et les dépôts de vos sites.</li>
      <li><strong>Cliquez sur « Install ».</strong> Vous revenez ici, prêt à ajouter votre site.</li></ol>
    <div><button class="btn primary" id="ghconnect">${GITHUB_ICON} Connecter GitHub</button></div>
    <p class="hint">ClaudePress ne voit que les dépôts que vous choisissez, et n’y écrit que les changements que vous publiez. Vous pouvez changer ce choix ou retirer l’accès à tout moment sur GitHub.</p>`;
  box.innerHTML = !g.installations.length
    ? (inStep ? `<div class="stack"><p class="muted">Vos sites vivent dans des dépôts GitHub : c’est là que ClaudePress enregistre ce que vous publiez.</p>${how}</div>`
      : `<section class="card stack"><h2>Connectez GitHub</h2><p class="muted">Vos sites vivent dans des dépôts GitHub : c’est là que ClaudePress enregistre ce que vous publiez.</p>${how}</section>`)
    : `<div class="stack">
      <section class="card stack"><h2>${icon('check', 18)} GitHub est connecté</h2>
        <div class="list">${g.installations.map(i => `<div class="row"><div class="t"><strong class="no-translate">${esc(i.account)}</strong>
          <span class="muted small">${i.type === 'Organization' ? 'Organisation' : 'Compte personnel'}</span></div>
          <a class="btn small" href="${manage(i)}" target="_blank" rel="noopener">Choisir les dépôts ${icon('out', 14)}</a></div>`).join('')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn primary" href="#/admin/new-site">+ Ajouter un site</a>
          <button class="btn" id="ghconnect">Connecter un autre compte ou organisation</button></div>
        <p class="hint">Un dépôt manque dans la liste ? Ajoutez-le avec « Choisir les dépôts » sur GitHub, puis revenez ici.</p></section></div>`;
  $('#ghconnect').addEventListener('click', async () => { const r = await api('/api/github/install').catch(err => toast(err.message)); if (r) location.href = r.url; });
  if (notice) toast(notice, 6000);
}

/**
 * The sites' figures: the account's Google connection (read only), then for each site its Analytics and Search Console
 * properties and whether its clients see them. Each choice is saved as it is made.
 */
async function insightsTab(pane) {
  const d = await api('/api/admin/insights');
  const g = d.google;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const notice = { connected: 'Compte Google connecté.', refused: 'Google n’a pas donné l’accès. Réessayez.', failed: 'La connexion à Google a échoué. Réessayez.' }[q.get('google')];
  if (notice) toast(notice, 6000);
  const intro = '<p class="muted">Vos clients voient sur leur site combien de personnes le visitent, d’où elles viennent, et ce qu’on cherche sur Google pour le trouver. Les chiffres viennent de leur Google Analytics et de leur Search Console : ClaudePress les lit, sans rien pouvoir y changer.</p>';
  if (!g.available && !g.viewerAvailable) {
    pane.innerHTML = `<section class="card stack"><h2>Statistiques Google</h2>${intro}
      <div class="banner">Les statistiques Google ne sont pas encore configurées sur ce serveur.</div>
      ${me.user.platform ? '<p class="hint">Activez les API Google Analytics Admin, Google Analytics Data et Search Console dans un projet Google Cloud, puis ajoutez à la configuration <code>google: { viewer: { project } }</code> (une adresse ClaudePress par compte) et/ou <code>google: { clientId, clientSecret }</code> (connexion Google, avec l’adresse de redirection <code>/api/google/connected</code>). Le README détaille les deux.</p>' : ''}</section>`;
    return;
  }
  const revoked = g.error === 'revoked' ? '<div class="banner">L’accès donné à ClaudePress a été retiré chez Google : connectez le compte à nouveau.</div>' : '';
  const steps = () => `<div class="viewer-steps">
      <div class="stack" style="gap:8px"><strong>Dans Google Analytics</strong><ol class="howto small">
        <li>Administration (roue dentée) → la propriété du client → <strong>Gestion des accès à la propriété</strong>.</li>
        <li><strong>+</strong> → <strong>Ajouter des utilisateurs</strong>, collez l’adresse, rôle <strong>Lecteur</strong>.</li>
        <li>Décochez « Avertir les nouveaux utilisateurs par e-mail », puis <strong>Ajouter</strong>.</li></ol></div>
      <div class="stack" style="gap:8px"><strong>Dans Search Console</strong><ol class="howto small">
        <li>La propriété du client → <strong>Paramètres</strong> → <strong>Utilisateurs et autorisations</strong>.</li>
        <li><strong>Ajouter un utilisateur</strong>, collez l’adresse.</li>
        <li>Autorisation <strong>Restreint</strong>, puis <strong>Ajouter</strong>.</li></ol></div></div>`;
  const choose = `<section class="card stack"><h2>Donnez accès aux statistiques</h2>${intro}
      <div class="google-ways">
        ${g.viewerAvailable ? `<div class="google-way stack"><strong>Ajouter ClaudePress comme lecteur</strong>
          <span class="muted small">Le plus simple : vous, ou votre client, ajoutez une adresse ClaudePress dans Google Analytics et Search Console, comme on ajoute un collaborateur. Personne ne se connecte à Google ici.</span>
          <div><button class="btn primary" id="gviewer">Obtenir mon adresse ClaudePress</button></div></div>` : ''}
        ${g.available ? `<div class="google-way stack"><strong>Connecter un compte Google</strong>
          <span class="muted small">Si un compte Google de l’agence a déjà accès aux statistiques de tous vos clients : connectez-le une fois, en lecture seule.</span>
          <div><button class="btn ${g.viewerAvailable ? '' : 'primary'}" id="gconnect">${GOOGLE_ICON} Connecter Google</button></div></div>` : ''}
      </div>${revoked}</section>`;
  const viewer = () => `<section class="card stack"><div class="side-head"><div><h2>${icon('check', 18)} Votre adresse ClaudePress</h2>
        <div class="muted small">Ajoutez-la à chaque client, dans Google Analytics et dans Search Console. Elle est propre à votre compte et ne voit que ce que vous lui partagez.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${g.available ? '<button class="btn small" id="gconnect">Connecter Google à la place</button>' : ''}<button class="btn small ghost danger" id="gdisconnect">Arrêter</button></div></div>
      <div style="display:flex;gap:8px;align-items:center"><code class="viewer-addr" id="gaddr">${esc(g.viewerEmail)}</code><button class="btn" type="button" id="gcopy">Copier</button></div>
      ${steps()}
      <p class="hint">Pour retirer l’accès à un client, supprimez l’adresse dans son Google Analytics et sa Search Console : ClaudePress ne voit plus rien.</p></section>`;
  const oauth = () => `<section class="card stack"><div class="side-head"><div><h2>${icon('check', 18)} Google est connecté</h2>
        <div class="muted small no-translate">${esc(g.email || '')}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn small" id="gconnect">Changer de compte</button>${g.viewerAvailable ? '<button class="btn small" id="gviewer">Utiliser l’adresse ClaudePress</button>' : ''}<button class="btn small ghost danger" id="gdisconnect">Déconnecter</button></div></div>
      <p class="hint">Une propriété manque ci-dessous ? Le compte connecté doit être ajouté comme utilisateur (lecteur suffit) dans Google Analytics et dans Search Console du client.</p></section>`;
  const account = !g.connected ? choose : g.mode === 'viewer' ? viewer() : oauth();
  pane.innerHTML = `<div class="stack">${account}${g.connected ? '<section class="card stack" id="gsites"><h2>Vos sites</h2><p class="muted small">Je demande à Google la liste des propriétés…</p></section>' : ''}</div>`;
  $('#gconnect')?.addEventListener('click', async () => {
    if (g.mode === 'viewer' && !confirm('Connecter un compte Google à la place de l’adresse ClaudePress ? Les sites gardent leurs propriétés si ce compte y a accès.')) return;
    const r = await api('/api/google/connect').catch(e => toast(e.message)); if (r) location.href = r.url;
  });
  $('#gviewer')?.addEventListener('click', async e => {
    if (g.mode === 'oauth' && !confirm('Utiliser l’adresse ClaudePress à la place du compte Google connecté ? Il faudra l’ajouter chez chaque client.')) return;
    e.target.disabled = true;
    try { await api('/api/admin/google/viewer', {}); insightsTab(pane); } catch (err) { toast(err.message, 6000); e.target.disabled = false; }
  });
  $('#gcopy')?.addEventListener('click', () => navigator.clipboard.writeText(g.viewerEmail).then(() => toast('Adresse copiée.'), () => { getSelection().selectAllChildren($('#gaddr')); toast('Copiez l’adresse sélectionnée.'); }));
  $('#gdisconnect')?.addEventListener('click', async () => {
    if (!confirm(g.mode === 'viewer' ? 'Arrêter les statistiques Google ? Vos clients ne les verront plus. L’adresse reste la même si vous reprenez plus tard.'
      : 'Déconnecter Google ? Vos clients ne verront plus les statistiques de leur site jusqu’à la prochaine connexion.')) return;
    await api('/api/admin/google/disconnect', {}); insightsTab(pane);
  });
  if (!g.connected) return;
  const box = $('#gsites');
  let props;
  try { props = await api('/api/admin/google/properties'); }
  catch (e) {
    // a new address takes a minute to work at Google
    box.innerHTML = `<h2>Vos sites</h2><div class="banner bad">${g.mode === 'viewer' ? 'Google ne répond pas encore pour votre adresse ClaudePress. Réessayez dans une minute.' : esc(e.message)}</div>
      <div><button class="btn small" id="gretry">${icon('refresh', 16)} Réessayer</button></div>`;
    $('#gretry').addEventListener('click', () => insightsTab(pane));
    return;
  }
  if (!d.sites.length) { box.innerHTML = `<h2>Vos sites</h2>${emptyNini('Ajoutez d’abord un site.')}`; return; }
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  // the properties that look like the site come first, marked
  const matches = (s, name) => !!host(s.liveUrl) && String(name).toLowerCase().replace(/^www\./, '').includes(host(s.liveUrl));
  const gaSelect = s => props.analytics === null ? '<span class="hint">Google Analytics ne répond pas pour ce compte.</span>'
    : `<select class="input no-translate" data-ga4="${s.id}"><option value="">Aucune</option>
      ${[...props.analytics].sort((a, b) => matches(s, b.name) - matches(s, a.name)).map(p => `<option value="${esc(p.id)}" ${s.settings.ga4 === p.id ? 'selected' : ''}>${matches(s, p.name) ? '★ ' : ''}${esc(p.name)} · ${esc(p.account)}</option>`).join('')}
      ${s.settings.ga4 && !props.analytics.some(p => p.id === s.settings.ga4) ? `<option value="${esc(s.settings.ga4)}" selected>${esc(s.settings.ga4Name || s.settings.ga4)} (plus accessible)</option>` : ''}</select>`;
  const scSelect = s => props.searchConsole === null ? '<span class="hint">Search Console ne répond pas pour ce compte.</span>'
    : `<select class="input no-translate" data-gsc="${s.id}"><option value="">Aucune</option>
      ${[...props.searchConsole].sort((a, b) => matches(s, b.name) - matches(s, a.name)).map(p => `<option value="${esc(p.id)}" ${s.settings.gsc === p.id ? 'selected' : ''}>${matches(s, p.name) ? '★ ' : ''}${esc(p.name)}${p.id.startsWith('sc-domain:') ? ' (domaine)' : ''}</option>`).join('')}
      ${s.settings.gsc && !props.searchConsole.some(p => p.id === s.settings.gsc) ? `<option value="${esc(s.settings.gsc)}" selected>${esc(s.settings.gsc)} (plus accessible)</option>` : ''}</select>`;
  const on = s => !!(s.settings.ga4 || s.settings.gsc);
  box.innerHTML = `<h2>Vos sites</h2>
    <p class="muted small">Pour chaque site, choisissez ses chiffres. ★ : ressemble à l’adresse du site.</p>
    <div class="stack insight-sites">${d.sites.map(s => `<div class="insight-site" data-site="${s.id}">
      <div class="side-head"><div><strong class="no-translate">${esc(s.name)}</strong> <span class="muted small no-translate">${esc(host(s.liveUrl))}</span></div>
        <a class="btn small" href="#/site/${s.id}/stats" data-see ${on(s) ? '' : 'hidden'}>${icon('chart', 16)} Voir</a></div>
      <div class="insight-grid">
        <label class="field"><span>Google Analytics</span>${gaSelect(s)}</label>
        <label class="field"><span>Search Console</span>${scSelect(s)}</label></div>
      <label class="toggle small"><input type="checkbox" data-clients="${s.id}" ${s.settings.clients ? 'checked' : ''}>Les clients du site voient les statistiques</label>
    </div>`).join('')}</div>
    ${[props.analytics, props.searchConsole].some(x => x && !x.length) ? (g.mode === 'viewer'
      ? '<p class="hint">Rien dans une liste ? Ajoutez d’abord votre adresse ClaudePress chez le client (voir ci-dessus), puis revenez sur cette page : elle apparaît en général en une minute.</p>'
      : '<p class="hint">Aucune propriété trouvée pour l’une des deux sources : vérifiez que le compte connecté y a bien accès.</p>') : ''}`;
  const save = async (id, body) => {
    try {
      const st = await api(`/api/admin/sites/${id}/insights`, body);
      const s = d.sites.find(x => x.id === id); s.settings = st;
      $(`[data-site="${id}"] [data-see]`).hidden = !on(s);
      toast('Enregistré.');
    } catch (e) { toast(e.message); }
  };
  $$('[data-ga4]', box).forEach(el => el.addEventListener('change', () => save(el.dataset.ga4, { ga4: el.value || null, ga4Name: el.value ? el.selectedOptions[0].textContent.replace(/^★ /, '') : null })));
  $$('[data-gsc]', box).forEach(el => el.addEventListener('change', () => save(el.dataset.gsc, { gsc: el.value || null })));
  $$('[data-clients]', box).forEach(el => el.addEventListener('change', () => save(el.dataset.clients, { clients: el.checked })));
}

// ------------------------------------------------------------------ uptime monitoring (server/monitor.ts)

// Laid out the way uptime services do it, so it reads at a glance: a coloured dot, "up for", uptime per period,
// one bar per day, the response times, then the outages in a table.
const MON = { up: 'En ligne', down: 'Hors ligne', paused: 'En pause' };
/** A site's state: a dot (pulsing while up) and its word; nothing before its first check, or without monitoring. */
const monPill = m => m?.state && MON[m.state] ? `<span class="mon-state ${m.state}"><i class="mon-dot"></i>${MON[m.state]}</span>` : '';
const uptimePct = v => v === null || v === undefined ? '—' : `${v.toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE', { maximumFractionDigits: 2 })} %`;
// a bar is green only when the site was up all that day (or hour); a period's percentage stays green above 99 %
const upClass = v => v === null || v === undefined ? '' : v >= 99.9 ? 'ok' : v >= 98 ? 'meh' : 'bad';
const pctClass = v => v === null || v === undefined ? '' : v >= 99 ? 'ok' : v >= 95 ? 'meh' : 'bad';
/** A length of time the way uptime services write it: "12 min", "3 h 05 min", "4 j 2 h". */
const dur = (min, least = 0) => { min = Math.max(least, Math.round(min));
  return min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')} min` : ''}` : `${Math.floor(min / 1440)} j${Math.floor(min % 1440 / 60) ? ` ${Math.floor(min % 1440 / 60)} h` : ''}`; };
/** Up, down or paused, and for how long: "En ligne depuis 3 j 4 h". */
const stateFor = m => !m?.state ? 'Pas encore vérifié' : m.state === 'paused' ? 'Surveillance en pause' : `${MON[m.state]} depuis ${dur(minutesSince(m.since), 1)}`;
/** One bar per day (or hour): green when up all the time, amber or red when it was down a while, grey without a check. */
const uptimeBars = (list, label, key = 'day') => `<div class="mon-bars" style="--n:${list.length}" aria-label="${label}">${list.map(x =>
  `<i class="${upClass(x.uptime)}" title="${esc(key === 'day' ? longDay(x.day) : new Date(x.hour).toLocaleTimeString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE', { hour: '2-digit', minute: '2-digit' }))} · ${x.uptime === null ? '—' : uptimePct(x.uptime)}"></i>`).join('')}</div>`;
/** The site is down: since when and why, and the change published just before, to undo it (for whoever may). */
const downBanner = (v, agency) => `<div class="banner bad mon-down"><i class="mon-dot"></i><div><strong>Le site ne répond plus</strong> <span>depuis ${dur(minutesSince(v.since), 1)}</span>${agency && v.error ? ` · <span>${esc(v.error)}</span>` : ''}
  ${agency && v.incidents[0]?.change && !v.incidents[0].resolved ? `<div style="margin-top:8px">C’est arrivé après la publication de <a class="no-translate" href="#/change/${v.incidents[0].change.id}">« ${esc(v.incidents[0].change.title)} »</a>. Si c’est la cause : <a class="btn small" href="#/change/${v.incidents[0].change.id}">Ouvrir pour l’annuler</a></div>`
    : agency ? '' : '<div>Votre agence est prévenue et s’en occupe.</div>'}</div></div>`;

/** The last 24 hours' response times, an area per hour, with the average, the fastest and the slowest hour. */
function responseChart(r) {
  const pts = r.hours.map((h, i) => ({ i, ms: h.ms })), seen = pts.filter(p => p.ms !== null);
  if (!seen.length) return '<p class="hint">Pas encore de mesure.</p>';
  const W = 720, H = 120, top = Math.max(...seen.map(p => p.ms)) * 1.15 || 1;
  const x = i => i / (pts.length - 1) * W, y = ms => H - ms / top * H;
  // one path per run of hours with a measure, so a gap stays a gap
  const runs = []; let run = [];
  for (const p of pts) { if (p.ms === null) { if (run.length) runs.push(run); run = []; } else run.push(p); }
  if (run.length) runs.push(run);
  // a lone hour (the first one, or between gaps) is drawn as a short dash
  const line = rr => rr.length === 1 ? `M${(x(rr[0].i) - 6).toFixed(1)},${y(rr[0].ms).toFixed(1)}L${(x(rr[0].i) + 6).toFixed(1)},${y(rr[0].ms).toFixed(1)}`
    : rr.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.ms).toFixed(1)}`).join('');
  const area = rr => `${line(rr)}L${x(rr.at(-1).i).toFixed(1)},${H}L${x(rr[0].i).toFixed(1)},${H}Z`;
  const hour = h => new Date(h).toLocaleTimeString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE', { hour: '2-digit', minute: '2-digit' });
  return `<div class="mon-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Temps de réponse, 24 dernières heures">
      <line x1="0" x2="${W}" y1="${y(r.avg)}" y2="${y(r.avg)}" class="avg"/>
      ${runs.map(rr => `${rr.length > 1 ? `<path d="${area(rr)}" class="fill"/>` : ''}<path d="${line(rr)}" class="line"/>`).join('')}</svg>
    <div class="mon-axis no-translate"><span>${hour(r.hours[0].hour)}</span><span>${hour(r.hours[12].hour)}</span><span>${hour(r.hours.at(-1).hour)}</span></div></div>
    <div class="mon-figs"><div><span class="muted small">Moyenne</span><strong class="no-translate">${r.avg} ms</strong></div>
      <div><span class="muted small">Minimum</span><strong class="no-translate">${r.min} ms</strong></div>
      <div><span class="muted small">Maximum</span><strong class="no-translate">${r.max} ms</strong></div></div>`;
}

/** A site's page: its monitoring like an uptime service's monitor page. Without the add-on, what it would do. */
async function monitorCard(box, s, d) {
  const a = d.account;
  const v = await api(`/api/admin/sites/${s.id}/monitor`);
  if (!v || !box.isConnected) return;
  if (v.off) {
    // the free monitoring covers another site of the account: move it here, or monitor them all
    box.innerHTML = `<div class="mon-head"><span class="mon-big none"><i class="mon-dot"></i></span><div><h2>Surveillance du site</h2><div class="small muted">Non surveillé</div></div></div>
      <p class="muted">La surveillance gratuite couvre un site de votre compte${v.freeSite ? ` : <strong class="no-translate">${esc(v.freeSite.name)}</strong>` : ''}. Vérifié chaque minute, vous êtes prévenu par e-mail en deux minutes s’il ne répond plus.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${extHtml('monitoring.site', a)}
        <button class="btn" id="monfree">Surveiller ce site à la place</button></div>`;
    extRun('monitoring.site', box, a);
    $('#monfree', box).addEventListener('click', async () => {
      try { await api(`/api/admin/sites/${s.id}/monitor`, { free: true }); toast('Ce site est maintenant surveillé.'); monitorCard(box, s, d); } catch (e) { toast(e.message); }
    });
    return;
  }
  const period = p => `<div class="mon-box"><span class="muted small">${{ 1: '24 dernières heures', 7: '7 derniers jours', 30: '30 derniers jours' }[p.days]}</span>
      <strong class="mon-pct ${pctClass(p.uptime)} no-translate">${uptimePct(p.uptime)}</strong>
      <span class="small muted">${p.incidents} incident${p.incidents > 1 ? 's' : ''}, ${dur(p.down)} d’arrêt</span></div>`;
  box.innerHTML = `<div class="mon-head"><span class="mon-big ${v.state || 'none'}"><i class="mon-dot"></i></span>
      <div style="min-width:0"><h2>Surveillance du site</h2><div class="small muted no-translate">HTTP · ${esc(v.url)}</div></div></div>
    ${v.state === 'down' ? downBanner(v, true) : ''}
    <div class="mon-grid">
      <div class="mon-box"><span class="muted small">Statut actuel</span><strong class="mon-word ${v.state || ''}">${v.state ? MON[v.state] : 'Pas encore vérifié'}</strong>
        <span class="small muted">${v.state && v.state !== 'paused' ? `Depuis ${dur(minutesSince(v.since), 1)}` : v.state === 'paused' ? 'Surveillance en pause' : 'Première vérification dans la minute'}</span></div>
      <div class="mon-box"><span class="muted small">Dernière vérification</span><strong>${v.checked ? when(v.checked) : '—'}</strong>
        <span class="small muted">Vérifié chaque minute</span></div>
      <div class="mon-box"><span class="muted small">Certificat SSL</span>${v.ssl ? `<strong class="${v.ssl.days <= 14 ? 'bad-ink' : ''}">Expire dans ${v.ssl.days} jours</strong><span class="small muted">Valide jusqu’au ${longDay(v.ssl.expires)}</span>` : `<strong>—</strong><span class="small muted">${v.url.startsWith('https:') ? 'Lu à la prochaine vérification' : 'Site sans HTTPS'}</span>`}</div>
    </div>
    <div class="mon-grid">${v.periods.map(period).join('')}</div>
    <div class="stack" style="gap:6px">${uptimeBars(v.days, 'Disponibilité des 30 derniers jours')}
      <div class="mon-axis"><span>il y a 30 jours</span><span class="no-translate">${uptimePct(v.periods[2].uptime)}</span><span>aujourd’hui</span></div></div>
    <div class="stack" style="gap:8px"><h3>Temps de réponse <span class="muted small">24 dernières heures</span></h3>${responseChart(v.response)}</div>
    <div class="stack" style="gap:8px"><h3>Derniers incidents</h3>
      ${v.incidents.length ? `<div class="table-wrap"><table class="mon-table"><thead><tr><th>Statut</th><th>Cause</th><th>Début</th><th>Durée</th></tr></thead><tbody>
        ${v.incidents.map(i => `<tr><td><span class="mon-tag ${i.resolved ? 'ok' : 'bad'}">${i.resolved ? 'Résolu' : 'Non résolu'}</span></td>
          <td>${esc(i.reason || '—')}${i.change ? `<div class="hint">Après <a class="no-translate" href="#/change/${i.change.id}">« ${esc(i.change.title)} »</a></div>` : ''}</td>
          <td class="no-translate nowrap">${new Date(i.started).toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
          <td class="nowrap">${dur(i.minutes)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="hint">Aucun incident enregistré. Tout va bien.</p>'}</div>
    <div class="stack" style="gap:8px"><h3>Alertes</h3>
      <div class="mon-alerted"><span class="mon-tag ok">Toujours</span><span>Les administrateurs du compte, par e-mail et dans les notifications</span></div>
      <div class="mon-alerted"><span class="mon-tag ${v.alerted.length ? 'ok' : ''}">${v.alerted.length ? 'Activé' : 'Aucun'}</span>
        <span>${v.alerted.length ? `Clients du site : <span class="no-translate">${esc(v.alerted.join(', '))}</span>` : 'Aucun client du site n’est prévenu'}
          · <a href="#" data-goto-clients>choisir dans Clients</a></span></div>
      <span class="hint">Les clients reçoivent un message rassurant, sous votre nom, sans détail technique.</span>
      <label class="toggle"><input type="checkbox" data-mon="paused" ${v.paused ? 'checked' : ''}>Mettre la surveillance de ce site en pause</label></div>`;
  $('[data-goto-clients]', box)?.addEventListener('click', e => { e.preventDefault(); $('#clients')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $$('[data-mon]', box).forEach(el => el.addEventListener('change', async () => {
    try { await api(`/api/admin/sites/${s.id}/monitor`, { [el.dataset.mon]: el.checked }); toast('Enregistré.'); monitorCard(box, s, d); }
    catch (e) { toast(e.message); el.checked = !el.checked; }
  }));
  try { if (sessionStorage.getItem('to-monitor')) { sessionStorage.removeItem('to-monitor'); box.scrollIntoView({ block: 'start' }); window.scrollBy(0, -72); } } catch {}
}

/** Monitoring, every site of the account in one list, the way an uptime dashboard opens: counts, then one row per site. */
async function monitoringTab(pane) {
  const d = await api('/api/admin/monitoring');
  const n = st => d.sites.filter(x => x.monitored && x.state === st).length;
  const others = d.sites.filter(x => !x.monitored).length;
  pane.innerHTML = `<div class="stack">
    <div class="mon-counts">
      <div class="mon-count up"><strong class="no-translate">${n('up')}</strong><span>En ligne</span></div>
      <div class="mon-count down"><strong class="no-translate">${n('down')}</strong><span>Hors ligne</span></div>
      <div class="mon-count paused"><strong class="no-translate">${n('paused')}</strong><span>En pause</span></div>
      ${others ? `<div class="mon-count"><strong class="no-translate">${others}</strong><span>Non surveillé</span></div>` : ''}
      <p class="hint" style="margin:0;flex:1 1 220px">Chaque site est vérifié chaque minute. Après deux échecs de suite, les administrateurs sont prévenus par e-mail et dans les notifications.</p>
    </div>
    ${!d.all ? extHtml('monitoring.page', d) : ''}
    <div class="list mon-list">${d.sites.map(x => !x.monitored ? `<div class="row mon-row off">
        <span class="mon-big small none"><i class="mon-dot"></i></span>
        <div class="t"><strong class="no-translate">${esc(x.name)}</strong><span class="small muted no-translate">${esc(x.url.replace(/^https?:\/\/(www\.)?|\/$/g, ''))}</span></div>
        <span class="small muted mon-for">Non surveillé</span>
        <div class="mon-row-bars"><button class="btn small" data-free="${x.id}">Surveiller celui-ci à la place</button></div><span></span></div>`
      : `<a class="row mon-row" href="#/admin/site/${x.id}" data-to-monitor>
        <span class="mon-big small ${x.state || 'none'}"><i class="mon-dot"></i></span>
        <div class="t"><strong class="no-translate">${esc(x.name)}</strong><span class="small muted no-translate">${esc(x.url.replace(/^https?:\/\/(www\.)?|\/$/g, ''))}</span></div>
        <span class="small mon-word ${x.state || ''} mon-for">${stateFor(x)}</span>
        <div class="mon-row-bars">${uptimeBars(x.hours, 'Disponibilité des 24 dernières heures', 'hour')}</div>
        <strong class="mon-pct ${pctClass(x.uptime24)} no-translate">${uptimePct(x.uptime24)}</strong></a>`).join('')
      || emptyNini('Aucun site à surveiller pour l’instant.')}</div>
    <span class="hint">Les barres montrent les 24 dernières heures, une par heure ; le pourcentage, la disponibilité sur 24 heures.</span>
  </div>`;
  // a site opened from here shows its monitoring straight away
  $$('[data-to-monitor]', pane).forEach(a => a.addEventListener('click', () => { try { sessionStorage.setItem('to-monitor', '1'); } catch {} }));
  $$('[data-free]', pane).forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/admin/sites/${b.dataset.free}/monitor`, { free: true }); toast('Ce site est maintenant surveillé.'); monitoringTab(pane); } catch (e) { toast(e.message); }
  }));
  extRun('monitoring.page', pane, d);
}

// ------------------------------------------------------------------ security (server/security.ts)

// A grade from A to F the way security scanners give one, then each finding with what it means and how to fix it.
// The findings' texts come from the server in the reader's language.
const SEV = { critical: 'Critique', high: 'Élevé', medium: 'Moyen', low: 'Faible', info: 'Info' };
const gradeClass = g => !g ? 'none' : g === 'A' ? 'a' : g === 'B' ? 'b' : g === 'C' ? 'c' : 'f';
/** A site's grade: a letter in a coloured square, a dash before its first check. */
const secGrade = (g, big) => `<span class="sec-grade ${gradeClass(g)}${big ? ' big' : ''} no-translate">${g || '–'}</span>`;
/** For lists of sites: the grade, once checked. */
const secPill = x => x?.grade ? `<span class="sec-pill ${gradeClass(x.grade)}"><span>Sécurité</span> <b class="no-translate">${x.grade}</b></span>` : '';
/** What is open, by severity: only the severities that have something. */
const sevCounts = c => !c ? '' : Object.entries(c).filter(([, n]) => n).map(([k, n]) => `<span class="sec-tag ${k}"><b class="no-translate">${n}</b> ${SEV[k]}</span>`).join('') || '<span class="sec-tag ok">Rien à corriger</span>';
const mb = n => `${(n / 1048576).toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE', { maximumFractionDigits: 1 })} ${document.documentElement.lang === 'en' ? 'MB' : 'Mo'}`;

/** One finding: its severity and title, then what it means, how to fix it and the advisories behind it. */
const secItem = (f, action) => `<details class="sec-item ${f.severity}"><summary><span class="sec-tag ${f.severity}">${SEV[f.severity]}</span>
    <span class="no-translate">${esc(f.title)}</span>${f.fixed ? `<span class="small muted nowrap">corrigé ${when(f.fixed)}</span>` : ''}</summary>
  <div class="stack" style="gap:8px">
    ${f.detail ? `<p class="no-translate">${esc(f.detail)}</p>` : ''}
    ${f.fix ? `<div><span class="small muted">Comment corriger</span><pre class="sec-fix no-translate">${esc(f.fix)}</pre></div>` : ''}
    ${f.advisories?.length ? `<div class="small">Avis : ${f.advisories.slice(0, 5).map(x => `<a class="no-translate" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.id)}</a>`).join(', ')}${f.advisories.length > 5 ? ` <span class="no-translate">+${f.advisories.length - 5}</span>` : ''}</div>` : ''}
    <div class="small muted">Vu pour la première fois ${when(f.first)}</div>
    ${action || ''}</div></details>`;

/** A site's page: its grade, what is open, what was accepted or fixed, and its backups. */
async function securityCard(box, s, d) {
  const a = d.account;
  const v = await api(`/api/admin/sites/${s.id}/security?lang=${document.documentElement.lang}`).catch(() => null);
  if (!v || !box.isConnected) return;
  const can = !v.running && !v.next;
  box.innerHTML = `<div class="mon-head">${secGrade(v.grade, true)}
      <div style="min-width:0;flex:1"><h2>Sécurité du site</h2><div class="small muted">${v.running ? 'Vérification en cours…' : v.checked ? `Vérifié ${when(v.checked)}${v.covered ? ' · chaque jour' : ''}` : 'Pas encore vérifié'}${v.score !== null ? ` · <span class="no-translate">${v.score}/100</span>` : ''}</div></div>
      <button class="btn small" id="seccheck" ${can ? '' : 'disabled'} title="${v.next ? `Possible à partir de ${new Date(v.next).toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` : ''}">${v.running ? 'Vérification…' : 'Vérifier maintenant'}</button></div>
    ${!v.covered ? extHtml('security.site', a) : ''}
    ${v.error ? `<div class="banner bad small">${esc(v.error)}</div>` : ''}
    ${v.checked ? `${v.grade ? `<div class="sec-counts">${sevCounts(v.counts)}</div>` : ''}
      <div class="stack" style="gap:6px">${v.open.map(f => secItem(f, f.severity !== 'info' ? `<div><button class="btn small ghost" data-accept="${esc(f.key)}">Accepter ce risque</button></div>` : '')).join('') || '<p class="hint">Aucun point ouvert. Tout va bien.</p>'}</div>
      ${v.accepted.length ? `<details class="sec-more"><summary>Risques acceptés <span class="muted no-translate">${v.accepted.length}</span></summary><div class="stack" style="gap:6px">
        ${v.accepted.map(f => secItem(f, `<div><button class="btn small ghost" data-unaccept="${esc(f.key)}">Compter de nouveau</button></div>`)).join('')}</div></details>` : ''}
      ${v.fixed.length ? `<details class="sec-more"><summary>Corrigés ces 30 derniers jours <span class="muted no-translate">${v.fixed.length}</span></summary><div class="stack" style="gap:6px">${v.fixed.map(f => secItem(f)).join('')}</div></details>` : ''}`
      : '<p class="muted">ClaudePress vérifie le site en ligne, son nom de domaine et les dépendances de son dépôt face aux failles publiées. Comptez une à deux minutes.</p>'}
    ${v.covered ? `<div class="stack" style="gap:8px"><h3>Sauvegardes <span class="muted small">à chaque changement, gardées 90 jours</span></h3>
      ${v.backups.length ? `<div class="table-wrap"><table class="mon-table sec-backups"><thead><tr><th>Date</th><th>Commit</th><th>Taille</th><th></th></tr></thead><tbody>
        ${v.backups.slice(0, 10).map(b => `<tr><td class="nowrap">${longDay(b.at)}</td><td class="no-translate"><code>${esc(b.sha.slice(0, 7))}</code></td><td class="nowrap">${mb(b.size)}</td>
          <td><a class="btn small ghost" href="/api/admin/sites/${s.id}/backups/${b.id}" download>Télécharger</a></td></tr>`).join('')}</tbody></table></div>
        <span class="hint">Tous les fichiers du dépôt (textes, photos, code), même si le dépôt GitHub était effacé.</span>`
        : '<p class="hint">La première sauvegarde est faite à la prochaine vérification.</p>'}</div>` : ''}
    <p class="hint">Aucun outil ne peut garantir qu’un site ne sera jamais piraté. ClaudePress vérifie chaque jour, vous prévient de ce qui change et garde une copie du site à restaurer.</p>`;
  extRun('security.site', box, a);
  $('#seccheck', box)?.addEventListener('click', async () => {
    try { await api(`/api/admin/sites/${s.id}/security`, { check: true, lang: document.documentElement.lang }); securityCard(box, s, d); } catch (e) { toast(e.message); }
  });
  $$('[data-accept],[data-unaccept]', box).forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/admin/sites/${s.id}/security`, { accept: b.dataset.accept || b.dataset.unaccept, on: !!b.dataset.accept, lang: document.documentElement.lang }); toast('Enregistré.'); securityCard(box, s, d); }
    catch (e) { toast(e.message); }
  }));
  // while it runs: looked at again until it is done
  if (v.running) setTimeout(() => box.isConnected && securityCard(box, s, d), 5000);
  try { if (sessionStorage.getItem('to-security')) { sessionStorage.removeItem('to-security'); box.scrollIntoView({ block: 'start' }); window.scrollBy(0, -72); } } catch {}
}

/** Security, every site of the account with its grade, then the bulletin: the published flaws that affect them. */
async function securityTab(pane) {
  const d = await api('/api/admin/security');
  const total = k => d.sites.reduce((t, x) => t + (x.counts?.[k] || 0), 0);
  pane.innerHTML = `<div class="stack">
    <div class="mon-counts">
      ${['critical', 'high', 'medium', 'low'].map(k => `<div class="mon-count sec-${k}"><strong class="no-translate">${total(k)}</strong><span>${SEV[k]}</span></div>`).join('')}
      <p class="hint" style="margin:0;flex:1 1 220px">${d.covered ? 'Chaque site est vérifié chaque jour : le site en ligne, son nom de domaine, les dépendances de son dépôt. Ce qui est nouveau vous est signalé.' : 'Sans l’option Sécurité, chaque site se vérifie à la demande, une fois par jour.'}</p>
    </div>
    ${!d.covered ? extHtml('security.page', d) : ''}
    <div class="list mon-list">${d.sites.map(x => `<a class="row sec-row" href="#/admin/site/${x.id}" data-to-security>
        ${secGrade(x.grade)}
        <div class="t"><strong class="no-translate">${esc(x.name)}</strong><span class="small muted no-translate">${esc(x.url.replace(/^https?:\/\/(www\.)?|\/$/g, ''))}</span></div>
        <div class="sec-counts">${x.running ? '<span class="small muted">Vérification en cours…</span>' : x.checked && !x.grade ? '<span class="small muted">Pas de note : le site en ligne n’a pas répondu</span>' : x.checked ? sevCounts(x.counts) : '<span class="small muted">Pas encore vérifié</span>'}</div>
        <span class="small muted sec-when">${x.checked ? `Vérifié ${when(x.checked)}` : ''}${x.backup ? `<br>Sauvegardé ${when(x.backup)}` : ''}</span></a>`).join('')
      || emptyNini('Aucun site pour l’instant.')}</div>
    <div class="stack" style="gap:8px"><h2>Bulletin de sécurité</h2>
      <p class="hint">Les failles publiées (OSV.dev, et la liste des failles exploitées en ce moment de la CISA) qui touchent les dépendances de vos sites. Mis à jour à chaque vérification.</p>
      ${d.bulletin.length ? `<div class="stack" style="gap:6px">${d.bulletin.map(b => `<div class="sec-bulletin ${b.severity}">
        <div class="sec-b-head"><span class="sec-tag ${b.severity}">${b.malicious ? 'Malveillant' : SEV[b.severity]}</span>${b.kev ? '<span class="sec-tag critical">Exploitée en ce moment</span>' : ''}
          <a class="no-translate" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.cve || b.id)}</a>
          ${b.published ? `<span class="small muted">publiée le ${longDay(b.published)}</span>` : ''}</div>
        <div class="no-translate">${esc(b.summary)}</div>
        <div class="small">${b.sites.map(x => `<a href="#/admin/site/${x.id}" data-to-security class="no-translate">${esc(x.name)}</a> · <code class="no-translate">${esc(x.pkg)} ${esc(x.version)}</code>${x.fixed ? ` → <code class="no-translate">${esc(x.fixed)}</code>` : ' · <span>pas encore de correctif</span>'}${x.accepted ? ' · <span class="muted">accepté</span>' : ''}`).join('<br>')}</div></div>`).join('')}</div>`
        : '<p class="hint">Aucune faille publiée ne touche les dépendances de vos sites vérifiés.</p>'}</div>
  </div>`;
  $$('[data-to-security]', pane).forEach(a => a.addEventListener('click', () => { try { sessionStorage.setItem('to-security', '1'); } catch {} }));
  extRun('security.page', pane, d);
  if (d.sites.some(x => x.running)) setTimeout(() => pane.isConnected && adminPage === 'security' && securityTab(pane), 5000);
}

function sitesTab(pane, d) {
  const status = s => s.status === 'ready' ? '<span class="pill published">Connecté</span>'
    : s.status === 'error' ? '<span class="pill changes_requested">Erreur</span>' : '<span class="pill pending">Installation…</span>';
  pane.innerHTML = `<div class="stack">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <p class="muted">Chaque site est relié à son dépôt GitHub. Publier envoie le changement sur GitHub, qui met le site en ligne.
        <br><span class="small">${d.account.sitesLimit ? `${d.account.sitesUsed} site(s) sur ${d.account.sitesLimit} dans la formule ${esc(d.account.plans.find(p => p.id === d.account.plan).name)}.` : d.account.plans.length > 1 ? `Sites illimités (formule ${esc(d.account.plans.find(p => p.id === d.account.plan).name)}).` : 'Sites illimités.'}</span></p>
      ${d.account.sitesLimit && d.account.sitesUsed >= d.account.sitesLimit ? (upgradeBtn(planWith(d.account, p => p.sites === null || p.sites > d.account.sitesLimit), 'btn primary') || '<a class="btn" href="#/admin/account?plans">Voir les formules</a>') : '<a class="btn primary" href="#/admin/new-site">+ Ajouter un site</a>'}</div>
    ${d.account.ai.mode === 'none' && d.sites.length ? '<div class="banner">L’assistant IA n’est pas encore activé : choisissez une <a href="#/admin/account">formule avec IA incluse</a> ou ajoutez <a href="#/admin/keys">vos clés (BYOK)</a>.</div>' : ''}
    ${d.account.ai.mode === 'included' && d.account.ai.credits.left === 0 ? `<div class="banner bad" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <span>Les crédits IA sont épuisés : l’assistant est en pause jusqu’au 1er du mois prochain.</span><a class="btn small primary" href="#/admin/account?credits">Ajouter des crédits</a></div>` : ''}
    ${d.sites.map(s => `<section class="card site-card">${peekBox(s)}
      <div class="stack" style="gap:6px;min-width:0">
        <h2>${esc(s.name)} ${status(s)} ${monPill(s.monitor)} ${secPill(s.security)}</h2>
        <div class="small"><a href="${esc(s.liveUrl)}" target="_blank" rel="noopener">${esc(s.liveUrl)}</a> <span class="muted">· ${esc(s.repo.replace(/^https:\/\/github\.com\/|\.git$/g, ''))} · ${esc(s.branch)}</span></div>
        <div class="small muted" data-updated="${s.id}"></div>
        <div class="small">${clientsLine(s)}</div>
        ${liveSiteLine(s) ? `<div class="small">${liveSiteLine(s)}</div>` : ''}
        <div class="small muted">Ce mois-ci : ${s.usage.changes} demande(s), ${s.usage.published} publiée(s)${s.usage.scans ? `, ${s.usage.scans} analyse(s)` : ''}${s.usage.credits ? `, ${num(s.usage.credits)} crédits IA` : ''}</div>
        ${s.status === 'error' ? `<div class="banner bad"><strong>Connexion impossible.</strong><pre style="white-space:pre-wrap;margin:6px 0 0;font-size:.8rem">${esc(s.error)}</pre>
            <button class="btn small" data-retry="${s.id}" style="margin-top:8px">Réessayer</button></div>` : ''}
        ${s.paused ? `<div class="banner"><strong>En pause.</strong> Votre formule permet ${d.account.sitesLimit} site(s) : rien n’est modifié ni publié sur celui-ci tant que vous ne passez pas à une formule supérieure ou ne retirez pas un site.<div style="margin-top:8px">${upgradeBtn(planWith(d.account, p => p.sites === null || p.sites > d.account.sitesLimit))}</div></div>` : ''}
        ${s.status === 'setting_up' ? '<div class="banner info">Récupération du site depuis GitHub et première construction… Cela peut prendre quelques minutes.</div>' : ''}
      </div>
      <div class="site-card-actions">
        <a class="btn small primary" href="#/admin/site/${s.id}">Gérer le site</a>
        ${s.status === 'ready' ? `<a class="btn small" href="#/site/${s.id}">Ouvrir l’éditeur${s.pending ? ` · ${s.pending} à valider` : ''}</a>` : ''}</div>
    </section>`).join('') || `<div class="list">${emptyNini('Aucun site pour l’instant. <a href="#/admin/start">Bien démarrer</a> vous guide pas à pas.')}</div>`}
  </div>`;
  $$('[data-retry]').forEach(b => b.addEventListener('click', () => api(`/api/admin/sites/${b.dataset.retry}/retry`, {}).then(() => admin('sites'))));
  fillPeeks(pane);
  if (d.sites.some(s => s.status === 'setting_up')) timer = setTimeout(() => admin('sites'), 4000);
}

/** Who edits a site, in a line: their names, or a nudge to invite the first one. */
const clientsLine = s => s.members.length
  ? `<span>${s.members.length > 1 ? `${s.members.length} clients` : '1 client'}</span> <span class="muted">· <span class="no-translate">${s.members.map(m => esc(m.name)).join(', ')}</span></span>`
  : '<span class="muted">Aucun client pour l’instant.</span> <span class="muted">Invitez-les depuis « Gérer le site ».</span>';

/** A site that already has as many clients as the plan allows. */
const siteFull = (d, s) => !!d.account.clientsPerSite && s.members.length >= d.account.clientsPerSite;
/** The smallest plan above the account's that passes `test`: what an upgrade button offers, or null. */
const planWith = (a, test) => a.plans.slice(a.plans.findIndex(p => p.id === a.plan) + 1).find(test) || null;
/** A button to the plan cards that names the plan unlocking something. */
const upgradeBtn = (p, cls = 'btn small primary') => p ? `<a class="${cls}" href="#/admin/account?plans">Passer à ${esc(p.name)}</a>` : '';
const morePlan = (a, banner) => `<div class="banner info" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">${banner}</div>`;
/** The account has as many administrators as its plan allows: the plan that gives more, or null. */
const adminsFull = a => !!a.adminsLimit && a.adminsUsed >= a.adminsLimit
  ? (a.plans.find(p => p.admins === null || p.admins > a.adminsLimit) || { name: '' }) : null;
const fullHint = d => `Ce site a déjà ${d.account.clientsPerSite > 1 ? `ses ${d.account.clientsPerSite} clients` : 'son client'}, le maximum de votre formule. ${upgradeBtn(planWith(d.account, p => p.clients === null || p.clients > d.account.clientsPerSite), 'btn small')}`;

function peopleTab(pane, d) {
  const siteName = id => d.sites.find(s => s.id === id)?.name || id;
  pane.innerHTML = `<div class="stack">
    <section class="card stack"><h2>Inviter une personne</h2>
      <form id="inv" class="stack" style="gap:10px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input class="input" name="name" placeholder="Nom" required style="flex:1;min-width:160px">
          <input class="input" name="email" type="email" placeholder="E-mail" required style="flex:2;min-width:200px"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select class="input" name="kind" style="flex:1;min-width:180px"><option value="client">Client</option>${adminsFull(d.account) ? `<option value="admin" disabled>Administrateur · formule ${esc(adminsFull(d.account).name)}</option>` : '<option value="admin">Administrateur (tous les sites)</option>'}</select>
          <select class="input" name="siteId" style="flex:1;min-width:160px"><option value="">Site…</option>${d.sites.map(s => `<option value="${s.id}" ${siteFull(d, s) ? 'disabled' : ''}>${esc(s.name)}${siteFull(d, s) ? ' · complet' : ''}</option>`).join('')}</select>
          ${roleSelect('editor', 'name="role" style="flex:1;min-width:160px"')}
          ${scopeSelect('page', 'name="scope" style="flex:1;min-width:160px"')}
          <button class="btn primary">Créer l’invitation</button></div>
      </form>
      ${adminsFull(d.account)?.name ? morePlan(d.account, `<span>Votre formule permet ${d.account.adminsLimit} administrateur${d.account.adminsLimit > 1 ? 's' : ''} : passez à ${esc(adminsFull(d.account).name)} pour inviter votre équipe.</span>${upgradeBtn(adminsFull(d.account))}`) : ''}
      <div id="link"></div>
    </section>
    <div class="list">${d.users.map(x => `<div class="row">
      <div class="t"><div><strong>${esc(x.name)}</strong> ${x.agency ? `<span class="pill agency">${ROLE.agency}</span>` : ''} ${!x.active ? '<span class="pill changes_requested">Désactivé</span>' : !x.joined ? '<span class="pill pending">Invitation envoyée</span>' : ''}</div>
        <span class="muted small">${esc(x.email)}${x.agency ? ' · tous les sites' : x.sites.length ? ' · ' + x.sites.map(m => `${esc(siteName(m.siteId))} (${ROLE[m.role].toLowerCase()} · ${scopeLabel(m.scope).toLowerCase()})`).join(', ') : ' · aucun site'}${x.last_login ? ` · vu ${when(x.last_login)}` : ''}</span></div>
      ${x.id !== d.me ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
        ${x.active ? `<button class="btn small" data-link="${x.id}">${x.joined ? 'Lien de nouveau mot de passe' : 'Lien d’invitation'}</button>` : ''}
        ${x.active ? `<button class="btn small" data-admin="${x.id}" data-v="${x.agency ? 0 : 1}">${x.agency ? 'Retirer admin' : 'Rendre admin'}</button>` : ''}
        ${x.agency ? `<button class="btn small ghost ${x.active ? 'danger' : ''}" data-active="${x.id}" data-v="${x.active ? 0 : 1}">${x.active ? 'Désactiver' : 'Réactiver'}</button>`
          : `<button class="btn small ghost danger" data-active="${x.id}" data-v="0">Retirer tous ses accès</button>`}</div>` : '<span class="muted small">vous</span>'}
    </div>`).join('')}</div>
  </div>`;
  const showLink = (who, url) => {
    $('#link').innerHTML = `<div class="banner info stack" style="gap:8px"><div><span>Envoyez ce lien à</span> <strong class="no-translate">${esc(who)}</strong></div>
      <span class="hint">Il sert une seule fois et expire dans 14 jours.</span>
      <div style="display:flex;gap:8px"><input class="input" readonly value="${esc(url)}" id="linkv"><button class="btn" id="copy">Copier</button></div></div>`;
    $('#copy').addEventListener('click', () => { navigator.clipboard.writeText(url); toast('Lien copié.'); });
    $('#link').scrollIntoView({ block: 'nearest' });
  };
  $('#inv').addEventListener('submit', async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    if (v.kind === 'client' && !v.siteId) return toast('Choisissez le site auquel ce client aura accès.');
    try {
      const r = await api('/api/admin/users', { name: v.name, email: v.email, admin: v.kind === 'admin', siteId: v.kind === 'client' ? v.siteId : null, role: v.role, scope: v.scope,
        send: true, lang: document.documentElement.lang });
      await admin('people');
      if (r.emailed) toast(`Invitation envoyée à ${v.email.trim().toLowerCase()}.`, 5000);
      else if (r.inviteUrl) showLink(v.name, r.inviteUrl);
      else toast(`${v.name} a déjà un compte ClaudePress : l’accès au site est ajouté.`);
    } catch (err) { toast(err.message); }
  });
  $$('[data-link]').forEach(b => b.addEventListener('click', async () => {
    const r = await api(`/api/admin/users/${b.dataset.link}/invite`, {});
    showLink(d.users.find(x => x.id === b.dataset.link).name, r.inviteUrl);
  }));
  $$('[data-admin]').forEach(b => b.addEventListener('click', () => api(`/api/admin/users/${b.dataset.admin}`, { admin: b.dataset.v === '1' }).then(() => admin('people')).catch(e => toast(e.message))));
  $$('[data-active]').forEach(b => b.addEventListener('click', () => api(`/api/admin/users/${b.dataset.active}`, { active: b.dataset.v === '1' }).then(() => admin('people')).catch(e => toast(e.message))));
}

function requestsTab(pane, d) {
  // a request of a kind the permissions keep for the agency: allow it from now on, in one click
  const allow = r => {
    const now = d.sites.find(s => s.id === r.siteId)?.policy?.[r.kind];
    if (!now || now === 'allowed') return '';
    return `<div class="row-actions">${now === 'agency' ? `<button class="btn small" data-allow="${r.siteId}" data-kind="${r.kind}" data-value="approval">Autoriser désormais, avec validation</button>` : ''}
      <button class="btn small" data-allow="${r.siteId}" data-kind="${r.kind}" data-value="allowed">Autoriser désormais, librement</button></div>`;
  };
  pane.innerHTML = `<div class="list">${d.requests.map(r => `<div class="row request-row"><a class="row-link" href="#/change/${r.id}"><span class="muted">${icon('page')}</span>
    <div class="t"><strong>${esc(r.title)}</strong><span class="muted small">${esc(r.site)} · ${esc(r.author)} · ${when(r.updated)}${r.kind ? ` · <span>${REQUEST_KIND[r.kind] || esc(r.kind)}</span>` : ''}</span></div></a>${allow(r)}</div>`).join('')
    || '<div class="empty">Aucune demande de client en attente.</div>'}</div>
    <p class="hint" style="margin-top:10px">Autoriser change les permissions du site pour ce genre de demande : le client le fera lui-même la prochaine fois. Vous pouvez revenir en arrière dans l’onglet Sites.</p>`;
  $$('[data-allow]', pane).forEach(b => b.addEventListener('click', async () => {
    const site = d.sites.find(s => s.id === b.dataset.allow);
    site.policy = await api(`/api/admin/sites/${b.dataset.allow}/policy`, { kind: b.dataset.kind, value: b.dataset.value });
    toast('Permission enregistrée pour ce site.');
    requestsTab(pane, d);
  }));
}

/** A text field with a list of suggestions under it, filtered as you type; arrows, Enter and Escape work. */
function combo(input, choices) {
  const box = input.nextElementSibling;
  let items = [], active = -1;
  const show = on => { box.hidden = !on; input.setAttribute('aria-expanded', String(on)); };
  const mark = i => {
    active = i;
    [...box.children].forEach((el, k) => el.classList.toggle('on', k === i));
    box.children[i]?.scrollIntoView({ block: 'nearest' });
  };
  const open = () => {
    const q = input.value.trim().toLowerCase();
    items = choices.filter(c => c.toLowerCase().includes(q));
    box.innerHTML = items.map(c => { const [org, ...rest] = c.split('/');
      return `<div class="opt" role="option">${rest.length ? `<span class="org">${esc(org)}/</span>${esc(rest.join('/'))}` : esc(c)}</div>`; }).join('');
    active = -1;
    show(items.length > 0);
  };
  const pick = i => { if (items[i] == null) return; input.value = items[i]; show(false); };
  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', () => show(false));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (box.hidden) open();
      if (items.length) mark((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter' && !box.hidden && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape' && !box.hidden) { e.preventDefault(); show(false); }
  });
  box.addEventListener('mousedown', e => e.preventDefault()); // keeps the focus in the field
  box.addEventListener('click', e => { e.preventDefault(); const i = [...box.children].indexOf(e.target.closest('.opt')); if (i >= 0) pick(i); });
  box.addEventListener('mousemove', e => { const i = [...box.children].indexOf(e.target.closest('.opt')); if (i >= 0 && i !== active) mark(i); });
}

/** Adding a website, or the one page that manages a connected one: its clients, what they may change, its settings. */
async function siteForm(s, d) {
  window.PREVIEW_MODES ||= (await api('/api/admin')).previewModes;
  const a = s?.adapter || {};
  const v = (x, d = '') => esc(x ?? d);
  // on a connected site, the settings and Save wait for the scan, which proposes them: scanCard shows them once it is done
  const after = s ? 'data-after-scan hidden' : '';
  const status = !s ? '' : s.status === 'ready' ? '<span class="pill published">Connecté</span>'
    : s.status === 'error' ? '<span class="pill changes_requested">Erreur</span>' : '<span class="pill pending">Installation…</span>';
  app.innerHTML = topbar(`<span class="muted">/</span><a class="crumb" href="#/admin/sites">Administration</a>${s ? `<span class="muted">/</span><span class="no-translate">${esc(s.name)}</span>` : ''}`) + `<main class="page"><div class="narrow stack ${s ? 'site-page' : ''}">
    ${s ? `<div class="site-head">${peekBox(s)}<div class="stack" style="gap:4px;min-width:0">
        <h1>${esc(s.name)} ${status}</h1>
        <div class="small"><a href="${esc(s.liveUrl)}" target="_blank" rel="noopener">${esc(s.liveUrl)}</a></div>
        <div class="small muted" data-updated="${s.id}"></div>
        <div>${s.status === 'ready' ? `<a class="btn small primary" href="#/site/${s.id}">Ouvrir l’éditeur${s.pending ? ` · ${s.pending} à valider` : ''}</a>` : ''}</div></div></div>
      <section class="card stack" id="clients"></section>
      <section class="card stack" id="golive"></section>
      <section class="card stack" id="monitor"></section>
      <section class="card stack" id="security"></section>`
    : `<div><h1>Ajouter un site</h1>
      <p class="muted" style="margin-top:6px">ClaudePress récupère le site depuis GitHub, le construit une première fois, puis vos clients peuvent le modifier.</p></div>`}
    <form class="stack" id="sf">
    ${s ? '<section class="card stack scan" id="scan"></section>' : '<p class="hint">Une fois le site connecté, ClaudePress lit son dépôt et vous dit ce que vos clients pourront changer, ce qui est commun à toutes les pages et ce qui reste chez vous.</p>'}
    <section class="card stack" ${after}><h2>Le site</h2>
      <label class="field"><span>Nom</span><input name="name" value="${v(s?.name)}" required placeholder="Boulangerie Dupont"></label>
      <label class="field"><span>Adresse du site en ligne</span><input name="liveUrl" value="${v(s?.liveUrl)}" required placeholder="https://www.exemple.be"></label>
      <label class="field"><span>Dépôt GitHub</span>
        <div class="combo"><input name="repo" value="${v((s?.repo || '').replace(/^https:\/\/github\.com\/|\.git$/g, ''))}" required placeholder="organisation/depot" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="repolist">
          <div class="combo-list" id="repolist" role="listbox" hidden></div></div>
        <span class="hint" id="repohint">Par exemple mon-agence/site-client.</span></label>
    </section>
    <section class="card stack" ${after}><h2>Aperçus et publication</h2>
      <div class="choices" role="radiogroup" aria-label="Aperçus et publication">
        ${(window.PREVIEW_MODES || ['claudepress', 'github', 'local']).map(m => { const [title, text] = {
            claudepress: ['Par ClaudePress', 'Vos clients voient leurs changements sur une adresse d’aperçu. Publier envoie le changement sur GitHub.'],
            github: ['Par le pipeline du site', 'Chaque changement devient une pull request. Le site construit son propre aperçu et se met en ligne à la fusion.'],
            local: ['Sur ce serveur', 'Une copie du site est construite ici. Pour une installation locale.'] }[m];
          return `<label class="choice"><input type="radio" name="previews" value="${m}" ${(s?.previews || (window.PREVIEW_MODES || ['claudepress'])[0]) === m ? 'checked' : ''}>
            <span class="choice-body"><strong>${title}${m === 'claudepress' ? ' <span class="pill agency">Recommandé</span>' : ''}</strong><span class="hint">${text}</span></span></label>`; }).join('')}
      </div>
      <div id="localpush" class="stack" style="gap:6px" ${s?.previews === 'local' ? '' : 'hidden'}>
        <label class="toggle"><input type="checkbox" name="push" ${s?.push ? 'checked' : ''}>Publier envoie sur GitHub (le pipeline du site le met en ligne)</label>
        <span class="hint">Laissez décoché pour tester : les publications restent dans ClaudePress sans toucher au site.</span></div>
      <span class="hint">Dans tous les cas, la mise en ligne est faite par l’hébergeur du site quand GitHub change (Netlify, Vercel, Cloudflare, Firebase, Hostinger…).</span>
    </section>
    <details class="card advanced" id="advanced" ${after}><summary><span><strong>Réglages avancés</strong>
        <span class="hint">Branche, notes pour l’IA, format du contenu. ClaudePress les propose en analysant le dépôt : en général, rien à changer.</span></span></summary>
      <div class="stack" style="margin-top:16px">
        <label class="field"><span>Branche publiée</span><input name="branch" value="${v(s?.branch, 'main')}"></label>
        <label class="field"><span>Notes pour l’IA <em>l’activité, la langue, le ton</em></span>
          <textarea name="guide" rows="5" placeholder="Ex. : boulangerie artisanale à Namur, site en français. Ton chaleureux, on dit « nous ».">${v(a.guide)}</textarea>
          <span class="hint">Ce que chaque personne peut modifier se règle avec les rôles et les permissions du site.</span></label>
        <label class="field"><span>Format du contenu</span>
          <select name="type" class="input" id="ctype">
            <option value="blocks-json" ${a.type !== 'markdown' ? 'selected' : ''}>Pages JSON : un fichier de pages en sections, lignes et blocs</option>
            <option value="markdown" ${a.type === 'markdown' ? 'selected' : ''}>Markdown : un fichier par page (Astro, Next.js, Hugo, Eleventy…)</option>
          </select></label>
        <div class="stack" data-ctype="blocks-json">
          <label class="field"><span>Fichier des pages</span><input name="pagesFile" value="${v(a.pagesFile, 'source/content/pages.json')}"></label>
          <label class="field"><span>Fichier des prix <em>facultatif</em></span><input name="pricesFile" value="${v(a.pricesFile)}" placeholder="source/content/prices.json"></label>
        </div>
        <div class="stack" data-ctype="markdown">
          <label class="field"><span>Dossiers de pages <em>un par ligne : dossier, adresse, page ou post</em></span>
            <textarea name="collections" rows="3" placeholder="src/content/blog /blog/{slug}/ post&#10;src/content/pages /{path}/ page">${v((a.collections || []).map(c => `${c.dir} ${c.url} ${c.kind}`).join('\n'))}</textarea>
            <span class="hint">{path} : le chemin du fichier dans le dossier, sans extension (« index » donne son dossier). {slug} : le slug de l’en-tête, ou le nom du fichier.</span></label>
        </div>
        <label class="field"><span>Langue modifiable</span><input name="lang" value="${v(a.lang, 'fr')}"></label>
        <label class="field"><span>Dossier des images</span><input name="mediaDir" value="${v(a.mediaDir, 'source/media')}"></label>
        <label class="field"><span>Adresse publique des images</span><input name="mediaPrefix" value="${v(a.mediaPrefix, '/wp-content/uploads/')}"></label>
        <label class="field"><span>Commande de construction</span><input name="build" value="${v((a.build || ['python3', 'build/build.py']).join(' '))}"></label>
        <label class="field"><span>Dossier construit</span><input name="outDir" value="${v(a.outDir, 'site')}"></label>
        <label class="field"><span>Fichiers de textes communs <em>facultatif · menu, pied de page, libellés (JSON)</em></span><input name="sharedFiles" value="${v((a.sharedFiles || []).join(' '))}" placeholder="source/content/texts.json source/content/chrome.json"></label>
        <label class="field"><span>Dossiers de cache de la construction <em>facultatif · accélère les aperçus</em></span><input name="cacheDirs" value="${esc((s?.cacheDirs || []).join(' '))}" placeholder="build/.cache"></label>
      </div></details>
    <div class="banner bad" id="err" hidden></div>
    <div class="form-actions" ${after}><button class="btn primary" type="submit">${s ? 'Enregistrer' : 'Connecter le site'}</button>
      <a class="btn ghost" href="#/admin/sites">Annuler</a>
      ${s ? '<span class="spacer"></span><button class="btn ghost danger" type="button" id="rmsite">Retirer de ClaudePress</button>' : ''}</div>
  </form></div></main>`;
  wireTop();
  api('/api/admin/github/repos').then(list => {
    combo($('#sf [name=repo]'), list.map(r => r.fullName));
    if (!list.length) $('#repohint').textContent = 'Aucun dépôt autorisé : connectez GitHub dans l’onglet Sites.';
  }).catch(() => {});
  $('#sf').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { name: f.name, liveUrl: f.liveUrl, repo: f.repo, branch: f.branch, push: f.push === 'on', previews: f.previews, cacheDirs: f.cacheDirs,
      adapter: { type: f.type, pagesFile: f.pagesFile, pricesFile: f.pricesFile, collections: f.collections, lang: f.lang, mediaDir: f.mediaDir, mediaPrefix: f.mediaPrefix, build: f.build, outDir: f.outDir, guide: f.guide, sharedFiles: f.sharedFiles },
      lang: document.documentElement.lang };
    try {
      const r = await api(s ? `/api/admin/sites/${s.id}` : '/api/admin/sites', body);
      if (!s) track('site_added', { site_type: f.type });
      toast(s ? 'Enregistré. Le site se met à jour.' : 'Site ajouté. Récupération depuis GitHub, puis analyse du dépôt…');
      if (s) admin('site', s.id); else location.hash = `#/admin/site/${r.id}`;
    } catch (err) { $('#err').hidden = false; $('#err').textContent = err.message; }
  });
  $$('#sf [name=previews]').forEach(r => r.addEventListener('change', () => { $('#localpush').hidden = $('#sf [name=previews]:checked').value !== 'local'; }));
  const showType = () => document.querySelectorAll('[data-ctype]').forEach(el => { el.hidden = el.dataset.ctype !== $('#ctype').value; });
  $('#ctype').addEventListener('change', showType);
  showType();
  if (s) { scanCard(s, $('#scan'), $('#sf')); clientsCard($('#clients'), s, d); liveCard($('#golive'), s); monitorCard($('#monitor'), s, d); securityCard($('#security'), s, d); fillPeeks(app); }
  $('#rmsite')?.addEventListener('click', async () => {
    if (!confirm(`Retirer ${s.name} de ClaudePress ? Le site en ligne et son dépôt GitHub ne sont pas touchés.`)) return;
    await api(`/api/admin/sites/${s.id}/remove`, {});
    location.hash = '#/admin/sites';
  });
}

/**
 * The people who edit a site: who they are, what they may do, and the invitation of a new one. The invitation goes by
 * e-mail (server/mail.ts) when the server can send it; otherwise, or if the administrator prefers, they get the link.
 */
function clientsCard(box, s, d, notice = '') {
  const person = id => d.users.find(x => x.id === id) || {};
  const others = d.users.filter(x => !x.agency && x.active && !s.members.some(m => m.id === x.id));
  const full = siteFull(d, s);
  box.innerHTML = `<div class="side-head"><div><h2>Clients</h2>
      <p class="hint">Les personnes de votre client qui modifient ce site. Les administrateurs de l’agence ont accès à tous les sites.</p></div>
    ${full ? '' : '<button class="btn primary" type="button" id="inv-open">+ Inviter un client</button>'}</div>
    ${full ? `<div class="hint">${fullHint(d)}</div>` : ''}
    <form id="inv" class="invite-form stack" hidden>
      <div class="invite-grid">
        <label class="field"><span>Nom</span><input class="input" name="name" required autocomplete="off" placeholder="Marie Dupont"></label>
        <label class="field"><span>E-mail</span><input class="input" name="email" type="email" required autocomplete="off" placeholder="marie@exemple.be"></label>
        <label class="field"><span>Publication</span>${roleSelect('editor', 'name="role"')}</label>
        <label class="field"><span>Peut changer</span>${scopeSelect('page', 'name="scope"')}</label></div>
      ${d.mail ? '<label class="toggle"><input type="checkbox" name="send" checked>Envoyer l’invitation par e-mail</label>'
        : '<p class="hint">L’envoi des e-mails n’est pas encore activé sur ce serveur : vous recevez un lien à transmettre vous-même.</p>'}
      <p class="hint">Votre client reçoit un lien pour créer son accès : il choisit son mot de passe (ou continue avec Google) et arrive directement dans son site. Vous ne connaissez jamais son mot de passe.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">${d.mail ? 'Envoyer l’invitation' : 'Créer l’invitation'}</button>
        <button class="btn ghost" type="button" id="inv-cancel">Annuler</button></div></form>
    <div id="inv-done">${notice}</div>
    ${s.members.length ? `<div class="people-rows"><div class="people-head"><span>Personne</span><span>Publication</span><span>Peut changer</span><span title="Un e-mail quand le site ne répond plus, et quand il revient">Alertes</span><span></span></div>
      ${s.members.map(m => { const p = person(m.id); return `<div class="person-row"><div class="who"><strong class="no-translate">${esc(m.name)}</strong>${p.joined ? '' : ' <span class="pill pending">Invitation envoyée</span>'}<div class="muted small no-translate">${esc(m.email)}</div></div>
        ${roleSelect(m.role, `data-role data-u="${m.id}" aria-label="Publication"`)}
        ${scopeSelect(m.scope, `data-scope data-u="${m.id}" aria-label="Peut changer"`)}
        <label class="toggle alerts" title="Un e-mail quand le site ne répond plus, et quand il revient"><input type="checkbox" data-alerts data-u="${m.id}" ${m.alerts ? 'checked' : ''}><span>Alertes si le site tombe</span></label>
        <div class="acts">${p.joined ? '' : `<button class="btn small ghost" type="button" data-reinvite="${m.id}">${d.mail ? 'Renvoyer' : 'Lien d’invitation'}</button>`}
          <button class="btn small ghost danger" type="button" data-rm="${m.id}">Retirer</button></div></div>`; }).join('')}
      </div>`
      : '<div class="empty-clients muted">Aucun client sur ce site pour l’instant. Invitez la personne qui s’occupe du site chez votre client : elle pourra le modifier en écrivant simplement ce qu’elle veut.</div>'}
    ${others.length && !full ? `<details class="add-existing"><summary>Donner accès à une personne qui a déjà un compte</summary>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><select class="input" id="add-u" style="flex:2;min-width:200px"><option value="">Choisir…</option>
        ${others.map(x => `<option value="${x.id}">${esc(x.name)} · ${esc(x.email)}</option>`).join('')}</select>
        ${roleSelect('editor', 'id="add-r" style="flex:1;min-width:150px"')}${scopeSelect('page', 'id="add-s" style="flex:1;min-width:150px"')}
        <button class="btn" type="button" id="add-go">Ajouter</button></div></details>` : ''}
    <details class="hint-more"><summary>Ce que veulent dire Publication et Peut changer</summary>
      <p class="hint">${ROLE.approver} : ${ROLE_HINT.approver}<br>${ROLE.editor} : ${ROLE_HINT.editor}</p>
      <p class="hint">${Object.keys(SCOPE).map(k => `<strong>${SCOPE[k]}</strong> : ${SCOPE_HINT[k]}`).join('<br>')}</p></details>`;
  const redraw = async (note = '') => { const d2 = await api('/api/admin'); clientsCard(box, d2.sites.find(x => x.id === s.id) || s, d2, note); };
  const linkNote = (who, url) => `<div class="banner info stack" style="gap:8px"><div><span>Envoyez ce lien à</span> <strong class="no-translate">${esc(who)}</strong></div>
    <span class="hint">Il sert une seule fois et expire dans 14 jours.</span>
    <div style="display:flex;gap:8px"><input class="input no-translate" readonly value="${esc(url)}"><button class="btn" type="button" data-copy-link="${esc(url)}">Copier</button></div></div>`;
  const sentNote = (who, email) => `<div class="banner info stack" style="gap:4px"><div><strong>Invitation envoyée par e-mail</strong> · <span class="no-translate">${esc(who)} (${esc(email)})</span></div>
    <span class="hint">Le lien reste valable 14 jours. Pas reçue ? Elle est peut-être dans les indésirables ; vous pouvez la renvoyer d’ici.</span></div>`;
  $('#inv-open', box)?.addEventListener('click', () => { $('#inv', box).hidden = false; $('#inv-open', box).hidden = true; $('#inv [name=name]', box).focus(); });
  $('#inv-cancel', box)?.addEventListener('click', () => { $('#inv', box).hidden = true; $('#inv-open', box).hidden = false; });
  $('#inv', box)?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, v = Object.fromEntries(new FormData(f));
    const btn = $('button:not([type])', f); btn.disabled = true;
    try {
      const r = await api('/api/admin/users', { name: v.name, email: v.email, siteId: s.id, role: v.role, scope: v.scope, send: v.send === 'on', lang: document.documentElement.lang });
      await redraw(r.emailed ? sentNote(v.name, v.email.trim().toLowerCase())
        : r.inviteUrl ? linkNote(v.name, r.inviteUrl)
        : `<div class="banner info"><span class="no-translate">${esc(v.name)}</span> <span>a déjà un compte ClaudePress : l’accès au site est ajouté.</span></div>`);
    } catch (err) { toast(err.message); btn.disabled = false; }
  });
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-copy-link]');
    if (b) navigator.clipboard.writeText(b.dataset.copyLink).then(() => toast('Lien copié.'), () => toast('Copie impossible.'));
  });
  $$('[data-reinvite]', box).forEach(b => b.addEventListener('click', async () => {
    const m = s.members.find(x => x.id === b.dataset.reinvite);
    try {
      const r = await api(`/api/admin/users/${m.id}/invite`, { send: !!d.mail, siteId: s.id, lang: document.documentElement.lang });
      $('#inv-done', box).innerHTML = r.emailed ? sentNote(m.name, m.email) : linkNote(m.name, r.inviteUrl);
    } catch (err) { toast(err.message); }
  }));
  $$('[data-role]', box).forEach(sel => sel.addEventListener('change', () => api('/api/admin/members', { userId: sel.dataset.u, siteId: s.id, role: sel.value }).then(() => toast('Enregistré.'))));
  // uptime alerts: this person gets an e-mail (and a notification) when the site goes down and when it is back
  $$('[data-alerts]', box).forEach(el => el.addEventListener('change', async () => {
    try {
      await api('/api/admin/members', { userId: el.dataset.u, siteId: s.id, alerts: el.checked });
      s.members.find(x => x.id === el.dataset.u).alerts = el.checked;
      toast(el.checked ? 'Cette personne sera prévenue si le site ne répond plus.' : 'Enregistré.');
      if (d.account.monitoring && $('#monitor')) monitorCard($('#monitor'), s, d);
    } catch (err) { toast(err.message); el.checked = !el.checked; }
  }));
  $$('[data-scope]', box).forEach(sel => sel.addEventListener('change', () => {
    if (sel.value === 'full' && !confirm('Tout modifier, comme l’agence : cette personne pourra changer les gabarits, les styles et les scripts du site. Continuer ?')) { sel.value = 'page'; return; }
    api('/api/admin/members', { userId: sel.dataset.u, siteId: s.id, scope: sel.value }).then(() => toast('Enregistré.'));
  }));
  $$('[data-rm]', box).forEach(b => b.addEventListener('click', () => {
    const m = s.members.find(x => x.id === b.dataset.rm);
    if (!confirm(`Retirer l’accès de ${m.name} à ${s.name} ?`)) return;
    api('/api/admin/members', { userId: m.id, siteId: s.id, role: null }).then(() => redraw());
  }));
  $('#add-go', box)?.addEventListener('click', () => {
    const u = $('#add-u', box).value;
    if (!u) return toast('Choisissez une personne.');
    api('/api/admin/members', { userId: u, siteId: s.id, role: $('#add-r', box).value, scope: $('#add-s', box).value }).then(() => redraw()).catch(err => toast(err.message));
  });
}

// ---- the import scan: what clients can change on a site, what is shared by every page, what stays with the agency

/** The scan, step by step: fetching the site, reading its files, then what Claude finds as it writes, then the checks. */
function scanSteps(scan) {
  const p = scan?.progress || {};
  const PHASES = { framework: 2, summary: 2, supported: 2, why: 2, convert: 2, improve: 2, red_flags: 2, settings: 2, editable: 3, shared: 3, locked: 3, guide: 4, site_map: 5, permissions: 6 };
  const at = !scan ? 0 : !p.step || p.step === 'read' ? 1 : p.step === 'check' ? 7 : PHASES[p.phase] || 2;
  const names = list => `<ul class="found no-translate">${list.slice(-6).map(x => `<li>${esc(x)}</li>`).join('')}${list.length > 6 ? `<li class="more">+ ${list.length - 6}</li>` : ''}</ul>`;
  const count = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const rows = [
    ['Récupérer le site depuis GitHub', at === 0 ? '<span class="hint">Copie du dépôt et première construction</span>' : ''],
    ['Lire les fichiers du dépôt', p.total ? `<span class="hint">${p.files} / ${p.total} fichiers lus</span>${at === 1 && p.current ? `<code class="no-translate">${esc(p.current)}</code>` : ''}` : ''],
    ['Comprendre comment le site est fait', p.framework ? `<span class="hint no-translate">${esc(p.framework)}</span>` : ''],
    ['Repérer ce que vos clients pourront modifier', (p.editable?.length || p.shared?.length || p.locked?.length) ? `<span class="hint">${[
      count(p.editable.length, 'zone modifiable', 'zones modifiables'), count(p.shared.length, 'texte commun', 'textes communs'), count(p.locked.length, 'zone réservée', 'zones réservées')].join(' · ')}</span>${names([...p.editable, ...p.shared])}` : ''],
    ['Écrire les notes pour l’IA', ''],
    ['Cartographier les pages', p.pages?.length ? `<span class="hint">${count(p.pages.length, 'page', 'pages')}</span>${names(p.pages)}` : ''],
    ['Proposer les permissions', ''],
    ['Vérifier les propositions dans le dépôt', ''],
  ];
  return `<ol class="scan-steps">${rows.map(([title, detail], i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">
      <span class="dot">${i < at ? '✓' : ''}</span><div><span class="t">${title}</span>${i <= at && detail ? `<div class="d">${detail}</div>` : ''}</div></li>`).join('')}</ol>
    <span class="hint" data-elapsed></span>`;
}
/** The scan card is redrawn only when its steps change, so nothing blinks; the time since the start ticks on its own. */
function paintSteps(root, html, scan) {
  if (root._html !== html) { root.innerHTML = html; root._html = html; }
  const secs = scan?.started ? Math.max(0, Math.round((Date.now() - new Date(scan.started).getTime()) / 1000)) : 0;
  const el = $('[data-elapsed]', root);
  if (el) el.textContent = `${scan?.started ? `Analyse commencée il y a ${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s · ` : ''}environ 1 à 2 minutes en tout, après la récupération du site`;
}

// what ClaudePress edits, for a developer converting a site (server/adapters/blocks-json.ts, markdown.ts)
const FORMAT_SPEC = `ClaudePress edits one of two formats:
1. One JSON file of pages, keyed "<lang>:<url>" (e.g. "fr:/smart-ems/"). Each page: { "url", "lang", "kind": "page" | "post", "h1", "seo": { "title", "description" }, "sections": [ { "tone", "bg", "rows": [ [ { "w": "1_2", "blocks": [ … ] } ] ] } ] }.
   Blocks: { "t": "h", "level": 2, "html" }, { "t": "p", "html" }, { "t": "quote", "html" }, { "t": "list", "ordered": false, "items": [ … ] }, { "t": "img", "src", "alt", "href"? }, { "t": "btn", "text", "href" }, { "t": "bg", "src" } (a section's background photo), { "t": "body", "blocks": [ … ] } (an article's body). Blog posts are pages of the same file. Prices, if any, go in a separate JSON file with "items".
2. Markdown or MDX files with YAML or TOML front matter (title, description, cover photo), in folders each published under an address pattern.
Texts shared by many pages (menu labels, footer, business details, interface labels) go in shared JSON files.
Special parts (forms, maps, logo carousels, timelines) can stay typed sections that the templates render: only their texts and photos need to be blocks.`;

/** A prompt to paste into Claude Code: the developer's steps, inside rules that keep the site looking exactly the same. */
function claudeCodePrompt(s, r, steps) {
  const build = r.settings?.build || [].concat(s.adapter?.build || []).join(' ');
  const out = r.settings?.outDir || s.adapter?.outDir || '';
  const flags = r.red_flags || [];
  return [
    `You are working in the repository of the website ${s.name} (${s.liveUrl}): ${s.repo}, branch ${s.branch}.`,
    '',
    r.supported ? 'Goal: let this site’s clients edit more of it through ClaudePress, without changing anything visitors see.'
      : 'Goal: make this site’s content editable through ClaudePress, without changing anything visitors see.',
    '',
    'Rules',
    `- Work on a new branch named claudepress-editable. Do not push to ${s.branch} and do not deploy.`,
    `- The site must stay exactly as it is. Before changing anything, build it${build ? ` (${build})` : ''} and keep a copy of the output${out ? ` (${out}/)` : ''}. After each step, build again and compare with that copy (diff -r). Any difference in text, markup, links, images, meta tags or structured data is a regression: fix it before going on. Differences that only come from formatting (whitespace, attribute order) are acceptable; list them.`,
    '- Do not change styles, scripts, the markup of the templates, URLs, forms or SEO tags, and do not rename or move images.',
    '- Keep the old files until the new ones give the same output; remove what is no longer used in a separate commit.',
    '- Commit in small steps with clear messages. Stop and ask me before any step that would change what visitors see.',
    '- If you find secrets (API keys, tokens, passwords) in the repository, tell me where: never copy their values.',
    '',
    'Steps',
    String(steps).trim(),
    ...(r.supported ? [] : ['', 'Target format', FORMAT_SPEC]),
    ...(flags.length ? ['', 'Also noticed (tell me what you think; do not fix without asking)', ...flags.map(f => `- [${f.severity}] ${f.where}: ${f.what}`)] : []),
    '',
    'When you are done: summarise what changed, show the result of the last comparison, and list anything you could not do.',
  ].join('\n');
}

const SEVERITY = { high: 'Important', medium: 'À vérifier', low: 'Mineur' };

function scanCard(s, root, form) {
  const SOURCE = { content: 'Contenu', shared: 'Commun', code: 'Dans le code' };
  const TABS = { who: 'Qui modifie quoi', pages: 'Pages', content: 'Contenu', tech: 'Technique' };
  let tab = 'who';
  const applyBar = () => `<div class="apply-bar"><button class="btn small" type="button" data-use-proposal>Reprendre la proposition</button>
    <button class="btn primary small" type="button" data-apply-perms>Appliquer ces permissions</button>
    <span class="hint" data-dirty>Pas encore appliquées à ce site.</span><span class="hint" data-clean>✓ Ce sont les permissions du site.</span></div>`;
  // the pickers hold the site's permissions as they are; where the scan proposes otherwise, the row says so
  const proposed = (key, attr, value) => `<span class="hint proposed" ${attr}>Proposé : <b>${PERM_SHORT[value] || ''}</b></span>`;
  // kind by kind: the agency draws the line before clients start
  const kindsPanel = (r, policy) => {
    const p = r.permissions;
    if (!p) return '<p class="hint">Analysez à nouveau le site pour obtenir une proposition.</p>';
    return `${r.applied ? '<div class="banner info" data-auto>Appliquées à ce site dès l’analyse, puisqu’il n’avait pas encore de permissions. Vous pouvez les changer ici.</div>' : ''}
      <p class="hint no-translate">${esc(p.why)}</p>
      <div class="perm-rows">${Object.keys(KIND).map(k => `<div class="perm-row"><div><span>${KIND[k]}</span>
          ${proposed(k, `data-prop-kind="${k}"`, p[k])}</div>${permissionPicker(policy[k], `data-pk="${k}" data-proposal="${p[k]}"`)}</div>`).join('')}</div>
      ${permissionLegend()}${applyBar()}`;
  };
  // the site's map, read from its code: page by page, what the content gives and what the code fixes
  const pagesPanel = (r, policy) => {
    if (!r.site_map?.length) return '<p class="hint">Rien ici.</p>';
    return `<p class="hint">Page par page, ce qui vient du contenu (vos clients le changent) et ce que le code fixe (pour l’agence). Choisissez qui modifie les textes et photos de chaque page.</p>
      <div class="site-map">${r.site_map.map((m, i) => `<div class="map-page">
        <div class="map-head"><div><strong class="no-translate">${esc(m.title)}</strong> <code class="no-translate">${esc(m.page)}</code>
          <div class="hint no-translate">${esc(m.why)}</div>${proposed(i, `data-prop-map="${i}"`, m.proposed)}</div>
          ${permissionPicker(policy.pages[m.page] || policy.content, `data-map="${i}" data-proposal="${m.proposed}"`)}</div>
        <ul class="zones">${m.zones.map(z => `<li class="${z.source}"><span class="src">${SOURCE[z.source] || z.source}</span>
          <span><strong class="no-translate">${esc(z.name)}</strong> <span class="hint no-translate">${esc(z.note)}</span></span></li>`).join('')}</ul></div>`).join('')}</div>
      <p class="hint">Une page réglée comme « Textes et photos des pages » suit ce réglage ; les autres gardent le leur.</p>${applyBar()}`;
  };
  // what Claude used for the scan, counted like a change's
  const used = scan => {
    const u = scan.usage;
    if (!u) return '';
    return `<span class="hint">Claude pour cette analyse : ${num(u.tokens_in + u.tokens_cached)} jetons lus${u.tokens_cached ? ` (dont ${num(u.tokens_cached)} en cache)` : ''}, ${num(u.tokens_out)} écrits · `
      + `${u.credits != null ? `${num(u.credits)} crédits` : 'payé avec votre clé Claude'}</span>`;
  };
  const FIELDS = ['type', 'pagesFile', 'pricesFile', 'collections', 'lang', 'mediaDir', 'mediaPrefix', 'build', 'outDir', 'cacheDirs', 'sharedFiles'];
  const area = (list, cls) => list.length ? `<ul class="areas ${cls}">${list.map(x => `<li><strong class="no-translate">${esc(x.what)}</strong>
      <code class="no-translate">${esc(x.where)}</code><span class="no-translate">${esc(x.detail)}</span></li>`).join('')}</ul>` : '<p class="hint">Rien ici.</p>';
  async function draw() {
    if (!root.isConnected) return;
    const { scan } = await api(`/api/admin/sites/${s.id}/scan`);
    const head = '<h2>Ce que ClaudePress peut changer</h2>';
    const again = (label, primary) => `<button class="btn ${primary ? 'primary' : ''} small" type="button" data-scan>${icon('refresh', 16)} ${label}</button>`;
    // before the first analysis, this card is the next thing to do: it follows the site's first fetch, then the scan, step by step
    const next = !scan || scan.state === 'running' || scan.state === 'failed';
    root.classList.toggle('next-step', next);
    const settings = on => $$('[data-after-scan]', form).forEach(el => { el.hidden = !on; });
    if (scan && scan.state !== 'running') root._html = '';   // views that are not redrawn by paintSteps
    const step = title => `<div class="step-head"><span class="eyebrow">Étape suivante</span><h2>${title}</h2></div>`;
    const leave = '<div class="banner info">Vous pouvez quitter cette page : l’analyse continue sans vous et une notification vous prévient quand elle est prête. Les réglages et le bouton Enregistrer apparaissent ensuite.</div>';
    if (!scan) {
      const site = (await api('/api/admin')).sites?.find(x => x.id === s.id) || s;
      if (site.status === 'setting_up') {
        paintSteps(root, `${step('Analyse du site')}${scanSteps(null)}${leave}`, null);
        settings(false);
        timer = setTimeout(draw, 3000);
      } else if (site.status === 'error') {
        settings(true);
        root._html = '';
        root.innerHTML = `${step('Corriger la connexion')}<div class="banner bad">ClaudePress n’a pas pu récupérer le site : <span class="no-translate">${esc(site.error || '')}</span></div>
          <span class="hint">Vérifiez le dépôt et la branche ci-dessous, puis enregistrez. L’analyse se lance ensuite.</span><div class="stack" data-policy></div>`;
        policyEditor($('[data-policy]', root), s);
      } else {   // a site connected before the scan was automatic: every site gets one, so it starts now
        try { await api(`/api/admin/sites/${s.id}/scan`, { lang: document.documentElement.lang }); } catch (e) { toast(e.message); return; }
        return draw();
      }
    } else if (scan.state === 'running') {
      paintSteps(root, `${step('Analyse du site')}${scanSteps(scan)}${leave}`, scan);
      settings(false);
      timer = setTimeout(draw, 2000);
    } else if (scan.state === 'failed') {
      settings(true);
      root.innerHTML = `${step('Analyser le site')}<div class="banner bad">L’analyse n’a pas abouti : <span class="no-translate">${esc(scan.error)}</span></div>${used(scan)}<div>${again('Réessayer', true)}</div><div class="stack" data-policy></div>`;
      policyEditor($('[data-policy]', root), s);
    }
    else {
      settings(true);
      const r = scan.result, st = r.settings;
      // the site's permissions as they are now: the scan may just have applied its own
      const policy = s.policy = (await api('/api/admin')).sites?.find(x => x.id === s.id)?.policy || s.policy || { pages: {} };
      const cur = Object.fromEntries(FIELDS.map(k => [k, (form.elements[k]?.value || '').trim()]));
      const diff = st ? FIELDS.filter(k => (st[k] || '').trim() !== cur[k]) : [];
      const guideDiffers = r.guide && r.guide.trim() !== (form.elements.guide.value || '').trim();
      const panels = {
        who: kindsPanel(r, policy),
        pages: pagesPanel(r, policy),
        content: `<h3><span class="status ready"><i></i></span>Modifiable par vos clients</h3>${area(r.editable, 'ok')}
          <h3><span class="status building"><i></i></span>Commun à plusieurs pages</h3>${area(r.shared, 'shared')}
          <h3><span class="status"><i></i></span>Réservé à l’agence</h3>${area(r.locked, 'locked')}`,
        tech: `${r.red_flags?.length ? `<h3>Points d’attention</h3><ul class="flags">${r.red_flags.map(f => `<li class="${f.severity}"><span class="sev">${SEVERITY[f.severity] || f.severity}</span>
            <span><strong class="no-translate">${esc(f.what)}</strong> <code class="no-translate">${esc(f.where)}</code><span class="hint no-translate">${esc(f.fix)}</span></span></li>`).join('')}</ul>` : ''}
          <p class="no-translate">${esc(r.framework)}</p>
          ${(r.checks || []).length ? `<ul class="checks">${r.checks.map(c => `<li class="${c.ok ? 'ok' : 'bad'}"><span>${c.ok ? '✓' : '✗'}</span><span class="no-translate">${esc(c.text)}</span></li>`).join('')}</ul>` : ''}
          ${diff.length || guideDiffers ? `<div class="banner info stack" style="gap:8px">
            <div><strong>Réglages proposés</strong> <span class="hint">différents de ceux enregistrés</span></div>
            <ul class="checks">${diff.map(k => `<li><span>→</span><span class="no-translate"><code>${k}</code> ${esc(cur[k] || '—')} → <strong>${esc(st[k] || '—')}</strong></span></li>`).join('')}
              ${guideDiffers ? '<li><span>→</span><span>Notes pour l’IA</span></li>' : ''}</ul>
            <div><button class="btn primary small" type="button" data-apply>Utiliser les réglages proposés</button></div></div>` : '<p class="hint">Les réglages enregistrés sont ceux que l’analyse propose.</p>'}`,
      };
      const badge = { pages: r.site_map?.length ? `<b class="count no-translate">${r.site_map.length}</b>` : '',
        tech: (r.red_flags || []).length ? `<b class="count no-translate">${r.red_flags.length}</b>` : diff.length || guideDiffers ? '<span class="status building"><i></i></span>' : '' };
      // a scan from before the plain note (no developer steps of its own) explained itself in technical terms:
      // the administrator reads a plain sentence, and the old text goes to the developer, as do its steps
      const older = !r.supported && r.convert === undefined;
      const steps = older ? [r.summary, r.why].filter(Boolean).join('\n\n') : r.supported ? r.improve : r.convert;
      // the developer's part, ready for Claude Code: what makes the site (more) editable, never its design
      const prompt = steps ? claudeCodePrompt(s, r, steps) : '';
      const forDev = prompt ? `<details class="convert"><summary>Le prompt pour Claude Code</summary>
          <p class="hint">À coller dans Claude Code, dans le dépôt du site. Le prompt interdit de toucher au design : le site est construit avant et après chaque étape, et les deux versions doivent être identiques.</p>
          <pre class="no-translate">${esc(prompt)}</pre>
          <button class="btn small" type="button" data-copy-convert>Copier le prompt</button></details>` : '';
      const flags = r.red_flags || [], high = flags.filter(f => f.severity === 'high');
      root.innerHTML = `${head}
        ${older ? '' : `<p class="no-translate">${esc(r.summary)}</p>`}
        ${r.supported ? '' : `<div class="banner stack" style="gap:8px"><div><strong>Pas encore modifiable par vos clients.</strong>
            ${older ? '<span>Les pages de ce site sont dans un format que ClaudePress ne sait pas encore modifier. Votre développeur peut les convertir une fois ; ensuite, vos clients changent eux-mêmes textes et photos.</span>'
              : `<span class="no-translate">${esc(r.why)}</span>`}</div>
          ${forDev}
          ${older ? `<div class="hint">Cette analyse date d’avant les explications simplifiées. ${again('Analyser à nouveau')}</div>` : ''}</div>`}
        ${r.supported && r.improve ? `<div class="banner info stack" style="gap:8px"><div><strong>Vos clients pourraient modifier davantage.</strong>
            <span>Votre développeur peut préparer le site une fois, sans toucher au design : plus de textes et de photos deviennent alors modifiables par vos clients.</span></div>${forDev}</div>` : ''}
        ${high.length ? `<div class="banner bad"><strong><span class="no-translate">${high.length}</span> point(s) d’attention important(s)</strong> · <a href="#" data-goto-flags>voir l’onglet Technique</a></div>` : ''}
        <div class="seg scan-tabs" role="tablist">${Object.keys(TABS).map(k => `<button type="button" role="tab" data-stab="${k}" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}"><span>${TABS[k]}</span>${badge[k] || ''}</button>`).join('')}</div>
        ${Object.keys(TABS).map(k => `<div class="stack scan-panel" role="tabpanel" data-panel="${k}" ${tab === k ? '' : 'hidden'}>${panels[k]}</div>`).join('')}
        <div class="scan-foot"><span class="stack" style="gap:2px"><span class="hint">Analysé ${when(scan.at)} · version <span class="no-translate">${esc(scan.sha)}</span></span>${used(scan)}</span>${again('Analyser à nouveau')}</div>`;
      $('[data-goto-flags]', root)?.addEventListener('click', e => { e.preventDefault(); $('[data-stab="tech"]', root).click(); });
      $$('[data-stab]', root).forEach(b => b.addEventListener('click', () => {
        tab = b.dataset.stab;
        $$('[data-stab]', root).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
        $$('[data-panel]', root).forEach(x => { x.hidden = x.dataset.panel !== tab; });
      }));
      // what the picks would change: kinds against the site's, pages against what applies to them now
      const picks = () => {
        const kinds = Object.fromEntries($$('[data-pk]', root).map(x => [x.dataset.pk, picked(x)]));
        // a page that follows "texts and photos" needs no permission of its own
        const pages = Object.fromEntries($$('[data-map]', root).map(x => [r.site_map[x.dataset.map].page, picked(x) === kinds.content ? null : picked(x)]));
        return { kinds, pages };
      };
      const sync = () => {
        const { kinds, pages } = picks();
        const content = kinds.content || policy.content;
        const dirty = Object.keys(kinds).some(k => kinds[k] !== policy[k])
          || Object.entries(pages).some(([u, v]) => (v || content) !== (policy.pages[u] || policy.content));
        $$('[data-pk], [data-map]', root).forEach(g => {
          const hint = g.dataset.pk ? $(`[data-prop-kind="${g.dataset.pk}"]`, root) : $(`[data-prop-map="${g.dataset.map}"]`, root);
          if (hint) hint.hidden = picked(g) === g.dataset.proposal;
        });
        const asProposed = $$('[data-pk], [data-map]', root).every(g => picked(g) === g.dataset.proposal);
        $$('[data-use-proposal]', root).forEach(b => { b.hidden = asProposed; });
        $$('[data-apply-perms]', root).forEach(b => { b.disabled = !dirty; });
        $$('[data-dirty]', root).forEach(x => { x.hidden = !dirty; });
        $$('[data-clean]', root).forEach(x => { x.hidden = dirty; });
        $$('[data-auto]', root).forEach(x => { x.hidden = dirty; });
      };
      $$('[data-pk], [data-map]', root).forEach(g => g.addEventListener('change', sync));
      $$('[data-use-proposal]', root).forEach(b => b.addEventListener('click', () => {
        $$('[data-pk], [data-map]', root).forEach(g => { const x = $(`input[value="${g.dataset.proposal}"]`, g); if (x) x.checked = true; });
        sync();
      }));
      sync();
      $('[data-copy-convert]', root)?.addEventListener('click', () => navigator.clipboard.writeText(prompt).then(() => toast('Prompt copié.'), () => toast('Copie impossible.')));
      $$('[data-apply-perms]', root).forEach(b => b.addEventListener('click', async () => {
        try { s.policy = await api(`/api/admin/sites/${s.id}/policy`, picks()); toast('Permissions appliquées à ce site.'); draw(); } catch (e) { toast(e.message); }
      }));
      $('[data-apply]', root)?.addEventListener('click', () => {
        for (const k of diff) form.elements[k].value = st[k] || '';
        form.elements.type.dispatchEvent(new Event('change'));
        if (guideDiffers) form.elements.guide.value = r.guide;
        $('#advanced', form).open = true;
        toast('Réglages proposés remplis : vérifiez-les, puis enregistrez.', 5000);
        $('[type=submit]', form).scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
    $$('[data-scan]', root).forEach(b => b.addEventListener('click', async () => {
      try { await api(`/api/admin/sites/${s.id}/scan`, { lang: document.documentElement.lang }); draw(); } catch (e) { toast(e.message); }
    }));
  }
  draw();
}

/** White label: the account's name, colour and logo replace ClaudePress's for its people, on plans that include it. */
function brandSection(a) {
  const with_ = a.plans.filter(p => p.whiteLabel).map(p => p.name);
  if (!a.whiteLabel) return with_.length ? `<section class="card stack">
      <p class="muted">Montrez à vos clients votre nom, votre logo et votre couleur au lieu de ClaudePress. Comprise dans ${with_.length > 1 ? 'les formules' : 'la formule'} ${with_.map(esc).join(' et ')}.</p><div>${upgradeBtn(planWith(a, p => p.whiteLabel), 'btn primary')}</div></section>` : '';
  const b = a.brand, color = b.color || '#ea580c';
  return `<section class="card stack" id="brand">
    <p class="muted">Vos clients voient votre nom, votre logo et votre couleur au lieu de ClaudePress : barre du haut, onglet du navigateur, écrans de connexion et d’invitation.</p>
    <form id="brandform" class="stack">
      <label class="field"><span>Nom affiché <em>facultatif · sinon le nom du compte</em></span><input class="input" name="name" maxlength="40" value="${esc(b.name)}" placeholder="${esc(a.name)}"></label>
      <div class="field"><span>Couleur principale <em>boutons, liens, accents</em></span>
        <div class="brand-color"><input type="color" name="color" value="${esc(color)}" aria-label="Couleur"><input class="input" name="hex" value="${esc(b.color)}" placeholder="#ea580c" maxlength="7" spellcheck="false" aria-label="Code couleur">
          ${b.color ? '<button class="btn ghost small" type="button" id="brandreset">Couleur d’origine</button>' : ''}</div></div>
      <div class="field"><span>Logo <em>PNG, JPEG ou WebP, fond transparent de préférence</em></span>
        <div class="brand-logo">${b.logo ? `<img src="${esc(b.logo)}" alt="Logo">` : '<span class="muted small">Aucun logo : votre nom s’affiche à la place.</span>'}
          <label class="btn small">${b.logo ? 'Changer' : 'Choisir une image'}<input type="file" id="logofile" accept="image/png,image/jpeg,image/webp" hidden></label>
          ${b.logo ? '<button class="btn ghost danger small" type="button" id="rmlogo">Retirer</button>' : ''}</div></div>
      <div class="field"><span>Icône de l’onglet <em>carrée, 192 px ou plus</em></span>
        <div class="brand-logo">${b.icon ? `<img class="icon" src="${esc(b.icon)}" alt="Icône">` : '<span class="muted small">Aucune icône : l’onglet du navigateur montre votre logo s’il est carré, sinon votre initiale.</span>'}
          <label class="btn small">${b.icon ? 'Changer' : 'Choisir une image'}<input type="file" id="iconfile" accept="image/png,image/jpeg,image/webp" hidden></label>
          ${b.icon ? '<button class="btn ghost danger small" type="button" id="rmicon">Retirer</button>' : ''}</div></div>
      <label class="toggle"><input type="checkbox" name="mascot" ${b.mascot ? 'checked' : ''}>Montrer Nini, la mascotte de ClaudePress</label>
      <div><button class="btn primary">Enregistrer</button></div>
    </form>
  </section>`;
}

function wireBrand(a) {
  const form = $('#brandform');
  if (!form) return;
  const picker = $('[name=color]', form), hex = $('[name=hex]', form);
  // the colour shows on this screen as it is chosen; it is kept only once saved
  picker.addEventListener('input', () => { hex.value = picker.value; applyAccent(picker.value); });
  hex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) { picker.value = hex.value; applyAccent(hex.value); } });
  const saved = async () => { me = await api('/api/me'); applyBrand(me.brand); admin('brand'); };
  $('#brandreset')?.addEventListener('click', async () => { try { await api('/api/admin/account/brand', { color: '' }); toast('Couleur d’origine rétablie.'); await saved(); } catch (err) { toast(err.message); } });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = new FormData(form), color = String(v.get('hex')).trim();
    try {
      await api('/api/admin/account/brand', { name: v.get('name'), color: color && !color.startsWith('#') ? `#${color}` : color, mascot: v.get('mascot') === 'on' });
      toast('Enregistré.'); await saved();
    } catch (err) { toast(err.message); }
  });
  // the logo and the tab icon: an image sent as it is, or removed
  for (const [kind, done, ask] of [['logo', 'Logo enregistré.', 'Retirer le logo ?'], ['icon', 'Icône enregistrée.', 'Retirer l’icône ?']]) {
    $(`#${kind}file`).addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const r = await fetch(`/api/admin/account/brand/${kind}`, { method: 'POST', headers: { 'content-type': file.type }, body: file });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Erreur ${r.status}`);
        toast(done); await saved();
      } catch (err) { toast(err.message); }
    });
    $(`#rm${kind}`)?.addEventListener('click', async () => {
      if (!confirm(ask)) return;
      try { await api(`/api/admin/account/brand/${kind}`, {}); await saved(); } catch (err) { toast(err.message); }
    });
  }
}

/**
 * What the account uses against what its plan gives: AI credits this month, sites, clients per site, with the way to get
 * more right there (a credit pack, a larger plan), and the credits of the last six months.
 */
function usageDashboard(a) {
  const cur = a.plans.find(p => p.id === a.plan), ai = a.ai, c = ai.credits || {};
  const lang = document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE';
  const reset = new Date(); reset.setMonth(reset.getMonth() + 1, 1);
  const gauge = pct => `<div class="gauge ${pct >= 100 ? 'full' : pct >= 80 ? 'high' : ''}"><div style="width:${Math.min(100, Math.max(pct, 2))}%"></div></div>`;
  const meter = (label, value, pct, note) => `<div class="meter"><span class="muted small">${label}</span><strong>${value}</strong>${pct == null ? '' : gauge(pct)}<span class="hint">${note}</span></div>`;
  const creditPct = ai.mode === 'included' && ai.credit ? 100 * ai.used / ai.credit : null;
  const credits = ai.mode === 'own_key' ? meter('Crédits IA ce mois-ci', 'Votre clé Claude', null, 'Payé à Anthropic directement, sans limite.')
    : ai.mode === 'included' && ai.credit === null ? meter('Crédits IA ce mois-ci', 'Illimités', null, 'IA incluse sur ce serveur.')
    : ai.mode === 'included' && ai.credit ? meter('Crédits IA ce mois-ci', `${num(c.used)} / ${num(c.total)}`, creditPct,
        `Remis à zéro le ${lang === 'en-GB' ? reset.toLocaleDateString(lang, { day: 'numeric', month: 'long' }) : `1er ${reset.toLocaleDateString(lang, { month: 'long' })}`}.${c.packs ? ` En réserve : ${num(c.packs)} crédits en packs.` : ''}`)
    : c.packs ? meter('Crédits IA', `${num(c.packs)} en packs`, null, 'Utilisés pour l’IA et les images, sans crédit mensuel.')
    : meter('Crédits IA ce mois-ci', 'Aucun', null, 'Ajoutez votre clé Claude, un pack de crédits, ou une formule avec IA incluse.');
  const sites = meter('Sites', a.sitesLimit ? `${a.sitesUsed} / ${a.sitesLimit}` : a.sitesUsed, a.sitesLimit ? 100 * a.sitesUsed / a.sitesLimit : null,
    a.sitesLimit ? (a.sitesUsed > a.sitesLimit ? `${a.sitesUsed - a.sitesLimit} site(s) en pause : passez à une formule supérieure ou retirez-en.`
      : a.sitesUsed >= a.sitesLimit ? 'Votre formule est complète.' : `Encore ${a.sitesLimit - a.sitesUsed} site(s) possible(s).`) : 'Sites illimités.');
  const per = a.clientsPerSite, total = a.siteClients.reduce((t, s) => t + s.clients, 0);
  const full = per ? a.siteClients.filter(s => s.clients >= per) : [], over = per ? a.siteClients.filter(s => s.clients > per) : [];
  const clients = meter('Clients', per ? `${per} par site` : total, per && a.siteClients.length ? 100 * full.length / a.siteClients.length : null,
    !per ? 'Clients illimités sur chaque site. Les administrateurs ne comptent pas.'
      : `${full.length} site(s) sur ${a.siteClients.length} ont leur client. Les administrateurs ne comptent pas.`);
  const upTeam = adminsFull(a);
  // no gauge: a full team of one is the normal state on the smaller plans, not a warning
  const team = meter('Équipe', a.adminsLimit ? `${a.adminsUsed} / ${a.adminsLimit}` : a.adminsUsed, null,
    !a.adminsLimit ? 'Administrateurs illimités.' : upTeam ? (upTeam.name ? `Passez à ${upTeam.name} pour inviter votre équipe.` : 'Votre formule est complète.')
      : `Encore ${a.adminsLimit - a.adminsUsed} administrateur(s) possible(s).`);
  // the next plan up that lifts what is running out
  const tight = { credits: creditPct >= 80, sites: a.sitesLimit && a.sitesUsed >= a.sitesLimit, clients: !!full.length };
  const order = a.plans.findIndex(p => p.id === a.plan);
  const next = a.plans.slice(order + 1).find(p => (tight.sites && (p.sites === null || p.sites > a.sitesLimit)) || (tight.clients && (p.clients === null || p.clients > per))
    || (tight.credits && p.included && (p.included.credits === null || p.included.credits > (c.total || 0)))) || null;
  const max = Math.max(1, ...a.history.map(h => h.credits));
  const history = a.history.some(h => h.credits) ? `<div class="history">${a.history.map(h => {
    const m = new Date(`${h.month}-15`).toLocaleDateString(lang, { month: 'short' });
    return `<div title="${num(h.credits)}"><span class="small">${num(h.credits)}</span><i style="height:${Math.round(70 * h.credits / max) + 2}px"></i><span class="muted small">${m}</span></div>`;
  }).join('')}</div>` : '';
  return `<section class="card stack" id="usage">
    <div class="side-head"><div><h2>Votre formule${a.plans.length > 1 ? ` : ${esc(cur.name)}` : ''}</h2>
        ${a.plans.length > 1 ? `<div class="muted small">${a.aiIncluded ? 'Avec IA incluse' : cur.byok || cur.included ? 'Avec votre propre clé Claude' : 'Gratuite, avec votre propre clé Claude'}</div>` : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn small" href="#/admin/usage">Détail de l’utilisation</a>
        ${extHtml('usage.actions', a, next)}</div></div>
    ${next ? `<div class="banner info small">${[tight.credits && 'les crédits IA du mois', tight.sites && 'les sites', tight.clients && 'les clients'].filter(Boolean).join(', ').replace(/, ([^,]+)$/, ' et $1').replace(/^./, x => x.toUpperCase())} arrivent au bout de votre formule. La formule ${esc(next.name)} vous donne ${[
        tight.sites && (next.sites ? `${next.sites} sites` : 'des sites illimités'), tight.clients && (next.clients ? `${next.clients} clients par site` : 'des clients illimités'),
        tight.credits && next.included && `${num(next.included.credits)} crédits par mois`].filter(Boolean).join(', ')}.</div>` : ''}
    <div class="meters">${credits}${sites}${clients}${team}</div>
    ${over.length ? `<p class="small">Au-delà de votre formule : ${over.map(s => `<strong class="no-translate">${esc(s.name)}</strong> (${s.clients} clients)`).join(', ')}. Ces personnes gardent leur accès ; pour en inviter d’autres sur ces sites, retirez-en ou changez de formule.</p>` : ''}
    ${history ? `<div><span class="muted small">Crédits IA utilisés, 6 derniers mois</span>${history}</div>` : ''}
  </section>`;
}

const euro = n => `${Number.isInteger(n) ? n : n.toFixed(2).replace('.', ',')} €`;
const longDay = iso => new Date(iso).toLocaleDateString(document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE', { day: 'numeric', month: 'long', year: 'numeric' });

const USE_KIND = { edit: 'Modification', post: 'Article de blog', page_request: 'Demande de page', scan: 'Analyse du site' };

/**
 * Credits and usage, for the account's administrators: the subscription and who pays Claude and fal.ai, then a month of
 * use, totalled by service, by site and by kind, every charge listed, and the prices the credits come from.
 */
async function usageTab(pane, d, month) {
  const a = d.account, ai = a.ai, c = ai.credits || {}, cur = a.plans.find(p => p.id === a.plan);
  const u = await api(`/api/admin/usage${month ? `?month=${month}` : ''}`);
  const lang = document.documentElement.lang === 'en' ? 'en-GB' : 'fr-BE';
  const money = (n, currency) => `<span class="no-translate">${Number(n || 0).toLocaleString(lang, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: n && n < 0.1 ? 4 : 2 })}</span>`;
  const sum = (list, k) => list.reduce((t, e) => t + (e[k] || 0), 0);
  const monthName = m => new Date(`${m}-15`).toLocaleDateString(lang, { month: 'long', year: 'numeric' });
  const E = u.entries, P = u.prices;
  const reset = new Date(); reset.setMonth(reset.getMonth() + 1, 1);

  // who pays each service
  const claudeWho = ai.mode === 'own_key' ? `<strong>Votre clé Claude</strong> <span class="no-translate">…${esc(ai.keyLast4)}</span><span class="hint">Anthropic vous facture directement.</span>`
    : ai.mode === 'included' && ai.credit === null ? '<strong>La clé Claude de ce serveur</strong><span class="hint">IA incluse sur ce serveur.</span>'
    : ai.mode === 'included' ? '<strong>Vos crédits IA</strong><span class="hint">Compris dans votre formule.</span>'
    : '<strong>Pas encore activé</strong><span class="hint">Choisissez une formule avec IA incluse ou ajoutez votre clé Claude.</span>';
  const falWho = ai.falKeyLast4 ? `<strong>Votre clé fal.ai</strong> <span class="no-translate">…${esc(ai.falKeyLast4)}</span><span class="hint">fal.ai vous facture directement.</span>`
    : ai.falServer && (ai.mode === 'included' || c.packs || ai.mode === 'own_key') ? '<strong>Vos crédits IA</strong><span class="hint">Chaque image ou vidéo est décomptée de vos crédits.</span>'
    : '<strong>Non disponible</strong><span class="hint">Ajoutez votre clé fal.ai pour créer des images et des vidéos.</span>';
  const creditLine = ai.mode === 'included' && ai.credit ? `<strong class="no-translate">${num(c.used)} / ${num(c.total)}</strong>
      <div class="gauge ${c.used >= c.total ? 'full' : c.used >= 0.8 * c.total ? 'high' : ''}"><div style="width:${Math.min(100, Math.max(2, 100 * c.used / c.total))}%"></div></div>
      <span class="hint">Remis à zéro le <span class="no-translate">${reset.toLocaleDateString(lang, { day: 'numeric', month: 'long' })}</span>.</span>`
    : ai.mode === 'included' && ai.credit === null ? '<strong>Illimités</strong><span class="hint">IA incluse sur ce serveur.</span>'
    : '<strong>Pas de crédit mensuel</strong><span class="hint">Votre formule n’inclut pas d’IA.</span>';

  // the month in figures
  const claudeCredits = sum(E, 'claudeCredits'), mediaCredits = sum(E, 'mediaCredits'), credits = sum(E, 'credits');
  const ownClaude = E.filter(e => e.claudePaidBy === 'own_key'), ownMedia = E.filter(e => e.mediaPaidBy === 'own_key');
  const read = sum(E, 'tokensIn') + sum(E, 'tokensCached'), written = sum(E, 'tokensOut');
  const images = sum(E, 'images'), seconds = sum(E, 'videoSeconds');
  const total = (list, k) => `<span class="no-translate">${num(sum(list, k))}</span>`;
  const group = key => Object.values(E.reduce((m, e) => { const k = e[key] || '—'; (m[k] ??= { name: k, list: [] }).list.push(e); return m; }, {}));
  const bySite = group('site').sort((x, y) => sum(y.list, 'credits') - sum(x.list, 'credits'));
  const byKind = group('kind').sort((x, y) => sum(y.list, 'credits') - sum(x.list, 'credits'));
  const row = (label, list) => `<tr><td>${label}</td><td class="num">${list.length}</td><td class="num">${total(list, 'claudeCredits')}</td><td class="num">${total(list, 'mediaCredits')}</td><td class="num"><strong>${total(list, 'credits')}</strong></td></tr>`;
  const head = first => `<thead><tr><th>${first}</th><th class="num">Utilisations</th><th class="num">Crédits Claude</th><th class="num">Crédits fal.ai</th><th class="num">Total</th></tr></thead>`;
  const when = iso => new Date(iso).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const SHOWN = 40;
  const line = (e, i) => `<tr ${i >= SHOWN ? 'hidden data-more' : ''}>
      <td class="no-translate nowrap">${when(e.at)}</td>
      <td><div>${USE_KIND[e.kind] || esc(e.kind)}${e.change ? ` · <a class="no-translate" href="#/change/${e.change.id}">${esc(e.change.title || '…')}</a>` : ''}</div>
        <div class="hint"><span class="no-translate">${esc(e.site || '')}</span>${e.who ? ` · <span class="no-translate">${esc(e.who)}</span>` : ''}</div></td>
      <td><span class="no-translate">${num(e.tokensIn + e.tokensCached)}</span> / <span class="no-translate">${num(e.tokensOut)}</span>
        <div class="hint">${e.claudePaidBy === 'own_key' ? `Votre clé · ${money(e.claudeUsd, 'USD')}` : `<span class="no-translate">${num(e.claudeCredits)}</span> crédits`}</div></td>
      <td>${e.images || e.videoSeconds ? `${e.images ? `<span class="no-translate">${e.images}</span> image(s)` : ''}${e.images && e.videoSeconds ? ' · ' : ''}${e.videoSeconds ? `<span class="no-translate">${e.videoSeconds}</span> s de vidéo` : ''}
        <div class="hint">${e.mediaPaidBy === 'own_key' ? 'Votre clé fal.ai' : `<span class="no-translate">${num(e.mediaCredits)}</span> crédits`}</div>` : '<span class="muted">—</span>'}</td>
      <td class="num"><strong class="no-translate">${num(e.credits)}</strong></td></tr>`;

  const months = u.history.map(h => h.month);
  pane.innerHTML = `<div class="stack usage-page">
    <section class="card stack">
      <div class="side-head"><div><h2>Votre abonnement</h2>
          <div class="muted small">${a.plans.length > 1 ? `Formule <strong class="no-translate" style="color:var(--ink)">${esc(cur.name)}</strong> · ` : ''}${a.aiIncluded ? 'IA incluse' : 'Avec votre propre clé Claude'}${extHtml('usage.renewal', a)}</div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${extHtml('usage.buttons', a)}</div></div>
      <div class="meters">
        <div class="meter"><span class="muted small">Crédits IA ce mois-ci</span>${creditLine}${c.packs ? `<span class="hint">En réserve : <span class="no-translate">${num(c.packs)}</span> crédits en packs, valables jusqu’au <span class="no-translate">${longDay(ai.packsUntil)}</span>.</span>` : ''}</div>
        <div class="meter"><span class="muted small">Claude · textes, articles, analyses</span>${claudeWho}</div>
        <div class="meter"><span class="muted small">fal.ai · images et vidéos</span>${falWho}</div>
      </div>
      <p class="hint">Les clés se gèrent dans <a href="#/admin/keys">Clés IA (BYOK)</a>.</p>
    </section>

    <section class="card stack">
      <div class="side-head"><h2>Utilisation de <span class="no-translate">${monthName(u.month)}</span></h2>
        <div class="seg mini">${months.map(m => `<button type="button" data-month="${m}" class="${m === u.month ? 'on' : ''}"><span class="no-translate">${new Date(`${m}-15`).toLocaleDateString(lang, { month: 'short' })}</span></button>`).join('')}</div></div>
      ${u.since && u.month < u.since.slice(0, 7) ? `<div class="banner info small">Le détail de chaque utilisation est enregistré depuis le <span class="no-translate">${longDay(u.since)}</span>. Pour ce mois, seul le total est connu : <strong><span class="no-translate">${num(u.history.find(h => h.month === u.month)?.credits || 0)}</span> crédits</strong></div>` : ''}
      <div class="meters">
        <div class="meter"><span class="muted small">Total</span><strong><span class="no-translate">${num(credits)}</span> crédits</strong><span class="hint"><span class="no-translate">${E.length}</span> utilisation(s) de l’IA</span></div>
        <div class="meter"><span class="muted small">Claude</span><strong><span class="no-translate">${num(claudeCredits)}</span> crédits</strong>
          <span class="hint"><span class="no-translate">${num(read)}</span> jetons lus, <span class="no-translate">${num(written)}</span> écrits</span>
          ${ownClaude.length ? `<span class="hint">Avec votre clé : ${money(sum(ownClaude, 'claudeUsd'), 'USD')} au prix catalogue, facturés par Anthropic</span>` : ''}</div>
        <div class="meter"><span class="muted small">fal.ai</span><strong><span class="no-translate">${num(mediaCredits)}</span> crédits</strong>
          <span class="hint"><span class="no-translate">${images}</span> image(s), <span class="no-translate">${seconds}</span> s de vidéo</span>
          ${ownMedia.length ? '<span class="hint">Avec votre clé fal.ai : facturé par fal.ai</span>' : ''}</div>
      </div>
      ${E.length ? `<div class="table-scroll"><table>${head('Site')}<tbody>${bySite.map(g => row(`<span class="no-translate">${esc(g.name)}</span>`, g.list)).join('')}</tbody></table></div>
        <div class="table-scroll"><table>${head('Type')}<tbody>${byKind.map(g => row(USE_KIND[g.name] || esc(g.name), g.list)).join('')}</tbody></table></div>
        <h3>Chaque utilisation</h3>
        <div class="table-scroll"><table class="usage-log"><thead><tr><th>Date</th><th>Quoi</th><th>Claude · jetons lus / écrits</th><th>fal.ai</th><th class="num">Crédits</th></tr></thead>
          <tbody>${E.map(line).join('')}</tbody></table></div>
        ${E.length > SHOWN ? '<div><button class="btn small" type="button" data-all>Tout afficher</button></div>' : ''}`
      : '<p class="hint">Aucune utilisation de l’IA ce mois-ci.</p>'}
    </section>

    <section class="card stack">
      <h2>Comment les crédits sont calculés</h2>
      <p>1 crédit = <span class="no-translate">0,001 €</span>. Chaque utilisation est décomptée au prix catalogue du service, sans marge, converti à <span class="no-translate">1 $ = ${String(P.eurPerUsd).replace('.', ',')} €</span>.</p>
      <div class="table-scroll"><table><thead><tr><th>Service</th><th>Prix catalogue</th><th class="num">En crédits</th></tr></thead><tbody>
        <tr><td>Claude · jetons lus</td><td>${money(P.claude.in, 'USD')} par million</td><td class="num no-translate">${num(Math.round(P.claude.in * P.eurPerUsd * P.creditsPerEur))}</td></tr>
        <tr><td>Claude · jetons lus en cache</td><td>${money(P.claude.cacheRead, 'USD')} par million</td><td class="num no-translate">${num(Math.round(P.claude.cacheRead * P.eurPerUsd * P.creditsPerEur))}</td></tr>
        <tr><td>Claude · jetons mis en cache</td><td>${money(P.claude.cacheWrite, 'USD')} par million</td><td class="num no-translate">${num(Math.round(P.claude.cacheWrite * P.eurPerUsd * P.creditsPerEur))}</td></tr>
        <tr><td>Claude · jetons écrits</td><td>${money(P.claude.out, 'USD')} par million</td><td class="num no-translate">${num(Math.round(P.claude.out * P.eurPerUsd * P.creditsPerEur))}</td></tr>
        <tr><td>fal.ai · une image</td><td>${money(P.fal.image, 'USD')}</td><td class="num no-translate">${num(Math.round(P.fal.image * P.eurPerUsd * P.creditsPerEur))}</td></tr>
        <tr><td>fal.ai · une seconde de vidéo</td><td>${money(P.fal.videoSecond, 'USD')}</td><td class="num no-translate">${num(Math.round(P.fal.videoSecond * P.eurPerUsd * P.creditsPerEur))}</td></tr>
      </tbody></table></div>
      <p class="hint">Avec vos propres clés, Anthropic et fal.ai vous facturent directement et aucun crédit n’est utilisé ; les montants affichés ici sont une estimation au prix catalogue, leur facture fait foi.</p>
    </section>
  </div>`;
  $$('[data-month]', pane).forEach(b => b.addEventListener('click', () => usageTab(pane, d, b.dataset.month)));
  $('[data-all]', pane)?.addEventListener('click', e => { $$('[data-more]', pane).forEach(r => { r.hidden = false; }); e.target.remove(); });
}

/** The account's settings, one page each: `view` is 'account' (plan, billing, credits), 'keys' (BYOK) or 'brand' (white label). */
function accountTab(pane, d, view = 'account') {
  const a = d.account;
  const cur = a.plans.find(p => p.id === a.plan);
  const pct = a.ai.credit ? Math.min(100, Math.round(100 * a.ai.used / a.ai.credit)) : 0;
  const day = longDay;
  const aiText = a.ai.keyRefused ? '' : a.ai.mode === 'own_key' ? `Votre clé Claude (…${esc(a.ai.keyLast4)}) est utilisée : vous payez Anthropic directement, sans limite de crédit.`
    : a.ai.mode === 'included' && a.ai.credit === null ? 'IA incluse : la clé Claude de ce serveur est utilisée, sans limite de crédit.'
    : a.ai.mode === 'included' ? `IA incluse : ${num(a.ai.credits.used)} crédits utilisés sur ${num(a.ai.credits.total)} ce mois-ci.`
    : 'Pas d’IA pour l’instant : ajoutez votre clé Claude ci-dessous, ou choisissez une formule avec IA incluse.';
  pane.innerHTML = view === 'brand' ? `<div class="stack">${brandSection(a)}</div>` : view === 'keys' ? `<div class="stack">
    <p class="muted">Avec vos propres clés (BYOK), l’assistant utilise votre compte Claude, et votre compte fal.ai pour les images et vidéos : ils vous facturent directement.
      La clé Claude suffit pour commencer. <a href="https://claudepress.org/help/byok" target="_blank" rel="noopener">Le guide BYOK</a> montre où les créer.</p>
    <section class="card stack"><h2>Assistant IA</h2>
      ${aiText ? `<p>${aiText}</p>` : ''}
      ${a.ai.keyRefused ? `<div class="banner">Anthropic refuse votre clé Claude (…${esc(a.ai.keyLast4)}) : elle a sans doute été révoquée. L’assistant est en pause : collez une nouvelle clé ci-dessous.</div>` : ''}
      ${a.ai.falKeyRefused ? `<div class="banner">fal.ai refuse votre clé fal.ai (…${esc(a.ai.falKeyLast4)}) : elle a sans doute été révoquée. Les images et vidéos sont en pause : collez une nouvelle clé ci-dessous.</div>` : ''}
      ${a.aiIncluded && a.ai.keyLast4 ? '<div class="banner">Votre clé Claude est utilisée à la place des crédits inclus dans votre formule : vous payez donc Anthropic en plus. Retirez-la pour utiliser vos crédits, ou choisissez le prix « Avec ma clé ».</div>' : ''}
      ${a.ai.credits?.packs ? `<p class="small">Packs : <strong>${num(a.ai.credits.packs)} crédits</strong> en réserve, utilisés après le crédit du mois (valables jusqu’au ${day(a.ai.packsUntil)}).</p>` : ''}
      <p class="hint">1 crédit = 0,001 € de Claude au prix catalogue d’Anthropic, sans marge. Une modification utilise en moyenne ${num(a.creditsPerEdit)} crédits ; chaque changement affiche ses jetons et ses crédits.</p>
      ${a.ai.mode === 'included' && a.ai.credit ? `<div style="height:8px;border-radius:99px;background:var(--soft);overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct > 85 ? 'var(--mark)' : 'var(--brand)'}"></div></div>` : ''}
      <form id="key" class="stack" style="gap:8px">
        <label class="field"><span>Votre clé API Claude <em>facultatif · remplace l’IA incluse</em></span>
          <input class="input" name="key" type="password" autocomplete="off" placeholder="${a.ai.keyLast4 ? `sk-ant-…${esc(a.ai.keyLast4)} (enregistrée)` : 'sk-ant-…'}"></label>
        <span class="hint">Créez-la sur console.anthropic.com → API Keys. Elle est chiffrée, jamais réaffichée, et ne sert qu’aux sites de ce compte.</span>
        <span class="hint">Conseil : une clé réservée à ClaudePress, dans un workspace Anthropic avec une limite de dépenses. Si elle fuit, la perte reste limitée et vous la révoquez sans toucher au reste.</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Vérifier et enregistrer</button>
          ${a.ai.keyLast4 ? '<button class="btn ghost danger" type="button" id="rmkey">Retirer ma clé</button>' : ''}</div>
      </form>
      <form id="falkey" class="stack" style="gap:8px">
        <label class="field"><span>Votre clé API fal.ai <em>facultatif · pour les images et vidéos</em></span>
          <input class="input" name="key" type="password" autocomplete="off" placeholder="${a.ai.falKeyLast4 ? `…${esc(a.ai.falKeyLast4)} (enregistrée)` : 'fal.ai'}"></label>
        <span class="hint">${a.ai.falKeyLast4 ? 'Votre clé fal.ai est utilisée : vous payez les images et vidéos à fal.ai directement, sans utiliser vos crédits.'
          : a.ai.falServer ? 'Sans elle, les images et vidéos utilisent vos crédits IA. Avec votre propre clé Claude, ajoutez-la pour en créer sans crédits.'
          : 'Sans elle, l’assistant ne peut pas créer d’images ni de vidéos.'} Créez-la sur fal.ai/dashboard/keys. Elle est chiffrée, jamais réaffichée, et ne sert qu’aux sites de ce compte.</span>
        <span class="hint">Conseil : une clé réservée à ClaudePress, que vous pouvez révoquer seule, et un solde fal.ai prépayé modeste.</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Vérifier et enregistrer</button>
          ${a.ai.falKeyLast4 ? '<button class="btn ghost danger" type="button" id="rmfalkey">Retirer ma clé</button>' : ''}</div>
      </form>
    </section>
    ${a.keyEvents?.length ? `<section class="card stack"><h2>Historique des clés</h2>
      <p class="hint">Chaque administrateur du compte est prévenu quand une clé est ajoutée, remplacée ou retirée, ou quand Anthropic ou fal.ai la refuse.</p>
      <ul class="stack small" style="gap:6px;margin:0;padding-left:18px">${a.keyEvents.map(ev => `<li><span class="muted">${day(ev.at)}</span> · <span>${esc(ev.text)}</span></li>`).join('')}</ul>
    </section>` : ''}
  </div>` : `<div class="stack">
    ${usageDashboard(a)}
    <section class="card stack"><h2>Votre compte</h2>
      <form id="acc" style="display:flex;gap:8px;flex-wrap:wrap"><input class="input" name="name" value="${esc(a.name)}" style="flex:1;min-width:200px" aria-label="Nom du compte"><button class="btn">Renommer</button></form>
      <div class="small muted">${a.plans.length > 1 ? `Formule <strong style="color:var(--ink)">${esc(cur.name)}</strong>${a.aiIncluded ? ' avec IA incluse' : cur.id === 'free' ? '' : ' avec votre propre clé'}
        · ` : ''}${a.sitesLimit ? `${a.sitesUsed} site(s) sur ${a.sitesLimit}` : `${a.sitesUsed} site(s), sans limite`}</div>
      ${extHtml('account.card', a)}
    </section>
    ${extHtml('account.sections', a)}
  </div>`;
  $('#acc')?.addEventListener('submit', async e => { e.preventDefault(); try { await api('/api/admin/account', { name: new FormData(e.target).get('name') }); toast('Enregistré.'); } catch (err) { toast(err.message); } });
  wireBrand(a);
  $('#key')?.addEventListener('submit', async e => {
    e.preventDefault();
    const key = new FormData(e.target).get('key');
    if (!key) return toast('Collez votre clé Claude.');
    const b = $('button.primary', e.target); b.disabled = true; b.textContent = 'Vérification…';
    try { await api('/api/admin/account/key', { key }); toast('Clé vérifiée et enregistrée.'); admin('keys'); }
    catch (err) { toast(err.message); b.disabled = false; b.textContent = 'Vérifier et enregistrer'; }
  });
  $('#rmkey')?.addEventListener('click', async () => { if (!confirm(!a.aiIncluded && cur.byok && !a.ai.credits?.packs ? 'Retirer votre clé Claude ? Avec le prix « Avec ma clé », l’assistant s’arrêtera jusqu’à ce que vous en ajoutiez une.' : 'Retirer votre clé Claude ?')) return; await api('/api/admin/account/key', { key: '' }); admin('keys'); });
  $('#falkey')?.addEventListener('submit', async e => {
    e.preventDefault();
    const key = new FormData(e.target).get('key');
    if (!key) return toast('Collez votre clé fal.ai.');
    const b = $('button.primary', e.target); b.disabled = true; b.textContent = 'Vérification…';
    try { await api('/api/admin/account/fal-key', { key }); toast('Clé vérifiée et enregistrée.'); admin('keys'); }
    catch (err) { toast(err.message); b.disabled = false; b.textContent = 'Vérifier et enregistrer'; }
  });
  $('#rmfalkey')?.addEventListener('click', async () => { if (!confirm('Retirer votre clé fal.ai ?')) return; await api('/api/admin/account/fal-key', { key: '' }); admin('keys'); });
  $$('[data-go]', pane).forEach(b => b.addEventListener('click', () => $(b.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  // from an "Ajouter des crédits" button: straight to the packs, or to the Claude key without online payment
  if (/[?&]plans\b/.test(location.hash)) $('#plans')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (/[?&]credits\b/.test(location.hash)) { if ($('#packs')) $('#packs').scrollIntoView({ behavior: 'smooth', block: 'start' }); else if (view !== 'keys') location.hash = '#/admin/keys'; }
  extRun('account', pane, a);
}

async function signup() {
  const state = await fetch('/api/auth/state').then(r => r.json());
  if (state.firebase) return fbLogin(state, 'signup');
  const form = authPage('Créer votre compte', 'Gratuit pour un site, avec votre propre clé Claude. Passez à une formule supérieure quand vous voulez.',
    field('name', 'Votre nom', 'text', 'autocomplete="name" autofocus') + field('company', 'Agence ou entreprise', 'text', 'autocomplete="organization"') +
    field('email', 'E-mail', 'email', 'autocomplete="username"') + field('password', 'Mot de passe (10 caractères minimum)', 'password', 'autocomplete="new-password" minlength="10"'), 'Créer mon compte', 'signup');
  form.insertAdjacentHTML('beforeend', '<p class="hint">Déjà un compte ? <a href="#/login">Connectez-vous</a>.</p>');
  submitTo(form, async v => { await api('/api/signup', v); track('sign_up', { method: 'password' }); location.hash = '#/admin/sites'; });
}

// ------------------------------------------------------------------ sign-in with Firebase (email + password, Google, GitHub)

const GOOGLE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.5 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2.1v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.7 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8l3.6-2.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.1-3.1A11 11 0 0 0 2.1 7.1l3.6 2.8C6.6 7.3 9.1 5.4 12 5.4z"/></svg>';

const GITHUB_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C17.3 4.8 18.3 5.1 18.3 5.1c.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5z"/></svg>';

/** How the person came in, for the analytics event. */
const method = u => ({ 'google.com': 'google', 'github.com': 'github' })[u.providerData?.[0]?.providerId] || 'email';

/**
 * One screen for every way in: 'login', 'setup' (first administrator), 'signup' (new account), 'invite' (joining from a link).
 * Firebase checks the password or the Google account; the server then opens a ClaudePress session.
 */
function fbLogin(state, kind, inv = null) {
  const cfg = state.firebase;
  const create = kind !== 'login';
  const titles = {
    login: ['Connexion', ''],
    setup: ['Bienvenue dans ClaudePress', 'Créez le compte administrateur : c’est lui qui ajoute les sites et invite les clients.'],
    signup: ['Créer votre compte', 'Gratuit pour un site, avec votre propre clé Claude. Passez à une formule supérieure quand vous voulez.'],
    invite: [`Bienvenue ${esc((inv?.name || '').split(' ')[0])}`, `Vous êtes invité avec l’adresse <strong>${esc(inv?.email || '')}</strong>. Entrez avec Google ou choisissez un mot de passe.`],
  }[kind];
  app.innerHTML = authShell(`
    <div><h1>${titles[0]}</h1>${titles[1] ? `<p class="muted" style="margin-top:6px">${titles[1]}</p>` : ''}</div>
    <button class="btn" id="google" style="width:100%">${GOOGLE_ICON} Continuer avec Google</button>
    ${state.github ? `<button class="btn" id="github" style="width:100%">${GITHUB_ICON} Continuer avec GitHub</button>` : ''}
    <div class="muted small" style="display:flex;align-items:center;gap:10px"><span style="flex:1;height:1px;background:var(--line)"></span>ou avec un e-mail<span style="flex:1;height:1px;background:var(--line)"></span></div>
    <form class="stack" id="auth">
      ${create && kind !== 'invite' ? field('name', 'Votre nom', 'text', 'autocomplete="name"') : ''}
      ${kind === 'setup' || kind === 'signup' ? field('company', 'Agence ou entreprise', 'text', 'autocomplete="organization"') : ''}
      ${kind === 'invite' ? `<input type="email" name="email" value="${esc(inv.email)}" autocomplete="username" hidden>`
        : field('email', 'E-mail', 'email', 'autocomplete="username"')}
      ${field('password', create ? 'Mot de passe (10 caractères minimum)' : 'Mot de passe', 'password', create ? 'autocomplete="new-password" minlength="10"' : 'autocomplete="current-password"')}
      <div class="banner bad" id="err" hidden></div>
      <button class="btn primary" type="submit">${create ? 'Créer mon accès' : 'Se connecter'}</button>
    </form>
    <div class="hint stack" style="gap:6px">
      ${kind === 'login' ? '<a href="#" id="forgot">Mot de passe oublié ?</a>' : ''}
      ${kind === 'login' && state.signup ? '<span>Pas encore de compte ? <a href="#/signup">Créez-le gratuitement</a>.</span>' : ''}
      ${kind === 'signup' ? '<span>Déjà un compte ? <a href="#/login">Connectez-vous</a>.</span>' : ''}
    </div>`, kind);
  const err = m => { $('#err').hidden = !m; $('#err').textContent = m || ''; };
  const extra = () => ({ invite: inv?.token, name: $('[name=name]')?.value || inv?.name, company: $('[name=company]')?.value });

  async function enter(user) {
    try {
      const r = await api('/api/session', { idToken: await user.getIdToken(true), ...extra() });
      track(r.created ? 'sign_up' : 'login', { method: method(user) });
      location.hash = r.created === 'admin' || r.created === 'account' ? '#/admin/sites' : '#/';
    } catch (e) {
      if (e.message === 'EMAIL_NOT_VERIFIED') return verifyScreen(cfg, user, extra());
      err(e.message);
    }
  }

  $('#google').addEventListener('click', async () => {
    err('');
    try { await enter(await withGoogle(cfg)); } catch (e) { err(authMessage(e)); }
  });
  $('#github')?.addEventListener('click', async () => {
    err('');
    try { await enter(await withGitHub(cfg)); } catch (e) { err(authMessage(e)); }
  });
  $('#auth').addEventListener('submit', async e => {
    e.preventDefault();
    err('');
    const v = Object.fromEntries(new FormData(e.target));
    const btn = $('button[type=submit]', e.target); btn.disabled = true;
    try {
      let user;
      if (!create) user = await withPassword(cfg, v.email, v.password);
      else {
        try { user = await createWithPassword(cfg, v.email, v.password, v.name); }
        catch (x) {
          // already known to Firebase (e.g. invited by a second agency): sign in instead
          if (x.code === 'auth/email-already-in-use') user = await withPassword(cfg, v.email, v.password);
          else throw x;
        }
      }
      await enter(user);
    } catch (x) { err(authMessage(x)); }
    btn.disabled = false;
  });
  $('#forgot')?.addEventListener('click', async e => {
    e.preventDefault();
    const email = $('[name=email]').value.trim();
    if (!email) return err('Indiquez votre e-mail, puis cliquez à nouveau sur « Mot de passe oublié ».');
    try { await resetPassword(cfg, email); err(''); toast('Si un compte existe, un e-mail pour choisir un nouveau mot de passe vient d’être envoyé.', 6000); }
    catch (x) { err(authMessage(x)); }
  });
}

/** E-mail and GitHub accounts confirm their address once (Google accounts are already confirmed). */
async function verifyScreen(cfg, user, extra) {
  await sendVerification(cfg, user).catch(() => {});
  app.innerHTML = authShell(`
    <div><h1>Confirmez votre e-mail</h1><p class="muted" style="margin-top:6px">Nous avons envoyé un lien à <strong>${esc(user.email)}</strong>. Cliquez dessus, puis revenez ici.</p></div>
    <div class="banner bad" id="err" hidden></div>
    <button class="btn primary" id="done">J’ai confirmé mon e-mail</button>
    <button class="btn ghost" id="again">Renvoyer l’e-mail</button>`, 'verify', 'notification');
  $('#done').addEventListener('click', async () => {
    const u = await currentUser(cfg);
    if (!u?.emailVerified) { $('#err').hidden = false; $('#err').textContent = 'Pas encore confirmé : cliquez sur le lien reçu par e-mail (pensez aux indésirables).'; return; }
    try {
      const r = await api('/api/session', { idToken: await u.getIdToken(true), ...extra });
      track(r.created ? 'sign_up' : 'login', { method: method(u) });
      location.hash = r.created ? '#/admin/sites' : '#/';
    } catch (e) { $('#err').hidden = false; $('#err').textContent = e.message; }
  });
  $('#again').addEventListener('click', async () => { await sendVerification(cfg, user).catch(e => toast(authMessage(e))); toast('E-mail renvoyé.'); });
}

// ------------------------------------------------------------------ start
// The extension, if this server has one, gets the app's helpers and registers its hooks before the first screen.
window.ClaudePress = { hook, api, esc, toast, num, euro, longDay, icon, admin, track, $, $$, me: () => me };
const extension = document.querySelector('meta[name="claudepress-extension"]')?.content;
if (extension) await import(extension).catch(e => console.error('[extension]', e));
route();
