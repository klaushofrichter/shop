/**
 * A fake art (docs/design/12 §2): the home page with a manifest of one room and
 * two works, and their originals as Display P3 JPEGs generated at start, one
 * portrait and one landscape. Only the fields the shop's adapter reads matter.
 */
import express from 'express';
import sharp from 'sharp';

export async function createFakeArt() {
  const original = async (w: number, h: number, colour: { r: number; g: number; b: number }) =>
    sharp({ create: { width: w, height: h, channels: 3, background: colour } })
      .composite([{ input: await sharp({ create: { width: Math.round(w / 3), height: Math.round(h / 3), channels: 3, background: '#f4f1ea' } }).png().toBuffer(), left: Math.round(w / 3), top: Math.round(h / 3) }])
      .withIccProfile('p3')
      .jpeg({ quality: 90 })
      .toBuffer();
  const files: Record<string, Buffer> = {
    'portrait.jpg': await original(2400, 3200, { r: 40, g: 70, b: 140 }),
    'landscape.jpg': await original(3200, 2400, { r: 160, g: 60, b: 40 }),
  };
  const manifest = [
    {
      id: 'colors', uid: 'room0001', type: 'pictures', title: 'Colors',
      works: [
        { slug: 'blue', uid: 'e2eblue1', file: 'portrait.jpg', v: 'v1', title: 'E2E Blue', date: '2024-01', artist: 'A. Painter', price: 100, status: 'available' },
        { slug: 'red', uid: 'e2ered01', file: 'landscape.jpg', v: 'v1', title: 'E2E Red', date: '2025-02', artist: 'A. Painter' },
      ],
    },
    { id: 'about', type: 'about' },
  ];
  const app = express();
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html><body><script type="application/json" id="manifest">${JSON.stringify(manifest)}</script></body></html>`);
  });
  app.get('/assets/colors/:file', (req, res) => {
    const f = files[String(req.params.file)];
    if (!f) return res.status(404).end();
    res.type('image/jpeg').send(f);
  });
  return app;
}
