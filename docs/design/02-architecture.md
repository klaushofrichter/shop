# 2. Architecture

## 1. Context

```
                    ┌──────────────────────────────┐
  visitor ─────────►│ art.klaushofrichter.net      │  public gallery (Knative service, namespace art)
                    │  manifest (uid, title, …)    │  "Prints & merchandise" link per painting
                    │  /assets/<room>/<file> (orig)│◄──────────────┐ public; read in-cluster
                    └──────────────┬───────────────┘               │
                                   │ link /p/<uid>                  │
                    ┌──────────────▼───────────────┐               │
  visitor ─────────►│ shop.klaushofrichter.net     │───────────────┘
  Klaus (admin) ───►│  public pages, /admin        │
                    │  job runner                  │──► Printful API v2  (catalog, shipping rates,
                    │  SQLite + files on a PVC     │◄── Printful webhooks  orders, mockups, files)
                    │  Litestream ──► S3           │──► Stripe API       (customers, checkout sessions,
                    └──────────────────────────────┘◄── Stripe webhooks   refunds)
                                   │
                                   └──► email provider (optional, ADR-0015)
```

Boundaries:
- **art** stays a static-content gallery without secrets (ADR-0002). Its only change: the link per painting (ADR-0009). The shop reads originals from art's existing public URLs (ADR-0025).
- **The shop** owns everything about orders: its database, print files, secrets for Stripe and Printful, the admin.
- **Stripe** owns card data and payment state. **Printful** owns production and shipment state. The shop mirrors both and treats their APIs as the truth when they disagree with a webhook.

## 2. Components inside the shop

One Node 26 process (ADR-0004), modules:

| Module | Responsibility |
|---|---|
| `web/public` | Server-rendered pages: picture page, quote, checkout redirect, order status, legal pages. |
| `web/admin` | Google sign-in and the admin pages (ADR-0013). |
| `web/webhooks` | `/webhooks/stripe`, `/webhooks/printful`: verify, store, enqueue, answer 200. |
| `catalog` | Reads the SKU config (ADR-0022) and art's manifest; resolves "what does picture X offer at what price". |
| `printfiles` | Fetches originals from art, renders and validates print files, stores them content-addressed (ADR-0019). |
| `quote` | Calls the provider for shipping rates; computes totals; stores quotes. |
| `payment` | Stripe client: Customer, Checkout Session, refunds, event re-fetch. |
| `fulfilment` | Provider interface + Printful adapter (ADR-0017). |
| `orders` | State machine, transitions, the inbound-event ledger (ADR-0018). |
| `jobs` | A jobs table and an in-process runner: submit orders, render files, generate mockups, poll, reconcile, send email. |
| `db` | SQLite via `node:sqlite` (built into Node 26) with migrations; WAL mode. |
| `notify` | Customer emails (optional) and alerts to Klaus. |

## 3. End-to-end process

```
Visitor            Shop                         Stripe                 Printful
  │ /p/<uid>        │                              │                       │
  ├────────────────►│ picture + offers + mockups   │                       │
  │ choose items    │                              │                       │
  ├────────────────►│ cart (cookie, server rows)   │                       │
  │ address         │                              │                       │
  ├────────────────►│ POST /v2/shipping-rates ─────┼──────────────────────►│
  │                 │◄─────────────────────────────┼─────── rates ─────────┤
  │◄── quote ───────┤ quote row (30 min)           │                       │
  │ Pay             │                              │                       │
  ├────────────────►│ order row (checkout_open)    │                       │
  │                 │ Customer + Checkout Session ►│                       │
  │◄── 303 ─────────┤                              │                       │
  ├─────────────────┼──── pays on Stripe ─────────►│                       │
  │◄── return url ──┼──────────────────────────────┤                       │
  │ status page     │◄── checkout.session.completed┤                       │
  │                 │ verify, re-fetch, → paid     │                       │
  │                 │ job: submit ─────────────────┼─ POST /v2/orders ────►│ draft
  │                 │    wait for costs, cost guard│                       │
  │                 │    ──────────────────────────┼─ POST …/confirmation ►│ pending → inprocess
  │                 │◄─────────────────────────────┼─── shipment_sent ─────┤ tracking
  │◄── email (opt.) ┤ → shipped, tracking stored   │                       │
  │                 │◄─────────────────────────────┼─ shipment_delivered ──┤
```

Details: [03](03-customer-journey.md) (pages), [05](05-quote-checkout-payment.md) (quote and payment), [06](06-fulfilment.md) (fulfilment), [07](07-orders-data-jobs.md) (states and jobs).

## 4. Runtime

- **Kubernetes Deployment** in namespace `shop`, `replicas: 1`, `strategy: Recreate`, image pinned by digest (the cluster's shape for a single SQLite writer, as cams-admin and games-cloud).
- **Volume**: a Retain PVC (local-path, RWO) mounted at `/var/lib/shop` with `shop.db` and `files/` (print files, mockups).
- **Litestream** as a native sidecar replicating `shop.db` to a new S3 bucket; Velero file-system backup of the PVC as a second line (ADR-0014).
- **Ingress**: own Ingress + Certificate for `shop.klaushofrichter.net` (DNS done by Klaus 2026-11-24); compression in the app.
- **Egress**: `api.printful.com`, `api.stripe.com`, S3, the email provider (all HTTPS), and art in-cluster (`art.art.svc.cluster.local`). Enforced by a default-deny NetworkPolicy: HTTPS to public addresses only (not the cluster or LAN ranges), plus art's pods ([11 §1](11-operations.md#1-deployment)).
- **Why one process is enough**: < 10 orders a week means a few hundred requests a day. The heaviest work (rendering a 6000×7500 px print file with `sharp`) takes seconds and happens when a picture is set up, not per visitor.

## 5. Key design choices

| Choice | Why | ADR |
|---|---|---|
| Separate service, art untouched except a link | art stays fast, public, secret-free | 0002 |
| Build a small service, borrow Pressline's patterns | No open-source project fits; the patterns are known | 0003 |
| Node 26, Express, server-rendered, SQLite, plain Deployment | The cluster's stack and runbooks | 0004 |
| Printful API v2 behind an adapter; v1 only to cancel | Print areas, signed webhooks, draft/confirm | 0005, 0017 |
| Originals read from art's existing public URL | art already publishes them; no endpoint or token needed | 0025 |
| Address and quote on the shop's page, then Stripe hosted Checkout | Shipping depends on address; hosted page can't recompute it | 0007, 0023 |
| One picture per order, several products | Klaus's flow (R2); simpler pages and print files | 0008 |
| A handful of predefined SKUs in a config file | R3; no catalog browser needed | 0022 |
| Order ledger, idempotent submit, hourly reconciliation | Q1, Q2 | 0018 |
| Print files validated before sale; immutable URLs | Printful re-fetches files for reprints | 0019 |

## 6. Alternatives to building it

Building is not the only way to sell print-on-demand products of the paintings. The
common alternatives (hosted stores and marketplaces with Printful integrations) are
compared in [research/process-alternatives.md](../research/process-alternatives.md),
against R1–R15. Summary and recommendation: see that document's last section; the
review should confirm or overturn ADR-0003 with it.
