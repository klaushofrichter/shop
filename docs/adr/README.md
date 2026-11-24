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
| [0006](0006-originals-access.md) | Print files come from art's originals through an internal endpoint | Superseded by 0025 |
| [0007](0007-checkout-and-shipping-quote.md) | Stripe hosted Checkout, shipping quoted on the shop's own page | Accepted (2026-11-24) |
| [0008](0008-cart.md) | Several products of one picture per order | Superseded by 0026 |
| [0009](0009-art-to-shop-handoff.md) | From art to the shop: a link with the work's uid | Accepted (2026-11-24) |
| [0010](0010-order-failure-and-refunds.md) | Order failures after payment: retry, then Klaus, then refund | Accepted (2026-11-24), amended 2026-11-26 |
| [0011](0011-currency-and-shipping-region.md) | Currency USD, shipping region to decide | Accepted (2026-11-24) |
| [0012](0012-sales-tax-and-vat.md) | Sales tax and VAT | Accepted (2026-11-24) |
| [0013](0013-admin-in-shop.md) | Admin inside the shop, Google sign-in, allow-list | Accepted (2026-11-24) |
| [0014](0014-data-store-and-backup.md) | SQLite with Litestream to S3, plus Velero | Accepted (2026-11-24) |
| [0015](0015-email-provider.md) | Email for order and shipping notices | Accepted (2026-11-24) |
| [0016](0016-follow-cluster-repository-rules.md) | Follow the cluster's repository and deployment rules | Accepted (2026-11-24) |
| [0017](0017-fulfilment-provider-interface.md) | A fulfilment-provider interface; Printful first, Prodigi to evaluate for framed prints | Accepted (2026-11-24) |
| [0018](0018-order-ledger-and-reconciliation.md) | Order ledger, idempotent submit and hourly reconciliation | Accepted (2026-11-24) |
| [0019](0019-print-files-before-sale.md) | Print files exist and validate before a product is sold; their URLs never change | Accepted (2026-11-24) |
| [0020](0020-approval-hold-above-amount.md) | Fail-safes against large or unusual orders | Accepted (2026-11-24) |
| [0021](0021-launch-scope.md) | What ships at launch and what waits | Accepted (2026-11-24); amended by 0027 |
| [0022](0022-predefined-skus-in-config.md) | A handful of predefined SKUs, defined in a config file | Accepted (2026-11-24) |
| [0023](0023-address-once-via-stripe-customer.md) | The address is entered once, on the shop's page, and passed to Stripe as a Customer | Accepted (2026-11-24) |
| [0024](0024-mock-printful-and-stripe.md) | Mock Printful and mock Stripe as an independent service, verified against the real ones | Accepted (2026-11-24) |
| [0025](0025-originals-from-arts-public-url.md) | Fetch originals from art's existing public URL (supersedes ADR-0006) | Accepted (2026-11-24) |
| [0026](0026-cart-with-any-pictures.md) | A cart with products of any picture (supersedes ADR-0008) | Accepted (2026-11-25) |
| [0027](0027-customer-emails-at-launch.md) | Customer e-mails at launch (amends ADR-0021) | Accepted (2026-11-25) |
| [0028](0028-private-repository-for-sensitive-data.md) | Sensitive test data in a private repository without CI | Accepted (2026-11-25) |
| [0029](0029-modes-and-printful-test-store.md) | One mode switch, a Printful store per mode, test mode only before go-live | Accepted (2026-11-25, 2026-11-26) |
| [0030](0030-stripe-webhook-endpoints.md) | Stripe webhook endpoints created by Klaus in the Dashboard | Accepted (2026-11-26) |
| [0031](0031-data-minimisation.md) | Send no personal data that isn't needed; consent where it would be | Accepted (2026-11-25) |
| [0032](0032-random-order-numbers.md) | Random five-digit order numbers | Accepted (2026-11-25) |
| [0033](0033-launch-print-sizes.md) | Launch sizes up to 12 × 16 in, landscape and portrait | Accepted (2026-11-25) |
| [0034](0034-order-state-model.md) | Separate payment, fulfilment and dispute state; holds with deadlines; invariants | Accepted (2026-11-26) |
| [0035](0035-content-sources.md) | Works from content sources, keyed by source; the shop renders its own display images | Accepted (2026-11-26) |
| [0036](0036-quote-checks-before-payment.md) | Address and cost checks before payment, without Printful's estimation task | Accepted (2026-11-26) |
| [0037](0037-status-links-from-a-secret.md) | Status links computed from a secret, not stored | Accepted (2026-11-26) |
| [0038](0038-ses-bounces-by-email.md) | SES bounce and complaint notices forwarded by e-mail | Accepted (2026-11-26) |
| [0039](0039-go-live-behind-the-preview-gate.md) | Go live behind the preview gate; record Printful only | Accepted (2026-11-26) |
