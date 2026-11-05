// Photos made ready for the web before they go on a site: turned upright, sized for the spot they go into
// and compressed as WebP. Phone photos (4000 px, several MB) and generated images (2K) come out a few hundred KB.
import sharp from 'sharp';
import { db, newId } from './db.ts';

/** Width of a photo on the site: the one it replaces, at least MIN for sharp screens, at most MAX. Without one, DEFAULT on the long edge. */
const MIN = 1200, MAX = 2400, DEFAULT = 1920;
const QUALITY = 80;

export interface Size { width: number; height: number }

/** Pixel size of an image, upright, or null when it is not an image. */
export async function sizeOf(data: Buffer): Promise<Size | null> {
  try {
    const m = await sharp(data).metadata();
    if (!m.width || !m.height) return null;
    return (m.orientation ?? 1) >= 5 ? { width: m.height, height: m.width } : { width: m.width, height: m.height };
  } catch { return null; }
}

/** The box an image for `spot` should cover, `spot` being the size of the photo it replaces, if known. */
export function targetFor(spot: Size | null): Size & { fit: 'outside' | 'inside' } {
  if (!spot) return { width: DEFAULT, height: DEFAULT, fit: 'inside' };
  const width = Math.min(MAX, Math.max(MIN, spot.width));
  return { width, height: Math.round(width * spot.height / spot.width), fit: 'outside' };
}

/**
 * Stores a web version of the upload `file`: no larger than needed to fill `spot` (never enlarged), as WebP.
 * Returns the new upload's file name and size; an animated GIF, or an image already as small, is kept as it is.
 */
export async function forWeb(file: string, spot: Size | null): Promise<{ file: string } & Size> {
  const data = await db.getFile(`uploads/${file}`);
  if (!data) throw new Error(`Photo introuvable : ${file}`);
  const meta = await sharp(data).metadata();
  const own = (await sizeOf(data))!;
  if ((meta.pages ?? 1) > 1) return { file, ...own };
  const t = targetFor(spot);
  const out = await sharp(data).rotate()
    .resize({ width: t.width, height: t.height, fit: t.fit, withoutEnlargement: true })
    .webp({ quality: QUALITY, effort: 5 })
    .toBuffer({ resolveWithObject: true });
  const size = { width: out.info.width, height: out.info.height };
  if (meta.format === 'webp' && out.data.length >= data.length && size.width === own.width) return { file, ...own };
  const name = `${newId(8)}-${file.replace(/^[a-z0-9]+-/, '').replace(/\.[a-z0-9]+$/i, '')}.webp`;
  await db.putFile(`uploads/${name}`, out.data);
  return { file: name, ...size };
}

/** A white-label logo, small enough for the top bar on sharp screens (at most 160 px high, 800 px wide), as WebP with its transparency. */
export async function logoForWeb(data: Buffer) {
  return sharp(data).rotate().resize({ width: 800, height: 160, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90, alphaQuality: 100 }).toBuffer();
}

/** A white-label tab icon: the image fitted in a 192 px square on a transparent ground, as PNG, which every browser shows in its tabs. */
export async function iconForWeb(data: Buffer) {
  return sharp(data).rotate().resize({ width: 192, height: 192, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

/** The supported aspect ratio closest to a size. */
export function closestRatio<R extends string>(size: Size, ratios: readonly R[]): R {
  const want = Math.log(size.width / size.height);
  const of = (r: string) => { const [w, h] = r.split(':').map(Number); return Math.abs(Math.log(w / h) - want); };
  return ratios.reduce((best, r) => of(r) < of(best) ? r : best);
}
