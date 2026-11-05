// Front matter of Markdown files: the YAML (---) or TOML (+++) header that holds a page's title, description, date,
// cover photo… Only simple values are read and written: top-level keys and the direct children of one map
// ("seo.title", "cover.image"). A value is written back on its own lines, in its own style (plain, quoted, block),
// so the rest of the header (comments, lists, order, unknown keys) stays exactly as it was.

export type Style = 'plain' | 'double' | 'single' | 'block' | 'bare' | 'other';

export interface Field {
  key: string;           // "title", "seo.title"
  value: string | null;  // null: not a single value (list, map, flow collection, multi-line TOML string…)
  style: Style;
  start: number;         // first line (index in the file)
  end: number;           // line after the last one
  indent: string;
  name: string;          // the key as written ("title", "'title'")
  block?: string;        // block scalars: the indicator, e.g. ">-"
  kind: 'scalar' | 'list' | 'map';
}

export interface Doc {
  lines: string[];
  eol: string;
  format: 'yaml' | 'toml' | null;
  fmEnd: number;         // index of the closing --- / +++ line (-1 without front matter)
  body: number;          // index of the first line after the front matter
}

export function splitDoc(text: string): Doc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const delim = lines[0]?.trimEnd();
  if (delim === '---' || delim === '+++') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trimEnd() === delim) return { lines, eol, format: delim === '---' ? 'yaml' : 'toml', fmEnd: i, body: i + 1 };
    }
  }
  return { lines, eol, format: null, fmEnd: -1, body: 0 };
}

const indentOf = (l: string) => l.match(/^[ \t]*/)![0];
const blank = (l: string) => /^\s*(#.*)?$/.test(l);

/** Reads a double-quoted string (YAML and TOML basic strings): escapes, possibly over several lines. */
function readDouble(lines: string[], i: number, from: number) {
  let s = '', j = i, k = from + 1;
  for (;;) {
    const l = lines[j];
    for (; k < l.length; k++) {
      const c = l[k];
      if (c === '"') return { value: s, end: j + 1 };
      if (c === '\\') {
        const n = l[++k];
        if (n === undefined) { k = l.length; continue; }   // escaped line break: joins the lines
        if (n === 'u' || n === 'U') { const len = n === 'u' ? 4 : 8; s += String.fromCodePoint(parseInt(l.slice(k + 1, k + 1 + len), 16)); k += len; continue; }
        s += ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', '0': '\0', ' ': ' ' } as Record<string, string>)[n] ?? n;
      } else s += c;
    }
    if (++j >= lines.length) throw new Error('unterminated');
    s += ' '; k = 0;
    while (k < lines[j].length && /\s/.test(lines[j][k])) k++;
  }
}

function readSingle(lines: string[], i: number, from: number) {
  let s = '', j = i, k = from + 1;
  for (;;) {
    const l = lines[j];
    for (; k < l.length; k++) {
      if (l[k] === "'") { if (l[k + 1] === "'") { s += "'"; k++; continue; } return { value: s, end: j + 1 }; }
      s += l[k];
    }
    if (++j >= lines.length) throw new Error('unterminated');
    s += ' '; k = 0;
    while (k < lines[j].length && /\s/.test(lines[j][k])) k++;
  }
}

/** YAML: the keys of one level (indent), from `from` to `to`, with the direct children of maps one level down. */
function yamlLevel(lines: string[], from: number, to: number, indent: string, prefix: string, out: Map<string, Field>, depth: number) {
  const KEY = /^([ \t]*)("[^"]*"|'[^']*'|[^\s#'"\-?:,\[\]{}][^:#]*?)[ \t]*:(?:[ \t]+(.*))?$/;
  for (let i = from; i < to;) {
    const l = lines[i];
    const m = blank(l) ? null : l.match(KEY);
    if (!m || m[1] !== indent) { i++; continue; }
    const name = m[2], key = prefix + name.replace(/^["']|["']$/g, '');
    const rest = (m[3] ?? '').replace(/[ \t]+#.*$/, '').trim();
    // the lines of this value: more indented than the key, or blank
    // (a list may sit at the key's own indent: "tags:\n- a")
    let end = i + 1;
    for (let j = i + 1; j < to; j++) {
      if (blank(lines[j])) continue;
      if (indentOf(lines[j]).length > indent.length || (!rest && indentOf(lines[j]) === indent && /^-(\s|$)/.test(lines[j].slice(indent.length)))) end = j + 1;
      else break;
    }
    const f: Field = { key, value: null, style: 'other', start: i, end, indent, name, kind: 'scalar' };
    try {
      if (!rest) {
        const first = lines.slice(i + 1, end).find(x => !blank(x));
        if (first && /^\s*-(\s|$)/.test(first)) f.kind = 'list';
        else if (first) {
          f.kind = 'map';
          if (depth === 0) yamlLevel(lines, i + 1, end, indentOf(first), key + '.', out, 1);
        } else { f.value = ''; f.style = 'plain'; }
      } else if (rest[0] === '"') {
        const r = readDouble(lines, i, l.indexOf('"', l.indexOf(':', indent.length + name.length)));
        Object.assign(f, { value: r.value, style: 'double', end: Math.max(r.end, i + 1) });
      } else if (rest[0] === "'") {
        const r = readSingle(lines, i, l.indexOf("'", l.indexOf(':', indent.length + name.length)));
        Object.assign(f, { value: r.value, style: 'single', end: Math.max(r.end, i + 1) });
      } else if (/^[|>][+-]?\d?$/.test(rest)) {
        const body = lines.slice(i + 1, end);
        const ind = Math.min(...body.filter(x => x.trim()).map(x => indentOf(x).length));
        const texts = body.map(x => x.slice(ind));
        while (texts.length && !texts[texts.length - 1].trim()) texts.pop();
        f.value = rest[0] === '|' ? texts.join('\n') : texts.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/\n\n/g, '\n');
        f.style = 'block'; f.block = rest;
      } else if (/^[\[{&*!]/.test(rest)) {
        f.kind = rest[0] === '[' ? 'list' : rest[0] === '{' ? 'map' : 'scalar';
      } else {
        // plain value, possibly continued on more indented lines
        f.value = [rest, ...lines.slice(i + 1, end).map(x => x.trim()).filter(Boolean)].join(' ');
        f.style = 'plain';
      }
    } catch { /* unterminated quote: left as it is */ }
    out.set(key, f);
    i = end;
  }
}

function tomlFields(lines: string[], from: number, to: number, out: Map<string, Field>) {
  let table = '';
  for (let i = from; i < to; i++) {
    const l = lines[i];
    const t = l.match(/^\s*\[([A-Za-z0-9_.-]+)\]\s*(#.*)?$/);
    if (t) { table = t[1].includes('.') ? '\0' : t[1] + '.'; continue; }   // nested tables are not read
    if (/^\s*\[\[/.test(l)) { table = '\0'; continue; }
    const m = l.match(/^(\s*)([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.*)$/);
    if (!m || table === '\0') continue;
    const key = table + m[2].replace(/^"|"$/g, ''), rest = m[3];
    const f: Field = { key, value: null, style: 'other', start: i, end: i + 1, indent: m[1], name: m[2], kind: 'scalar' };
    const at = l.length - rest.length;
    try {
      if (rest.startsWith('"""') || rest.startsWith("'''")) {
        const q = rest.slice(0, 3);
        let j = i, text = rest.slice(3);
        while (!text.includes(q) && ++j < to) text += '\n' + lines[j];
        f.end = j + 1;
      } else if (rest[0] === '"') {
        const r = readDouble(lines, i, at);
        if (r.end === i + 1) Object.assign(f, { value: r.value, style: 'double' });
      } else if (rest[0] === "'") {
        const v = rest.slice(1, rest.indexOf("'", 1));
        Object.assign(f, { value: v, style: 'single' });
      } else if (rest[0] === '[' || rest[0] === '{') {
        f.kind = rest[0] === '[' ? 'list' : 'map';
        let j = i, depth = 0;
        for (; j < to; j++) { for (const c of j === i ? rest : lines[j]) depth += c === '[' || c === '{' ? 1 : c === ']' || c === '}' ? -1 : 0; if (depth <= 0) break; }
        f.end = Math.min(j, to - 1) + 1;
      } else Object.assign(f, { value: rest.replace(/\s+#.*$/, '').trim(), style: 'bare' });
    } catch { /* left as it is */ }
    out.set(key, f);
  }
}

/** The fields of a document's front matter: top-level keys, and the direct children of maps ("seo.title"). */
export function fieldsOf(doc: Doc): Map<string, Field> {
  const out = new Map<string, Field>();
  if (doc.format === 'yaml') yamlLevel(doc.lines, 1, doc.fmEnd, '', '', out, 0);
  if (doc.format === 'toml') tomlFields(doc.lines, 1, doc.fmEnd, out);
  return out;
}

const SPECIAL = /^(true|false|yes|no|on|off|y|n|null|~|[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?|0x[\da-fA-F]+|0o[0-7]+|\.inf|\.nan|\d{4}-\d\d-\d\d.*)$/i;
/** Can this text be written as a plain YAML value and read back the same? */
const plainOk = (v: string) => !!v && v === v.trim() && !/[\n\t]/.test(v) && !/^[\-?:,\[\]{}#&*!|>'"%@`]/.test(v) && !/: |:$| #/.test(v) && !SPECIAL.test(v);

/** A value as YAML or TOML text, in the given style. `raw` writes it as it is (dates, numbers, booleans). */
function written(format: 'yaml' | 'toml', style: Style, value: string, raw: boolean) {
  if (raw) return value;
  if (format === 'toml') return style === 'single' && !/['\n]/.test(value) ? `'${value}'` : JSON.stringify(value);
  if (style === 'single' && !value.includes('\n')) return `'${value.replace(/'/g, "''")}'`;
  if (style === 'plain' && plainOk(value)) return value;
  return JSON.stringify(value);
}

/**
 * The document with one field set. An existing field keeps its place and style; a missing one is added at the end
 * of the front matter (or of its map). Returns the new text.
 */
export function setField(text: string, key: string, value: string, o: { raw?: boolean } = {}): string {
  const doc = splitDoc(text);
  const lines = doc.lines;
  if (!doc.format) {
    // no front matter yet: one is created
    return ['---', `${key}: ${written('yaml', 'plain', value, !!o.raw)}`, '---', ...lines].join(doc.eol);
  }
  const fields = fieldsOf(doc);
  const f = fields.get(key);
  const sep = doc.format === 'toml' ? ' = ' : ': ';
  if (f) {
    if (f.value === null && f.style !== 'plain') throw new Error(`Le champ « ${key} » n’est pas un texte simple.`);
    let out: string[];
    if (f.style === 'block' && doc.format === 'yaml' && !o.raw) {
      const ind = f.indent + '  ';
      const body = f.block!.startsWith('|') ? value.split('\n').map(x => x ? ind + x : '') : [ind + value.replace(/\n/g, ' ')];
      out = [`${f.indent}${f.name}: ${f.block}`, ...body];
    } else {
      out = [`${f.indent}${f.name}${doc.format === 'toml' ? lines[f.start].match(/\s*=\s*/)![0] : ': '}${written(doc.format, f.style, value, !!o.raw)}`];
    }
    // a comment at the end of a one-line value is kept
    const comment = f.end === f.start + 1 && f.style !== 'double' && f.style !== 'single' ? lines[f.start].match(/[ \t]+#.*$/)?.[0] ?? '' : '';
    if (out.length === 1) out[0] += comment;
    lines.splice(f.start, f.end - f.start, ...out);
    return lines.join(doc.eol);
  }
  const dot = key.indexOf('.');
  const parent = dot > 0 ? fields.get(key.slice(0, dot)) : undefined;
  if (dot > 0 && parent?.kind === 'map' && doc.format === 'yaml') {
    const children = [...fields.values()].filter(x => x.key.startsWith(parent.key + '.'));
    const ind = children[0]?.indent ?? parent.indent + '  ';
    let at = parent.end;
    while (at > parent.start + 1 && blank(lines[at - 1])) at--;
    lines.splice(at, 0, `${ind}${key.slice(dot + 1)}: ${written('yaml', 'plain', value, !!o.raw)}`);
    return lines.join(doc.eol);
  }
  if (dot > 0) throw new Error(`Le champ « ${key} » ne peut pas être ajouté.`);
  // TOML: top-level keys go before the first table
  let at = doc.fmEnd;
  if (doc.format === 'toml') { const t = lines.slice(1, doc.fmEnd).findIndex(l => /^\s*\[/.test(l)); if (t >= 0) at = t + 1; }
  while (at > 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, `${key}${sep}${written(doc.format, 'plain', value, !!o.raw)}`);
  return lines.join(doc.eol);
}

/** Removes a field and its lines. */
export function removeField(text: string, key: string): string {
  const doc = splitDoc(text);
  const f = fieldsOf(doc).get(key);
  if (!f) return text;
  doc.lines.splice(f.start, f.end - f.start);
  return doc.lines.join(doc.eol);
}
