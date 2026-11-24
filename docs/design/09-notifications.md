# 9. Notifications

Revised for review round 2 (2026-11-25): customer e-mails are part of the launch
(ADR-0027), per parcel, with "find my order" and bounce handling. Amazon SES (ADR-0015).
Round 2 fold-in (2026-11-26): status links computed, bounces forwarded by SES, no
customer data in alerts.

## 1. Customer e-mails

| E-mail | When | Content |
|---|---|---|
| Order confirmation | payment recorded | Order number, items by picture, totals as paid, ship-to (name, city, state), the status link, what happens next |
| Shipped | each `shipment_sent` (one e-mail per parcel; key `(order, shipped, shipment id)`) | Carrier, tracking number and link, the items in this parcel, estimated delivery, "the rest follows separately" for split orders |
| Delayed | a hold or failure older than `DELAY_NOTICE_HOURS`, **only before the first shipment** | "Your order is delayed; we're on it" with the status link; no internal reasons |
| Refunded / cancelled | full refund or cancellation | Amount and a plain reason ("we couldn't produce this order"); for a mixed cart refunded because one item couldn't be made, that nothing ships |
| Your order link | "find my order" request that matched ([03 §8](03-customer-journey.md#8-find-my-order)); key `(order, link, request id)`, so a second request sends again | The status link only |

- Sent by the `email.send` job, at most once per key, retried up to 5 times. Every e-mail carries the status link, computed from the order id with `STATUS_TOKEN_SECRET` ([07 §1](07-orders-data-jobs.md#1-identifiers)); earlier links keep working. An admin resend uses a fresh key.
- Plain, accessible HTML plus a text part; no tracking pixels, no marketing, no third-party images.
- From an address on `shop.klaushofrichter.net` with SPF and DKIM (records at Squarespace: Klaus); SES production access requested before go-live.
- **Bounces and complaints**: SES forwards its notices by e-mail to the shop's sending address, which reaches Klaus's mailbox (review C, Klaus 2026-11-26). No queue, no endpoint, no polling; Klaus fixes a mistyped address from the notice (the bounce names the order number in the subject). A queue is added only if bounces become frequent.
- `EMAIL_ENABLED` is a kill switch. In `mock` and `test` mode, mail goes only to an allow-list.
- Printful sends nothing to the customer: it gets no e-mail address (ADR-0031). Stripe sends its own payment receipt (turned on in the Dashboard), which names the order (`payment_intent_data.description`).

The texts are part of the implementation and reviewed with the e-mail templates; one
customer vocabulary across e-mails and the status page ([07 §2.6](07-orders-data-jobs.md#26-customer-facing-status-derived)).

## 2. Alerts to Klaus

E-mail via SES from the start; no metrics pipeline at launch (review 1 F29).

| Alert | When |
|---|---|
| New paid order (optional) | payment recorded |
| Hold opened | approval, attention, provider or fraud hold, with all reasons and the deadline; a reminder 24 h before a deadline that refunds; daily while a provider hold lasts |
| Circuit breaker tripped | at once |
| Reconciliation alarms | hourly run with alarms (each alarm at most once per 24 h) |
| Webhook signature failures | more than a few in an hour |
| Backup stale | Litestream replication behind by more than 2 h |
| Configuration | a SKU disabled by the catalog check; a provider file `failed`; source schema mismatch; Printful unverified for 30 min after a start |

Alerts carry the order number and an admin link, never the customer's name, address or
e-mail (review C F14). If the runner or SES itself fails, the uptime monitor's check of
`/health/worker` is the second channel ([11 §4](11-operations.md#4-observability)).

Later, if a graph is wanted: the cluster's Grafana Alloy scrapes pods annotated
`k8s.grafana.com/scrape=true` and ships allow-listed metric names; alert rules route to
e-mail and Telegram (Cluster, 2026-11-25). The shop can add `/metrics` then.
