// A site adapter teaches ClaudePress one way of storing a site's content.
// ClaudePress never edits code: it reads the content, applies small operations to it,
// asks the adapter to build the site, and serves the result as a preview.

export type PageKind = 'page' | 'post' | 'product' | 'product_category' | string;

export interface PageSummary {
  url: string;
  kind: PageKind;
  title: string;
}

/** One editable thing on a page, as the assistant and the client see it. */
export interface Element {
  id: string;                 // stable address inside the page, e.g. "s0.r1.c0.b2"
  type: 'heading' | 'text' | 'list' | 'image' | 'button' | 'quote';
  label: string;              // plain-language name: "Titre", "Paragraphe", "Photo"…
  html?: string;              // heading / text / quote
  items?: string[];           // list
  src?: string;               // image
  alt?: string;               // image
  text?: string;              // button label
  href?: string;              // button or linked image
}

export interface Match {
  url: string;
  pageTitle: string;
  elementId: string;
  label: string;
  snippet: string;
}

/** A change to the content. `before` is kept so a change can be checked, shown and undone. */
export type Op =
  | { kind: 'set'; url: string; elementId: string; field: 'html' | 'items' | 'src' | 'alt' | 'text' | 'href'; before: unknown; after: unknown; media?: MediaFile }
  | { kind: 'seo'; url: string; field: 'title' | 'description'; before: string; after: string }
  | { kind: 'price'; url: string; before: Price | null; after: Price | null }
  | { kind: 'create_post'; url: string; post: NewPost }
  | { kind: 'delete_post'; url: string; snapshot: unknown }
  // site-wide: a text of a shared content file (labels, banners, menu…), shown on many pages
  | { kind: 'shared'; url: string; file: string; path: (string | number)[]; before: string; after: string }
  // full edit, agency style: a whole file of the repository (template, style, script…); `before` null for a new file
  | { kind: 'file'; url: string; path: string; before: string | null; after: string };

/** A text of a shared content file, as the assistant sees it. */
export interface SharedText { id: string; file: string; key: string; text: string; link: boolean }

export interface Price { per_kg?: number; kg?: number; per_piece?: number }

export interface MediaFile {
  upload: string;   // file name in data/uploads
  path: string;     // where it goes in the site, e.g. /wp-content/uploads/2026/10/photo.jpg
}

export interface PostBlock { type: 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'quote'; html?: string; items?: string[] }

export interface NewPost {
  title: string;              // H1 shown on the page
  slug: string;
  metaTitle: string;
  metaDescription: string;
  focusKeyword: string;
  cover?: { src: string; alt: string; media?: MediaFile };
  blocks: PostBlock[];
  published: string;          // ISO date
}

/** Where a change shows on the built site, so the preview can scroll to it and outline it. */
export interface Highlight { url: string; texts: string[]; images: string[] }

export interface SiteAdapter {
  /** Short description of what clients can and cannot change, given to the assistant. */
  guide: string;
  load(dir: string): Content;
  save(dir: string, content: Content): void;
  listPages(content: Content, kind?: string): PageSummary[];
  readPage(content: Content, url: string): { title: string; kind: PageKind; elements: Element[]; seo: { title: string; description: string } } | null;
  search(content: Content, query: string): Match[];
  /** Applies one operation. Throws when the content no longer matches `before` (someone changed it meanwhile). */
  apply(content: Content, op: Op): void;
  invert(op: Op): Op;
  highlight(content: Content, op: Op): Highlight;
  /**
   * Where a new photo goes: `src` is written in the content, `path` (a MediaFile path) is where its file is stored.
   * `near` is the page it goes on, for sites whose pages point to their photos relative to their own file.
   */
  mediaPath(fileName: string, date: Date, near?: { content: Content; url: string }): { src: string; path: string };
  mediaFile(dir: string, publicPath: string): string;
  /** Files and folders of the checkout that hold content (committed on publish). */
  contentFiles: string[];
  /** Text files the content is read from (repository paths), picked among all the files of the repository. */
  textFiles(all: string[]): string[];
  /** Is this repository path content, changed only through the content tools (not as a whole file)? */
  owns(path: string): boolean;
  /** Content from file texts; `read` returns null for a missing file. */
  parse(read: (path: string) => string | null, paths: string[]): Content;
  /** File texts that differ from `read` once the content is written back; null for a file to delete. */
  render(content: Content, read: (path: string) => string | null): Record<string, string | null>;
  /** Address of a new blog post. */
  postUrl(content: Content, slug: string): string;
  /** Repository path of a media file, from its public path. */
  mediaRepoPath(publicPath: string): string;
  build(dir: string): Promise<{ ok: boolean; log: string; outDir: string }>;
  products?(content: Content): { url: string; title: string }[];
  /** Files of texts shared by every page (labels, banners, menu): editable with site-wide changes. */
  sharedFiles?: string[];
  listShared?(content: Content): SharedText[];
}

// The adapter decides what this is; ClaudePress only passes it around.
export type Content = any;
