# 9. Notifications

Customer emails are **optional for launch** (R8). Alerts to Klaus are not: without
them, exceptions would go unnoticed (Q2).

## 1. Customers

What a customer gets without any email of ours:
- Stripe's **receipt** (turn on "Successful payments" emails in the Stripe Dashboard): amount, items, the shop's name.
- The **order status page** link, shown on the success page with a "bookmark this page" hint. Stripe's receipt can't carry our link, so without our emails a customer who loses the page asks by email (contact page) and Klaus sends the link from the admin: a rare manual case, and the reason to enable the confirmation email early.

With email enabled (`EMAIL_ENABLED=true`, provider per ADR-0015):

| Email | When | Content |
|---|---|---|
| Order confirmation | `paid` | Order number, items, totals, ship-to, status page link |
| Shipped | each `shipment_sent` | Carrier, tracking number and link, items in this parcel, estimated delivery |
| Delayed | `needs_attention` or `on_hold` > 24 h | "Your order is delayed; we're on it" |
| Refunded | `refunded` | Amount, reason in plain words |

- Sent by the `email.send` job, at most once per (order, kind[, shipment]), retried up to 5 times.
- Plain, accessible HTML + text alternative; no tracking pixels, no marketing.
- From `orders@shop.klaushofrichter.net` (SPF, DKIM at Squarespace DNS: Klaus).
- Printful does not, as far as we found, email end customers for API stores; its public tracking page exists, and the `tracking_url` from the shipment points to the carrier.

## 2. Klaus

| Alert | When |
|---|---|
| New paid order (optional, `NOTIFY_EACH_ORDER`) | `paid` |
| Needs attention | cost guard, retries exhausted, permanent failure (FYI: already refunded) |
| Billing hold at Printful | at once (only he can fix it) |
| Returned parcel, dispute | at once |
| Reconciliation alarms | hourly run with alarms > 0 (deduplicated: one email per alarm per 24 h) |
| Backup stale | Litestream > 2 h behind |

Channel: email via the same provider once ADR-0015 is decided. Until then, alerts go
through what the cluster already uses for alerting (Grafana Cloud: the shop exposes
`shop_alarms` and `shop_orders{state}` metrics on `/metrics` for the cluster's
scraper, and a Grafana alert rule notifies Klaus). The Cluster session wires the rule.
