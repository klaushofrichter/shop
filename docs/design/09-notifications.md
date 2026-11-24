# 9. Notifications

Revised for review round 2 (2026-11-25): customer e-mails are part of the launch
(ADR-0027), per parcel, with "find my order" and bounce handling. Amazon SES (ADR-0015).

## 1. Customer e-mails

| E-mail | When | Content |
|---|---|---|
| Order confirmation | payment recorded | Order number, items by picture, totals as paid, ship-to, the status link, what happens next |
| Shipped | each `shipment_sent` (one e-mail per parcel; key `(order, shipped, shipment id)`) | Carrier, tracking number and link, the items in this parcel, estimated delivery, "the rest follows separately" for split orders |
| Delayed | a hold or failure older than `DELAY_NOTICE_HOURS` | "Your order is delayed; we're on it" with the status link; no internal reasons |
| Refunded / cancelled | full refund or cancellation | Amount and a plain reason ("we couldn't produce this order") |
| Your order link | "find my order" request that matched ([03 §8](03-customer-journey.md#8-find-my-order)) | The status link only |

- Sent by the `email.send` job, at most once per key, retried up to 5 times.
- Plain, accessible HTML plus a text part; no tracking pixels, no marketing, no third-party images.
- From an address on `shop.klaushofrichter.net` with SPF and DKIM (records at Squarespace: Klaus); SES production access requested before go-live.
- **Bounces and complaints**: SES notifications are recorded on the order (`email_bounced_at`) and shown in the admin, because a mistyped address means the customer hears nothing.
- `EMAIL_ENABLED` is a kill switch. In `mock` and `test` mode, mail goes only to an allow-list.
- Printful sends nothing to the customer: it gets no e-mail address (ADR-0031). Stripe sends its own payment receipt (turned on in the Dashboard), which names the order (`payment_intent_data.description`).

The texts are part of the implementation and reviewed with the e-mail templates; one
customer vocabulary across e-mails and the status page ([07 §2.5](07-orders-data-jobs.md#25-customer-facing-status-derived)).

## 2. Alerts to Klaus

E-mail via SES from the start; no metrics pipeline at launch (review 1 F29).

| Alert | When |
|---|---|
| New paid order (optional) | payment recorded |
| Hold opened | approval, attention, provider or fraud hold, with all reasons and the deadline; a reminder 24 h before a deadline that refunds |
| Circuit breaker tripped | at once |
| Reconciliation alarms | hourly run with alarms (each alarm at most once per 24 h) |
| Webhook signature failures | more than a few in an hour |
| Backup stale | Litestream replication behind by more than 2 h |
| Configuration | a SKU disabled by the catalog check; a provider file `failed`; source schema mismatch |

Later, if a graph is wanted: the cluster's Grafana Alloy scrapes pods annotated
`k8s.grafana.com/scrape=true` and ships allow-listed metric names; alert rules route to
e-mail and Telegram (Cluster, 2026-11-25). The shop can add `/metrics` then.
