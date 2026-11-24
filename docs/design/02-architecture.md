# 2. Architecture

Revised for review round 2 (2026-11-25): content sources beside fulfilment providers,
a cart, separate payment and fulfilment state, modes with a Printful test store,
customer e-mails, display images rendered by the shop.

## 1. Context

```
  visitor ──► art.klaushofrichter.net (gallery; later other galleries)
                │  works: manifest today, a feed later          ◄─── shop reads works and originals
                │  "Prints & merchandise" link if /api/offers lists the work         (in-cluster)
                ▼
  visitor ──► shop.klaushofrichter.net ─────────────────────────────────────────────┐
  Klaus  ──►   public pages, cart, /admin, webhooks, job runner                     │
               SQLite per mode + files on a PVC ── Litestream ──► S3                │
                 │ ▲                               │ ▲                    │         │
                 ▼ │ webhooks                      ▼ │ webhooks           ▼         │
               Printful API v2                   Stripe API             Amazon SES  │
               (live store / test store)        (live / test mode)    (e-mails)     │
```

Boundaries:
- **Galleries** stay content sites without secrets (ADR-0002). art's only change is the link (ADR-0009); originals are read from its public URLs (ADR-0025). What a gallery allows to be sold is its decision (a per-work flag).
- **The shop** owns orders: its database, print files and display images, the keys for Stripe, Printful and SES, the admin.
- **Stripe** owns card data and payment state; **Printful** owns production and shipment state. The shop mirrors both and trusts their APIs over webhooks.

## 2. Components

One Node 26 process (ADR-0004):

| Module | Responsibility |
|---|---|
| `web/public` | Picture pages, cart, quote, checkout redirect, order status, find my order, legal pages; preview gate in non-live modes |
| `web/admin` | Google sign-in (PKCE), works, offers, orders, holds, system |
| `web/webhooks` | `/webhooks/stripe`, `/webhooks/printful`: verify, store, enqueue, 200 |
| `sources` | `ContentSource` interface and the art adapter (ADR-0035) |
| `catalog` | SKU config (ADR-0022, ADR-0033), offers, sellability, wholesale prices |
| `images` | Print files, display images, mockups; provider file registration (ADR-0019) |
| `quote` | Local address checks, shipping rates, pre-payment cost check (ADR-0036) |
| `payment` | Stripe: Customers, Checkout Sessions, refunds, re-fetch; pinned API version |
| `fulfilment` | `FulfilmentProvider` interface and the Printful adapter (ADR-0017) |
| `orders` | Payment, fulfilment and dispute state; holds; invariants; event ledger (ADR-0034, ADR-0018) |
| `jobs` | Jobs table, in-process runner, the `Clock` |
| `notify` | Customer e-mails and alerts via SES (ADR-0015, ADR-0027) |
| `db` | `node:sqlite`, migrations, one file per mode (ADR-0029) |

## 3. End-to-end process

```
Visitor             Shop                              Stripe               Printful
 │ /p/<work>         │ display image, offers, mockups  │                     │
 │ add to cart (×n)  │ cart rows (any pictures)        │                     │
 │ address           │ local ZIP↔state, ──────────────────── shipping-rates ►│
 │◄── quote ─────────│ pre-payment cost check, quote   │                     │
 │ Pay               │ order (checkout_open), Customer ►                     │
 │◄── 303 ───────────│ Checkout Session (30 min) ─────►│                     │
 │──── pays ─────────┼────────────────────────────────►│                     │
 │◄── success_url ───│◄── checkout.session.completed ──│                     │
 │ status page       │ re-fetch → payment paid         │                     │
 │◄── confirmation ──│ fail-safe check (holds?)        │                     │
 │    e-mail         │ submit: claim → lookup → draft ─┼────────────────────►│ draft
 │                   │ costs done → cost guard         │                     │
 │                   │ confirm_requested_at → confirm ─┼────────────────────►│ pending…
 │                   │◄────────────────────────────────┼── shipment_sent ────│ (per parcel)
 │◄── shipped e-mail │ re-fetch shipments, tracking    │                     │
 │    (per parcel)   │◄────────────────────────────────┼── shipment_delivered│
```

## 4. Runtime

- Kubernetes Deployment, namespace `shop`, `replicas: 1`, `Recreate`, image by digest, memory 256 Mi request / 512 Mi limit.
- Retain PVC at `/var/lib/shop`: the mode's database file, `files/`, `img/`, `mockups/`.
- Litestream sidecar to a new S3 bucket; Velero as a second line (ADR-0014).
- Own Ingress and Certificate; compression in the app; strict CSP (`img-src 'self'`).
- Egress: HTTPS to public addresses (Printful, Stripe, S3, SES) and art's pods; default-deny NetworkPolicy ([11 §1](11-operations.md#1-deployment)).
- Modes `mock`, `test`, `live` (ADR-0029): which services, keys, store and database file are used.
- One process suffices: < 10 orders a week; the heaviest work (rendering a 3600 × 4800 print file) happens when an offer is set up, not per visitor.

## 5. Key design choices

| Choice | Why | ADR |
|---|---|---|
| Separate service; galleries unchanged except a link | galleries stay public and secret-free | 0002, 0009 |
| Build, borrowing Pressline's patterns | deep link from the work, own pages, sources that can't be set up by hand elsewhere | 0003 |
| Node 26, Express, server-rendered, SQLite, plain Deployment | the cluster's stack | 0004 |
| Printful v2 behind `FulfilmentProvider`; v1 only to cancel | print areas, signed webhooks, draft/confirm | 0005, 0017 |
| Works through `ContentSource`, keyed by `(source, id)`; the shop renders its own display images | a second gallery without migration; no dependency on a gallery's markup or uptime | 0035, 0025 |
| Address once on the shop's page; Stripe hosted Checkout; webhook endpoints with the pinned version | shipping depends on the address; Stripe's page can't recompute it; payloads in a known shape | 0007, 0023, 0030 |
| Local address and cost checks before payment | one Printful call per quote; misconfigured prices never reach a payment | 0036 |
| A cart with any pictures | one order, one shipping charge | 0026 |
| Predefined SKUs in config, up to 12 × 16, both orientations | R3, R22; every original reaches 180 DPI | 0022, 0033 |
| Payment, fulfilment and dispute state separate; holds with deadlines; invariants | no stranded money, no double fulfilment, no routine work | 0034, 0018, 0020 |
| Print files registered at the provider before sale; immutable URLs | Printful accepts broken file URLs on drafts | 0019 |
| Modes with a database file and a Printful store per mode | test orders can't meet live reconciliation or the live store | 0029 |
| Minimal personal data to third parties | R20 | 0031 |
| Customer e-mails at launch | the customer always has the order link | 0027 |
| Mock services verified against recordings | CI and test deployments without real transactions | 0024 |

## 6. Alternatives to building it

Compared in [research/process-alternatives.md](../research/process-alternatives.md);
both reviews confirmed building (ADR-0003). Review 1 corrected the basis: on money alone
a hosted store (Shopify Starter) wins; what carries the decision is the deep link from a
work, the shop's own pages, and sources whose works can't be set up by hand in a hosted
store.
