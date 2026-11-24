# 4. Catalog, content sources and print files

Revised for review round 2 (2026-11-25): content sources with a contract (ADR-0035),
launch sizes up to 12 × 16 in both orientations (ADR-0033), display images rendered by
the shop, provider file registration, re-rendering only when the original changes.

## 1. Terms

| Term | Meaning |
|---|---|
| **Source** | A gallery the shop takes works from (art at launch; later e.g. christina-art or instagetter). |
| **Work** | One image from a source, key `(source_id, work_id)`. Painting or photograph (`kind`). |
| **SKU** | A sellable product type, independent of the work: "Framed print 12 × 16 in, black frame". In `config/skus.json` (ADR-0022); one provider variant each. |
| **Offer** | A (work, SKU) Klaus enabled: price, crop, orientation, print file, mockup. |
| **Print file** | The image the provider prints, rendered by the shop at the exact pixel size of the print area. |
| **Display image** | The image the shop shows on its pages, rendered by the shop from the original. |
| **Mockup** | A preview of the product with the work, from Printful's mockup generator. |

## 2. SKUs at launch (ADR-0033)

Klaus (2026-11-25): offer smaller sizes at launch, in landscape and portrait. Printful has
no 9 × 12; its **6 × 8 and 12 × 16 are exactly 3:4**, the shape of the iPhone photos
(4032 × 3024), and 8 × 10 (4:5) suits the paintings. Every size is sold in both
orientations: the work's orientation decides, the variant is the same.

| SKU id | Name shown | Printful product → variant | Print area | DPI | Effective DPI of the measured originals |
|---|---|---|---|---|---|
| `postcard-4x6` | Postcard 4 × 6 in | 433 → 11513 | 6.14 × 4.13 in (bleed) | 300 | ≥ 300 for all |
| `print-6x8` | Art print 6 × 8 in | 1 → 48489 | 6 × 8 | 300 | 349–504 |
| `print-8x10` | Art print 8 × 10 in | 1 → 4463 | 8 × 10 | 300 | 262–378 |
| `print-12x16` | Art print 12 × 16 in | 1 → 1349 | 12 × 16 | 300 | **175–252** |
| `framed-8x10-black` | Framed print 8 × 10 in, black frame | 2 → 4651 | 8 × 10 | 300 | 262–378 |
| `framed-12x16-black` | Framed print 12 × 16 in, black frame | 2 → 1350 | 12 × 16 | 300 | 175–252 |
| `mug-11oz` | Mug 11 oz | 19 → 1320 | 9 × 3.5 wrap | 300 | ≥ 300 |
| `tshirt-white-s` … `-xl` | T-shirt, white, S–XL | 71 → 4011–4014 | front 12 × 16 | 150 | ≥ 150 |

- **`minDpi` for paper: 180** (raised from 150, review 1 F22): every measured original passes at 12 × 16 **except one wide work** (3619 × 2096 px, about 175 DPI in a 3:4 crop; review C F10), whose 12 × 16 offers the admin refuses as designed. Wide works also lose about a quarter of the picture in a 3:4 or 4:5 crop; the admin shows how much is cut. 16 × 20 and larger are deferred; at 144–189 DPI they would fall below 180 for several works.
- Effective DPI is computed per offer from the crop; the admin shows it and refuses offers below `minDpi`.
- Print areas, DPI, placements and variant availability are read from Printful at startup and daily (`/v2/catalog-products/{id}/mockup-styles`, `/v2/catalog-variants/{id}`); a mismatch with the config disables the SKU and alerts.
- Wholesale prices (North America, from the catalog, refreshed daily) feed the admin's margin view and the pre-payment cost check ([05 §2](05-quote-checkout-payment.md#2-quote)). Retail prices are Klaus's; the defaults in `config/skus.json` are placeholders.
- Frame colour: black at launch; white and red oak are one config entry each.

## 3. Offers and prices

- An offer exists when Klaus enables a SKU for a work in the admin. It is **sellable** only when all hold: the work's `prints_allowed` (from the source) and `enabled` (Klaus); the offer `enabled`; a print file rendered and validated; its `provider_files` row `ok`.
- Nothing is enabled by default (review 1 F20). What art's works the shop sells is art's decision (Klaus, 2026-11-25), expressed through `prints_allowed`.
- Price = SKU default or the offer's override; USD, tax-exclusive.

## 4. Content sources

### 4.1 Interface (ADR-0035)

```ts
interface ContentSource {
  readonly id: string;                         // 'art'
  listWorks(): Promise<Work[]>;                // validated, allow-listed
  fetchOriginal(work: Work): Promise<Readable>;
}
interface Work {
  sourceId: string; workId: string;
  title: string; creator?: string; year?: string;
  kind: 'painting' | 'photograph' | 'other';
  canonicalUrl: string;                        // the work's page at the source
  original: { url: string; widthPx?: number; heightPx?: number; version: string };
  printsAllowed: boolean;
}
```

Only the adapter knows a source's format. Nothing else from a source is stored (art's
manifest also carries prices and sale status of originals and an About block; the shop
keeps none of it).

### 4.2 Configuration

`config/sources.json` (public: no secrets), overridable per environment:

```json
[{ "id": "art", "default": true, "adapter": "art-manifest",
   "publicUrl": "https://art.klaushofrichter.net", "clusterUrl": "http://art.art.svc.cluster.local",
   "creator": "Klaus Hofrichter",
   "printsAllowedDefault": false,
   "printsAllowedWorks": ["<work id>", "…"] }]
```

Consent per work, in this order: the source's own per-work flag (a feed, once it exists);
otherwise **`printsAllowedWorks`**, a per-work allow-list in this file filled from the
source owner's decision (for art: Klaus's; review B F5, ADR-0035); otherwise
`printsAllowedDefault`. A second gallery by another artist needs that artist's decision
in its own list; the seller is still Klaus (A3).

### 4.3 The art adapter

- **Today**: parses `<script type="application/json" id="manifest">` from art's home page (fetched in-cluster every 10 minutes, conditional GET). Original URL: `/assets/<room>/<file>?v=<v>` (ADR-0025); the work's permalink at art is `/?id=<uid>`. `kind` from the room (art's "Colors" room = paintings, the others = photographs) until art supplies it.
- **Contract test**: the adapter runs in CI against a recorded copy of art's manifest (`test/fixtures/art/home.html`). Every refresh (every 10 minutes) validates the live manifest and records skipped works as problems (`settings`, key `source_problems:<id>`); alerts on them arrive with step 8.
- **Proposed for art** (art's repository and decision): a versioned feed, e.g. `/feed/works.v1.json`, with exactly the `Work` fields and a per-work `printsAllowed` flag. The adapter switches to it when it exists; the shop then needs no knowledge of art's page markup.
- Later sources (christina-art, instagetter) are one adapter each. Insta-style sources bring small square images (612–1440 px): only postcards, mugs and t-shirts pass the DPI floor; titles come from the admin (`works.title_override`); opt-in per image. For a large source, originals are fetched and hashed and display images rendered **only for works Klaus opens or enables**; the admin's list uses an admin-only thumbnail route that fetches and resizes on demand (review C F18).

### 4.4 Routes

`/p/<source>/<work>` is the canonical picture page; `/p/<work>` stays as the alias for the
default source, so art's link (ADR-0009) doesn't change. `GET /api/offers?source=art`
lists that source's work ids with at least one sellable offer.

### 4.5 Changes at the source

- When a source's `version` changes (art's `v` also changes when only derivatives are rebuilt), the shop fetches the original (of opened or enabled works) and hashes it; **only a changed SHA-256** re-renders print files, display images and mockups (review 2 F4). Otherwise only `source_version` is updated.
- A work that disappears from the source is hidden (offers kept); open orders are unaffected (order items hold copies).

## 5. Print files

### 5.1 Source
The original comes from the source adapter (art: its public URL, read in-cluster). It is
streamed to a temporary file and deleted after rendering. Override: an uploaded print
master per work (size and type limits, below).

### 5.2 Rendering (`sharp`)
1. Decode with `limitInputPixels` (decompression bombs), apply EXIF orientation, convert to **sRGB** from the embedded profile (34 of 35 originals are Display P3; none → sRGB).
2. Crop to the print area's aspect ratio in the offer's orientation: centred by default, or one of nine anchor positions chosen in the admin (review 1 F29: no draggable box at launch). Mug: the work twice, left and right of the handle; t-shirt: fit inside the area, PNG with transparency.
3. Resize (Lanczos3) to the exact pixel size; JPEG quality 92, 4:4:4, sRGB ICC embedded, **all other metadata stripped**.
4. Validate: exact size, 8-bit, sRGB, < 200 MB, effective DPI ≥ `minDpi`. Hash (SHA-256), store atomically at `files/<sha256>.jpg`.

Render key: (source, work, original SHA-256, SKU, orientation, crop, renderer version).

### 5.3 Registration at the provider (review 2 F2)
Job `printfile.register`: `POST /v2/files` with the file's URL, `role: printfile`,
**`visible: false`** (not shown in Printful's file library; review 1 F22), then poll until
`ok` or `failed` (~10 s captured). `ok` → the offer can become sellable; `failed` → the
offer stays unsellable and Klaus is alerted. Library entries can't be deleted through the
API; with `visible: false` they don't clutter the library view.

### 5.4 Serving to Printful
`<PUBLIC_URL>/files/<sha256>.jpg`: immutable (`Cache-Control: public,
max-age=31536000, immutable`), no listing, `X-Robots-Tag: noindex`. Printful fetches it
when the order is created and again for reprints, so files referenced by an order are
kept at least 12 months after delivery. The URL is unguessable; the same pixels are
public on art anyway (ADR-0025).

### 5.5 Uploaded masters
JPEG or PNG only, ≤ 100 MB, at most `MAX_INPUT_MEGAPIXELS` (one value from the memory test, about 50 MP, used for uploads and source originals alike and as `limitInputPixels`; review C F9),
re-encoded like every served image.

## 6. Display images

The shop renders its own display images (ADR-0035, review 1 F21): widths 640, 1024,
1536 as WebP and JPEG, re-encoded with **no metadata**, served from `/img/<sha256>.<ext>`
(immutable). Pages don't depend on art's URL scheme or uptime, the CSP stays
`img-src 'self'`, and Lighthouse has no third-party origin. One test asserts that no
image type the shop serves carries metadata.

## 7. Previews (mockups)

For each sellable offer, a `mockup.create` job (`POST /v2/mockup-tasks` with the print
file URL, the SKU's placement and `orientation`, `format: jpg`, `mockup_width_px: 1000`),
polled until `completed` (~20 s captured), stored as `/mockups/<sha256>.jpg`. Paced at one
task per 30 s (Printful allows 2–10 per minute). A missing mockup falls back to the
display image in a CSS frame. Mockups are made once per offer and print file, never per
visitor.

## 8. Availability

Daily: each SKU's variant availability for the enabled shipping region; an unavailable
SKU is hidden and Klaus is told once.
