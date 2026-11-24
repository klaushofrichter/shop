# 4. Catalog, SKUs and print files

## 1. Terms

| Term | Meaning |
|---|---|
| **Picture** | A painting from art's manifest, key `uid`. |
| **SKU** | A sellable product type, independent of the picture: "Framed print 8 × 10 in, black frame". Defined in configuration (ADR-0022). Maps to exactly one provider variant. |
| **Offer** | A (picture, SKU) pair that Klaus enabled, with its price, crop settings, print file and mockup. What the customer can buy. |
| **Print file** | The image Printful prints, rendered by the shop for one offer at the exact pixel size of the SKU's print area. |
| **Mockup** | A preview image of the product with the picture on it, made by Printful's mockup generator. |

## 2. SKUs

A handful of predefined SKUs (R3), in `config/skus.json`, validated at startup
(the process refuses to start on an invalid file). Adding a SKU = adding an entry
+ a deploy; no schema change. Initial set (wholesale = Printful v2 North-America
price measured 2026-11-24 where available, else v1 list price; shipping extra):

| SKU id | Name shown | Provider product → variant | Placement, technique | Print area | File px (exact) | DPI | Wholesale |
|---|---|---|---|---|---|---|---|
| `postcard-4x6` | Postcard 4 × 6 in | Printful 433 → 11513 | default, digital | 6.14 × 4.13 in (with bleed) | 1842 × 1240 | 300 | $1.53 |
| `print-8x10` | Art print 8 × 10 in | Printful 1 → 4463 | default, digital | 8 × 10 in | 2400 × 3000 | 300 | ~$7.03 |
| `print-16x20` | Art print 16 × 20 in | Printful 1 → 3877 | default, digital | 16 × 20 in | 4800 × 6000 | 300 | ~$12.13 |
| `framed-8x10-black` | Framed print 8 × 10 in, black frame | Printful 2 → 4651 | default, digital | 8 × 10 in | 2400 × 3000 | 300 | $20.76 |
| `framed-16x20-black` | Framed print 16 × 20 in, black frame | Printful 2 → 4399 | default, digital | 16 × 20 in | 4800 × 6000 | 300 | $42.61 |
| `mug-11oz` | Mug 11 oz | Printful 19 → 1320 | default, sublimation | 9 × 3.5 in wrap | 2700 × 1050 | 300 | $6.95 |
| `tshirt-white-s` … `-xl` | T-shirt, white, S / M / L / XL | Printful 71 (Bella+Canvas 3001) → 4011 / 4012 / 4013 / 4014 | front, dtg | 12 × 16 in | 1800 × 2400 | 150 | $11.95 |

Notes:
- The 8×10 and 16×20 sizes have the 4:5 ratio of most of the paintings (many are 10 × 8 in), so they print the whole painting.
- Pixel sizes, DPI and placement names are **read from Printful at startup** (`/v2/catalog-products/{id}/mockup-styles` and `/v2/catalog-variants/{id}`) and compared with the config; a mismatch or an unavailable variant disables that SKU and alerts Klaus. The table is the expected state, not hard-coded truth.
- Postcard orientation follows the picture (Printful accepts 6.14 × 4.13 or 4.13 × 6.14). Prints and framed prints are ordered portrait or landscape to match the picture: Printful's variant is the size; orientation comes from the file (`orientation` field on the order item, *(verify)* with a draft order).
- Frame colour: black at launch; white and red oak are other variants at the same price (one config entry each).

SKU entry shape:

```json
{
  "id": "framed-8x10-black",
  "name": "Framed print 8 × 10 in, black frame",
  "kind": "framed",
  "provider": "printful",
  "providerProductId": 2,
  "providerVariantId": 4651,
  "placement": "default",
  "technique": "digital",
  "printArea": { "widthIn": 8, "heightIn": 10, "dpi": 300 },
  "orientation": "match-picture",
  "fit": "fill",
  "minDpi": 150,
  "defaultPriceCents": 5900,
  "mockupStyleId": null,
  "shippingClass": "large",
  "maxQuantity": 5
}
```

## 3. Offers and prices

- An offer exists when Klaus enables a SKU for a picture in the admin ([08](08-admin.md)). Enabling is refused if the picture's original is too small for the SKU's `minDpi` (§5.3).
- **Price** = the SKU's `defaultPriceCents`, or a per-offer override. USD, tax-exclusive (ADR-0012 decides whether Stripe adds tax).
- The admin shows, per offer: wholesale (Printful, refreshed daily), typical US shipping, Stripe fee (2.9% + 30¢), and the margin. Prices are Klaus's decision; the defaults in `config/skus.json` are placeholders until he sets them.
- **Price changes** at Printful (`catalog_price_changed` webhook, daily refresh) never change what a customer is charged on an open quote; they show up in the admin margin view, and an alert goes to Klaus if a margin turns negative.

## 4. Pictures (from art)

- The shop reads art's manifest from `https://art.klaushofrichter.net/` (`<script type="application/json" id="manifest">`), every 10 minutes, conditional GET (ETag), and on demand from the admin. In-cluster it may use `http://art.art.svc.cluster.local/` instead.
- Kept per picture: `uid`, `slug`, `title`, `date`, `artist`, `medium`, `dimensions`, `v` (content hash), `widths`, the original's `status` (for the "original available" line).
- Public images shown in the shop come from art's public derivatives (`/img/...` URLs as art serves them). The shop does not re-host them.
- If a picture disappears from the manifest, its offers are hidden (not deleted); open orders are unaffected because order items hold copies.
- If `v` (content hash) changes, the shop re-renders that picture's print files and mockups (a job), and alerts Klaus to re-check crops.

## 5. Print files

### 5.1 Source

The original is fetched from art **in-cluster**:
`GET http://art.art.svc.cluster.local/internal/originals/<uid>` with
`Authorization: Bearer <ART_INTERNAL_TOKEN>` (ADR-0006). art must also refuse
`/internal/*` on its public route. The original is streamed to a temporary file,
used, and deleted; the shop does not keep originals.

Override: Klaus can upload a print master for a picture (or for one offer) in the
admin, e.g. a better scan or a pre-cropped file. An uploaded master is stored on
the shop's volume and used instead of art's original.

### 5.2 Rendering

One print file per offer, rendered by a job with `sharp`:

1. Decode the original; apply EXIF orientation; convert to **sRGB** using the embedded ICC profile (camera files may be Adobe RGB).
2. Crop to the print area's aspect ratio. The crop is the offer's **crop box** (set in the admin, stored as fractions of the original), defaulting to:
   - `fill` (prints, framed prints, postcards): the largest centred box with the target ratio;
   - `fit` (mug, t-shirt): no crop; the whole picture is scaled to fit inside the area, the rest filled with white (mug) or left transparent (t-shirt, PNG with alpha, DTG allows it).
   - Mug layout: the picture appears twice, centred left and right of the handle, each fitting the 3.5 in height.
3. Resize (Lanczos3) to the exact pixel size of §2.
4. Encode: JPEG quality 92, 4:4:4 chroma, sRGB ICC embedded, EXIF stripped (no GPS or camera data). T-shirt: PNG.
5. Validate (§5.3), hash (SHA-256 of the bytes), store at `/var/lib/shop/files/<sha256>.jpg|png` with an atomic write (random temp name + rename, cluster rule).

The render key is (uid, picture `v`, SKU id, crop box, renderer version). The same
key always gives the same file and URL.

### 5.3 Validation

A print file is accepted only if:
- exact pixel size for the SKU; 8-bit; sRGB; no CMYK or grayscale profile; no alpha for paper and sublimation;
- under 200 MB (Pressline found a 213 MB file silently ignored by Printful);
- **effective DPI** ≥ the SKU's `minDpi`, where effective DPI = (crop width in source pixels) ÷ (print width in inches). Below 200 DPI on paper the admin shows a warning; below `minDpi` the offer can't be enabled.

Measured need for the 4:5 paintings: 8 × 10 at 150 DPI needs a 1200 × 1500 px crop; 16 × 20 needs 2400 × 3000. Camera JPEGs (typically 12–24 MP) cover both; this is assumption A2 and is checked per picture by the admin.

### 5.4 Serving to Printful

- URL: `https://shop.klaushofrichter.net/files/<sha256>.jpg`. Immutable (`Cache-Control: public, max-age=31536000, immutable`), no directory listing, 404 for unknown hashes, `X-Robots-Tag: noindex`.
- Printful fetches it when the order is created and again for reprints (ADR-0019), so files are kept as long as any order references them, plus 1 year.
- The URL is unguessable (256-bit hash) but not secret once shared with Printful. Anyone holding it has a full-resolution reproduction. Accepted risk (ADR-0019); the URLs appear only in Printful requests and the admin.
- Alternative kept open: register the file once in Printful's file library (`POST /v2/files`) and reference its id. It still needs the URL once.

## 6. Previews (mockups)

- For each offer, a job creates a Printful mockup task (`POST /v2/mockup-tasks`) with the print file URL, the SKU's placement and `mockupStyleId`, `format: jpg`, `mockup_width_px: 1000`.
- The job polls `GET /v2/mockup-tasks?id=…` (or receives `mockup_task_finished`), downloads the mockup, stores it at `/var/lib/shop/mockups/<sha256>.jpg`, and serves it publicly at `/mockups/<sha256>.jpg` (cacheable; Printful's own URLs are temporary).
- **Rate limit**: Printful allows 2–10 mockup tasks per minute per store. The job runner paces mockup tasks at one per 30 seconds and backs off on 429. 25 pictures × 10 SKUs = 250 tasks ≈ 2 hours, once.
- Mockups are made when an offer is enabled or its print file changes, never per visitor.
- If a mockup is missing or failed, the picture page shows a plain preview of the crop (the print file scaled down, framed by CSS) so the offer still sells. Mockups are a nicety, not a gate (R5 "where possible").

## 7. Availability

- Daily, and on `catalog_stock_updated`, the shop checks each SKU's variant availability for the enabled shipping regions (`/v2/catalog-variants/{id}/availability`). An unavailable SKU is hidden everywhere and Klaus is told once.
- An item that becomes unavailable between quote and payment is caught at `POST /checkout` (re-validation); after payment it surfaces as a Printful order failure ([06 §7](06-fulfilment.md#7-failure-handling)).
