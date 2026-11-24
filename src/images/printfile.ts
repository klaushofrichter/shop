/**
 * Print files (docs/design/04 §5.2). From the original:
 * 1. decode (with the pixel limit), apply EXIF orientation, convert to sRGB;
 * 2. crop to the print area's aspect ratio in the offer's orientation, centred
 *    or at one of nine anchors (review 1 F29); a mug gets the work twice, left
 *    and right of the handle; a t-shirt gets the whole work fitted into its
 *    area on a transparent PNG;
 * 3. resize to the exact pixel size; JPEG quality 92, 4:4:4, the sRGB profile,
 *    no other metadata;
 * 4. validate, hash, store as files/<sha>.<ext>.
 */
import sharp from 'sharp';
import type { Sku } from '../catalog-config';
import type { ImageLimits } from './display';
import type { FileStore } from './store';

export const RENDERER_VERSION = 'r1';

export type Orientation = 'portrait' | 'landscape';
export const ANCHORS = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'] as const;
export type Anchor = (typeof ANCHORS)[number];

export function orientationOf(widthPx: number, heightPx: number): Orientation {
  return widthPx > heightPx ? 'landscape' : 'portrait';
}

/** The print area in inches for an orientation; mugs and t-shirts have one fixed area. */
export function printArea(sku: Sku, o: Orientation): { w: number; h: number } {
  const [a, b] = sku.printAreaIn;
  if (sku.kind !== 'paper') return { w: a, h: b };
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  return o === 'landscape' ? { w: long, h: short } : { w: short, h: long };
}

/** The DPI floor per kind: paper from the SKU file (180), the others at half their print DPI. */
export function minDpi(sku: Sku, minDpiPaper: number): number {
  return sku.kind === 'paper' ? minDpiPaper : Math.floor(sku.dpi / 2);
}

export interface CropPlan {
  /** Crop box in the upright original, in pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Output size in pixels. */
  outW: number;
  outH: number;
  /** Pixels of the original per inch of print. */
  effectiveDpi: number;
  /** Share of the original's area cut away, 0–1. */
  cut: number;
}

/**
 * Where to crop. For a mug the crop has the aspect of one half of the wrap
 * (the work appears twice); for a t-shirt nothing is cut (the work is fitted).
 */
export function planCrop(sku: Sku, srcW: number, srcH: number, anchor: Anchor): CropPlan {
  const o = orientationOf(srcW, srcH);
  const area = printArea(sku, o);
  const outW = Math.round(area.w * sku.dpi);
  const outH = Math.round(area.h * sku.dpi);
  if (sku.kind === 'apparel') {
    const scale = Math.min(area.w / srcW, area.h / srcH);
    return { left: 0, top: 0, width: srcW, height: srcH, outW, outH, effectiveDpi: Math.floor(1 / scale), cut: 0 };
  }
  const targetW = sku.kind === 'mug' ? area.w / 2 : area.w;
  const aspect = targetW / area.h;
  let width = srcW;
  let height = Math.round(srcW / aspect);
  if (height > srcH) {
    height = srcH;
    width = Math.round(srcH * aspect);
  }
  const col = anchor.includes('w') ? 0 : anchor.includes('e') ? 2 : 1;
  const row = anchor.startsWith('n') ? 0 : anchor.startsWith('s') ? 2 : 1;
  const left = Math.round(((srcW - width) * col) / 2);
  const top = Math.round(((srcH - height) * row) / 2);
  return {
    left, top, width, height, outW, outH,
    effectiveDpi: Math.floor(width / targetW),
    cut: 1 - (width * height) / (srcW * srcH),
  };
}

export interface RenderedPrintFile {
  sha256: string;
  ext: 'jpg' | 'png';
  widthPx: number;
  heightPx: number;
  bytes: number;
  effectiveDpi: number;
  cut: number;
}

export class DpiTooLow extends Error {
  constructor(readonly effectiveDpi: number, readonly floor: number) {
    super(`effective ${effectiveDpi} DPI is below the floor of ${floor}`);
    this.name = 'DpiTooLow';
  }
}

export async function renderPrintFile(
  file: string,
  sku: Sku,
  anchor: Anchor,
  opts: ImageLimits & { minDpiPaper: number; store: FileStore },
): Promise<RenderedPrintFile> {
  // Upright, sRGB, raw pixels: no lossy step before the one encode at the end.
  const upright = await sharp(file, { limitInputPixels: opts.maxInputPixels }).rotate().toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: upright.info.width, height: upright.info.height, channels: upright.info.channels } };
  const plan = planCrop(sku, upright.info.width, upright.info.height, anchor);
  const floor = minDpi(sku, opts.minDpiPaper);
  if (plan.effectiveDpi < floor) throw new DpiTooLow(plan.effectiveDpi, floor);

  let data: Buffer;
  let ext: 'jpg' | 'png';
  if (sku.kind === 'apparel') {
    // Fitted, centred at the top of the area, on transparency.
    const fitted = await sharp(upright.data, raw)
      .resize({ width: plan.outW, height: plan.outH, fit: 'inside', kernel: 'lanczos3' })
      .toColourspace('srgb')
      .png()
      .toBuffer({ resolveWithObject: true });
    data = await sharp({ create: { width: plan.outW, height: plan.outH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: fitted.data, left: Math.round((plan.outW - fitted.info.width) / 2), top: 0 }])
      .withIccProfile('srgb')
      .png({ compressionLevel: 9 })
      .toBuffer();
    ext = 'png';
  } else {
    const half = sku.kind === 'mug' ? Math.round(plan.outW / 2) : plan.outW;
    const crop = await sharp(upright.data, raw)
      .extract({ left: plan.left, top: plan.top, width: plan.width, height: plan.height })
      .resize({ width: half, height: plan.outH, fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer();
    const canvas =
      sku.kind === 'mug'
        ? sharp({ create: { width: plan.outW, height: plan.outH, channels: 3, background: '#ffffff' } }).composite([
            { input: crop, left: 0, top: 0 },
            { input: crop, left: plan.outW - half, top: 0 },
          ])
        : sharp(crop);
    data = await canvas.withIccProfile('srgb').jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();
    ext = 'jpg';
  }

  // Validate before storing: exact size, sRGB, 8 bits, under 200 MB.
  const m = await sharp(data).metadata();
  if (m.width !== plan.outW || m.height !== plan.outH) throw new Error(`rendered ${m.width}×${m.height}, expected ${plan.outW}×${plan.outH}`);
  if (m.space !== 'srgb' || m.depth !== 'uchar') throw new Error('rendered file is not 8-bit sRGB');
  if (data.length >= 200 * 1024 * 1024) throw new Error('rendered file is over 200 MB');
  const sha256 = opts.store.put('files', ext, data);
  return { sha256, ext, widthPx: plan.outW, heightPx: plan.outH, bytes: data.length, effectiveDpi: plan.effectiveDpi, cut: plan.cut };
}
