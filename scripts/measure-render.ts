/**
 * Peak memory of one print-file render (docs/design/11 §1: below 384 MiB in a
 * 512 MiB pod). Renders the largest paper product from a synthetic original at
 * the input pixel limit and prints the peak resident set size in MiB.
 *
 *   npx tsx scripts/measure-render.ts [megapixels]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadSkus } from '../src/catalog-config';
import { renderPrintFile } from '../src/images/printfile';
import { FileStore } from '../src/images/store';

async function main() {
  sharp.concurrency(1);
  sharp.cache(false);
  const mp = Number(process.argv[2] ?? 50);
  const h = Math.floor(Math.sqrt((mp * 1e6 * 4) / 3));
  const w = Math.floor((h * 3) / 4);
  const dir = mkdtempSync(path.join(tmpdir(), 'measure-'));
  const store = new FileStore(dir);
  const src = process.argv[3] ?? path.join(dir, 'original.jpg');
  if (!process.argv[3]) {
    // Made in a child process, so its memory doesn't count here.
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, ['-e', `require('sharp')({ create: { width: ${w}, height: ${h}, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).withIccProfile('p3').jpeg({ quality: 90 }).toFile(${JSON.stringify(src)})`], { cwd: process.cwd() });
  }
  const base = process.memoryUsage().rss;
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
  const skus = loadSkus('config/skus.json', 'mock');
  for (const id of ['print-12x16', 'framed-12x16-black', 'mug-11oz', 'tshirt-white-m']) {
    await renderPrintFile(src, skus.byId.get(id)!, 'c', { maxInputPixels: 60_000_000, minDpiPaper: 1, store });
  }
  clearInterval(timer);
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ megapixels: mp, width: w, height: h, baseMiB: Math.round(base / 1048576), peakMiB: Math.round(peak / 1048576) }));
}
void main();
