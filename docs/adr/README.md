# Architecture decision records

Every decision about the shop is recorded here, one file per decision, numbered in order and never renumbered.

## Status

- **Proposed**: written up by the agent, awaiting Klaus's decision.
- **Accepted**: Klaus decided. The record states when.
- **Rejected**: considered and not taken. Kept for the reasoning.
- **Superseded by ADR-NNNN**: replaced by a later decision. The old record stays unchanged except for its status line.

Only Klaus moves a record from Proposed to Accepted or Rejected. An agent's message is never his decision.

## Format

Copy [template.md](template.md). Keep a record short: context, the decision, the options considered, consequences. Do not edit the substance of an Accepted record; write a new one that supersedes it.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted (2026-11-24) |
| [0002](0002-separate-shop-service.md) | Shop is a separate service, not part of art | Accepted (2026-11-24) |
| [0003](0003-build-not-adapt.md) | Build the shop, borrow patterns from Pressline | Accepted (2026-11-24) |
| [0004](0004-stack-and-runtime.md) | Stack and runtime: Node 26, server-rendered, plain Deployment | Accepted (2026-11-24) |
| [0005](0005-printful-api-v2.md) | Printful API v2, behind a thin adapter | Accepted (2026-11-24) |
| [0006](0006-originals-access.md) | Print files come from art's originals through an internal endpoint | Accepted (2026-11-24) |
| [0007](0007-checkout-and-shipping-quote.md) | Stripe hosted Checkout, shipping quoted on the shop's own page | Accepted (2026-11-24) |
| [0008](0008-cart.md) | Several products of one picture per order | Accepted (2026-11-24) |
| [0009](0009-art-to-shop-handoff.md) | From art to the shop: a link with the work's uid | Accepted (2026-11-24) |
| [0010](0010-order-failure-and-refunds.md) | Order failures after payment: retry, then Klaus, then refund | Proposed |
| [0011](0011-currency-and-shipping-region.md) | Currency USD, shipping region to decide | Proposed |
| [0012](0012-sales-tax-and-vat.md) | Sales tax and VAT | Proposed |
| [0013](0013-admin-in-shop.md) | Admin inside the shop, Google sign-in, allow-list | Accepted (2026-11-24) |
| [0014](0014-data-store-and-backup.md) | SQLite with Litestream to S3, plus Velero | Accepted (2026-11-24) |
| [0015](0015-email-provider.md) | Email for order and shipping notices | Proposed |
| [0016](0016-follow-cluster-repository-rules.md) | Follow the cluster's repository and deployment rules | Accepted (2026-11-24) |
| [0017](0017-fulfilment-provider-interface.md) | A fulfilment-provider interface; Printful first, Prodigi to evaluate for framed prints | Accepted (2026-11-24) |
| [0018](0018-order-ledger-and-reconciliation.md) | Order ledger, idempotent submit and hourly reconciliation | Accepted (2026-11-24) |
| [0019](0019-print-files-before-sale.md) | Print files exist and validate before a product is sold; their URLs never change | Accepted (2026-11-24) |
| [0020](0020-approval-hold-above-amount.md) | Hold orders above an amount for Klaus's approval | Proposed |
| [0021](0021-launch-scope.md) | What ships at launch and what waits | Accepted (2026-11-24) |
| [0022](0022-predefined-skus-in-config.md) | A handful of predefined SKUs, defined in a config file | Accepted (2026-11-24) |
| [0023](0023-address-once-via-stripe-customer.md) | The address is entered once, on the shop's page, and passed to Stripe as a Customer | Proposed |
