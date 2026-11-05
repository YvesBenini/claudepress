// Injected into every preview page: outlines the changed elements and keeps two frames scrolled together.
(() => {
  // letters and digits only: a template may add line breaks, capitals or spacing the content does not have
  const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  let marks = [];

  function clear() { marks.forEach(m => m.remove()); marks = []; }

  function mark(el, label) {
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'claudepress-mark';
    Object.assign(box.style, {
      position: 'absolute', left: `${r.left + scrollX - 6}px`, top: `${r.top + scrollY - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px`,
      outline: '3px solid #ff5a36', borderRadius: '8px', boxShadow: '0 0 0 9999px rgba(20,20,30,.08)', pointerEvents: 'none', zIndex: 2147483646,
    });
    const tag = document.createElement('span');
    tag.textContent = label;
    Object.assign(tag.style, { position: 'absolute', top: '-26px', left: '-3px', background: '#ff5a36', color: '#fff', font: '600 12px/1 system-ui, sans-serif',
      padding: '6px 8px', borderRadius: '6px 6px 6px 0', whiteSpace: 'nowrap' });
    box.appendChild(tag);
    document.body.appendChild(box);
    marks.push(box);
    return el;
  }

  function findText(t) {
    const want = norm(t).slice(0, 50);
    if (!want) return null;
    let best = null;
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,p,li,a,blockquote,figcaption,span,strong,em,td,dd,div')) {
      if (!el.offsetParent && el.tagName !== 'BODY') continue;
      if (!norm(el.textContent).includes(want)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  function findImage(name) {
    const n = name.toLowerCase();
    return [...document.querySelectorAll('img, source')].map(e => e.tagName === 'SOURCE' ? e.parentElement.querySelector('img') : e)
      .find(img => img && [img.currentSrc, img.src, img.getAttribute('srcset') || ''].join(' ').toLowerCase().includes(n));
  }

  function apply(spec) {
    clear();
    const found = [];
    (spec.t || []).forEach(t => { const el = findText(t); if (el) found.push(mark(el, spec.label || 'Modifié')); });
    (spec.i || []).forEach(i => { const el = findImage(i); if (el) found.push(mark(el, spec.label || 'Modifié')); });
    if (found[0] && !spec.noScroll) found[0].scrollIntoView({ block: 'center', behavior: 'instant' });
    parent.postMessage({ claudepress: 'found', count: found.length, wanted: (spec.t || []).length + (spec.i || []).length }, '*');
  }

  let spec = null;
  try { spec = JSON.parse(decodeURIComponent((location.hash.match(/claudepress=([^&]+)/) || [])[1] || 'null')); } catch {}
  const run = () => spec && apply(spec);
  addEventListener('load', () => setTimeout(run, 150));
  addEventListener('resize', () => spec && apply({ ...spec, noScroll: true }));

  // scroll sync between the "before" and "after" frames
  let quiet = false;
  addEventListener('scroll', () => {
    if (quiet) { quiet = false; return; }
    const max = document.documentElement.scrollHeight - innerHeight;
    parent.postMessage({ claudepress: 'scroll', ratio: max > 0 ? scrollY / max : 0 }, '*');
  }, { passive: true });
  addEventListener('message', e => {
    if (e.data?.claudepress === 'scrollTo') {
      quiet = true;
      scrollTo(0, e.data.ratio * (document.documentElement.scrollHeight - innerHeight));
    }
  });
})();
