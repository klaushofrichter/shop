/**
 * Display images (docs/design/04 §6, ADR-0035): the shop renders its own, so
 * pages don't depend on a source's URL scheme or uptime and the CSP stays
 * `img-src 'self'`. Widths 640, 1024, 1536 (never enlarged), WebP and JPEG,
 * sRGB, EXIF orientation applied, **no metadata** (the JPEG keeps only its sRGB
 * profile).
 */
import sharp from 'sharp';
import type { FileStore } from './store';

export const DISPLAY_WIDTHS = [640, 1024, 1536] as const;

export interface DisplayImage {
  sha256: string;
  widthPx: number;
  heightPx: number;
  format: 'webp' | 'jpeg';
  /** Path under the shop: /img/<sha>.<ext> */
  path: string;
}

export interface ImageLimits {
  /** sharp's limitInputPixels: decompression bombs stop here (MAX_INPUT_MEGAPIXELS). */
  maxInputPixels: number;
}

export async function probe(file: string, limits: ImageLimits): Promise<{ width: number; height: number; format: string }> {
  const m = await sharp(file, { limitInputPixels: limits.maxInputPixels }).metadata();
  if (!m.width || !m.height || !m.format) throw new Error('not a readable image');
  if (m.format !== 'jpeg' && m.format !== 'png') throw new Error(`unsupported image format ${m.format}`);
  // EXIF orientations 5–8 swap width and height.
  const swapped = (m.orientation ?? 1) >= 5;
  return { width: swapped ? m.height : m.width, height: swapped ? m.width : m.height, format: m.format };
}

export async function renderDisplayImages(file: string, store: FileStore, limits: ImageLimits): Promise<DisplayImage[]> {
  const { width } = await probe(file, limits);
  const widths = [...new Set(DISPLAY_WIDTHS.map((w) => Math.min(w, width)))];
  const out: DisplayImage[] = [];
  for (const w of widths) {
    const base = () =>
      sharp(file, { limitInputPixels: limits.maxInputPixels, sequentialRead: true })
        .rotate()
        .resize({ width: w, withoutEnlargement: true, kernel: 'lanczos3' })
        .toColourspace('srgb');
    for (const format of ['webp', 'jpeg'] as const) {
      const pipeline = base();
      const { data, info } = await (format === 'webp'
        ? pipeline.webp({ quality: 80 })
        : pipeline.withIccProfile('srgb').jpeg({ quality: 82, mozjpeg: true })
      ).toBuffer({ resolveWithObject: true });
      const ext = format === 'webp' ? 'webp' : 'jpg';
      const sha = store.put('img', ext, data);
      out.push({ sha256: sha, widthPx: info.width, heightPx: info.height, format, path: `/img/${sha}.${ext}` });
    }
  }
  return out;
}
