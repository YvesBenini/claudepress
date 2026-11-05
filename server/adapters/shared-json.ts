// Texts shared by every page (menu, footer, banners, labels) kept in JSON files of the site, whatever the format
// of its pages. They are written back in their own layout, so a commit shows only the text that changed.
import type { Op, SharedText } from './types.ts';

interface Layout { indent: string | number; newline: boolean; ok: boolean }
export type SharedFiles = Record<string, { data: unknown; layout: Layout }>;

const stringify = (v: unknown, f: { indent: string | number; newline: boolean }) => JSON.stringify(v, null, f.indent) + (f.newline ? '\n' : '');

/** How a JSON file is laid out: indent, final newline. `ok` is false when writing it back would change other lines. */
function layoutOf(text: string): Layout {
  const indent = text.match(/^\{\n( +|\t)"/)?.[1] ?? 1;
  const fmt = { indent, newline: text.endsWith('\n') };
  let ok = false;
  try { ok = stringify(JSON.parse(text), fmt) === text; } catch { /* not JSON */ }
  return { ...fmt, ok };
}

const LINK = /(^|_)(href|url|link|src|icon|image|logo|class|id|key|slug|path)$/i;

export function sharedJson(files: string[], lang: string) {
  /** The part of a shared file for the language being edited: files keyed by language ({"fr": …, "nl": …}) or not. */
  const scopeOf = (data: any) => data && typeof data === 'object' && !Array.isArray(data) && lang in data ? [lang] : [];

  function leafAt(shared: SharedFiles, file: string, keys: (string | number)[]) {
    const data = shared?.[file]?.data;
    if (data === undefined) throw new Error(`Fichier de textes inconnu : ${file}`);
    let parent: any = data;
    for (const k of keys.slice(0, -1)) { parent = parent?.[k]; if (parent == null || typeof parent !== 'object') throw new Error(`Texte introuvable : ${keys.join('.')}`); }
    const last = keys[keys.length - 1];
    if (typeof parent[last] !== 'string') throw new Error(`Texte introuvable : ${keys.join('.')}`);
    return { parent, last };
  }

  return {
    files,

    parse(read: (path: string) => string | null): SharedFiles {
      const out: SharedFiles = {};
      for (const f of files) {
        const t = read(f);
        if (t != null) out[f] = { data: JSON.parse(t), layout: layoutOf(t) };
      }
      return out;
    },

    render(shared: SharedFiles, read: (path: string) => string | null, out: Record<string, string | null>) {
      for (const [f, s] of Object.entries(shared || {})) {
        const t = stringify(s.data, s.layout);
        if (t !== read(f)) {
          if (!s.layout.ok) throw new Error(`${f} ne peut pas être réécrit sans changer sa mise en forme.`);
          out[f] = t;
        }
      }
    },

    apply(shared: SharedFiles, op: Extract<Op, { kind: 'shared' }>) {
      if (!shared?.[op.file]?.layout.ok) throw new Error(`${op.file} ne peut pas être modifié par ClaudePress (mise en forme non reconnue).`);
      const { parent, last } = leafAt(shared, op.file, op.path);
      if (parent[last] !== op.before) throw new Error(`Le texte commun a changé depuis (${op.path.join('.')})`);
      parent[last] = op.after;
    },

    list(shared: SharedFiles): SharedText[] {
      const out: SharedText[] = [];
      for (const [file, s] of Object.entries<any>(shared || {})) {
        const base = scopeOf(s.data);
        const visit = (v: any, keys: (string | number)[]) => {
          if (typeof v === 'string') {
            const own = keys.slice(base.length);
            out.push({ id: `${file}#${JSON.stringify(keys)}`, file, key: own.join('.'), text: v, link: LINK.test(String(own.filter(k => typeof k === 'string').pop() ?? '')) || /^(\/|https?:|mailto:|tel:|#)/.test(v) });
          } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, [...keys, Array.isArray(v) ? +k : k]);
        };
        visit(base.length ? s.data[base[0]] : s.data, base);
      }
      return out;
    },
  };
}
