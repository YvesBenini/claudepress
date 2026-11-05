// Images and videos made with fal.ai, on the account's own key or this server's (FAL_KEY): see mediaFor. Results are stored as uploads, like
// the photos people attach, so the assistant can put them on the site the same way.
import { db, newId } from './db.ts';

export const IMAGE_MODEL = 'fal-ai/nano-banana-pro';            // text to image; '/edit' changes or combines given images
export const VIDEO_MODEL = 'fal-ai/kling-video/v3/pro';          // '/text-to-video' or '/image-to-video'
/** fal.ai list prices, USD. */
export const FAL_PRICE = { image: 0.15, videoSecond: 0.14 };

export const falConfigured = () => !!process.env.FAL_KEY;

/** fal.ai answered 401: the key is not (or no longer) valid. */
export class FalKeyRefused extends Error {
  constructor() { super('fal.ai refuse la clé de ce compte : elle a sans doute été révoquée. Votre administrateur doit la remplacer.'); }
}

/** Runs a model through fal's queue and returns its output. Generation takes seconds for an image, minutes for a video. */
async function run(key: string, endpoint: string, input: Record<string, unknown>, timeoutMs: number) {
  const headers = { authorization: `Key ${key}`, 'content-type': 'application/json' };
  const res = await fetch(`https://queue.fal.run/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(input) });
  if (res.status === 401) throw new FalKeyRefused();
  if (!res.ok) throw new Error(`fal.ai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const job = await res.json() as { status_url: string; response_url: string };
  const end = Date.now() + timeoutMs;
  for (let wait = 1000; ; wait = Math.min(wait * 1.5, 5000)) {
    if (Date.now() > end) throw new Error('fal.ai: trop long, abandonné');
    await new Promise(r => setTimeout(r, wait));
    const st = await (await fetch(job.status_url, { headers })).json() as { status: string };
    if (st.status === 'COMPLETED') break;
  }
  const out = await fetch(job.response_url, { headers });
  const body = await out.json() as any;
  // a refused prompt (safety checker) or a failed generation comes back as an error body
  if (!out.ok) throw new Error(`fal.ai: ${typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body).slice(0, 300)}`);
  return body;
}

/** Whether fal.ai accepts a key: the status of a job that does not exist is 404 with a good key, 401 with a bad one. */
export async function checkFalKey(key: string) {
  const res = await fetch(`https://queue.fal.run/${IMAGE_MODEL}/requests/00000000-0000-0000-0000-000000000000/status`,
    { headers: { authorization: `Key ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) return false;
  if (res.status === 404 || res.ok) return true;
  throw new Error(`fal.ai ${res.status}`);
}

/** Downloads a result and keeps it as an upload. Returns the upload's file name. */
async function keep(url: string, base: string, ext: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fal.ai: téléchargement impossible (${res.status})`);
  const file = `${newId(8)}-${base}${ext}`;
  await db.putFile(`uploads/${file}`, Buffer.from(await res.arrayBuffer()));
  return file;
}

const dataUri = (img: { data: Buffer; mediaType: string }) => `data:${img.mediaType};base64,${img.data.toString('base64')}`;
const slug = (prompt: string) => prompt.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';

export const ASPECT_RATIOS = ['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '21:9'] as const;
export type AspectRatio = typeof ASPECT_RATIOS[number];

/** A new image from a description, or one made from the given images (changed, extended, combined). */
export async function generateImage(key: string, prompt: string, aspectRatio: AspectRatio | 'auto', sources: { data: Buffer; mediaType: string }[]) {
  const out = await run(key, sources.length ? `${IMAGE_MODEL}/edit` : IMAGE_MODEL, {
    prompt, aspect_ratio: aspectRatio, resolution: '2K', output_format: 'webp', num_images: 1,
    ...(sources.length ? { image_urls: sources.map(dataUri) } : {}),
  }, 3 * 60_000);
  const url = out.images?.[0]?.url;
  if (!url) throw new Error('fal.ai: aucune image renvoyée');
  return { file: await keep(url, slug(prompt), '.webp'), cost: FAL_PRICE.image };
}

/** A short silent video, from a description or bringing a still image to life. */
export async function generateVideo(key: string, prompt: string, aspectRatio: '16:9' | '9:16' | '1:1', seconds: number, start: { data: Buffer; mediaType: string } | null) {
  const out = await run(key, `${VIDEO_MODEL}/${start ? 'image-to-video' : 'text-to-video'}`, {
    prompt, duration: String(seconds), generate_audio: false,
    ...(start ? { start_image_url: dataUri(start) } : { aspect_ratio: aspectRatio }),
  }, 15 * 60_000);
  const url = out.video?.url;
  if (!url) throw new Error('fal.ai: aucune vidéo renvoyée');
  return { file: await keep(url, slug(prompt), '.mp4'), cost: FAL_PRICE.videoSecond * seconds };
}
