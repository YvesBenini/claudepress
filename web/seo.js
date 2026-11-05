// SEO checklist for a blog post, shown live while the author edits.
const strip = h => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const fold = s => strip(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function seoChecks(post, existingTitles = []) {
  const kw = fold(post.focusKeyword);
  // every meaningful word of the keyword, in any order: "vin fêtes" matches "vin pour les fêtes"
  const STOP = new Set(['les', 'des', 'une', 'pour', 'avec', 'dans', 'sur', 'aux', 'the', 'and', 'for', 'with', 'van', 'het', 'een', 'voor']);
  const words = kw.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
  const has = s => words.length > 0 && words.every(w => fold(s).includes(w.replace(/s$/, '')));
  const text = post.blocks.map(b => b.html ? strip(b.html) : (b.items || []).map(strip).join(' ')).join(' ');
  const count = text.split(/\s+/).filter(Boolean).length;
  const firstP = post.blocks.find(b => b.type === 'p')?.html || '';
  const h2s = post.blocks.filter(b => b.type === 'h2');
  const links = (post.blocks.map(b => b.html || (b.items || []).join(' ')).join(' ').match(/<a href="\//g) || []).length;
  const mt = (post.metaTitle || '').length, md = (post.metaDescription || '').trim().length;
  const kwSlug = words;
  const checks = [
    { ok: !!kw, label: 'Un mot-clé principal est choisi', tip: 'La recherche Google que l’article doit viser, par ex. « boulangerie bio Namur ».' },
    { ok: mt >= 30 && mt <= 60, label: `Titre Google : ${mt} caractères (30 à 60)`, tip: 'Au-delà de 60 caractères, Google coupe le titre.' },
    { ok: has(post.metaTitle), label: 'Le mot-clé est dans le titre Google' },
    { ok: md >= 70 && md <= 160 && /[.!?…]$/.test((post.metaDescription || '').trim()), label: `Description Google : ${md} caractères (70 à 160, finie par un point)` },
    { ok: has(post.metaDescription), label: 'Le mot-clé est dans la description Google' },
    { ok: has(post.title), label: 'Le mot-clé est dans le titre de l’article' },
    { ok: has(firstP), label: 'Le mot-clé apparaît dans le premier paragraphe' },
    { ok: h2s.length >= 2, label: `${h2s.length} intertitre(s) (au moins 2)`, tip: 'Les intertitres aident les lecteurs et Google à suivre.' },
    { ok: count >= 300, label: `${count} mots (au moins 300)` },
    { ok: links >= 1, label: `${links} lien(s) vers d’autres pages du site (au moins 1)` },
    { ok: !!post.cover?.src, label: 'Une photo de couverture est choisie' },
    { ok: !!post.cover?.src && (post.cover?.alt || '').length >= 10, label: 'La photo a une description (texte alternatif)' },
    { ok: /^[a-z0-9]+(-[a-z0-9]+)*$/.test(post.slug || '') && (post.slug || '').length <= 70 && (!kwSlug.length || kwSlug.some(w => post.slug.includes(w))),
      label: 'Adresse courte et lisible, avec le mot-clé' },
    { ok: !existingTitles.map(fold).includes(fold(post.title)), label: 'Aucun autre article ne porte ce titre' },
  ];
  const score = Math.round(100 * checks.filter(c => c.ok).length / checks.length);
  return { checks, score, words: count };
}
