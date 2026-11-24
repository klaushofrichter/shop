# Shop design

Design of `shop.klaushofrichter.net`: prints and merchandise of the works shown in
Klaus's galleries (art.klaushofrichter.net at launch), paid with Stripe, printed and
shipped by Printful.

- Status: **revised for review round 2**, 2026-11-25, before implementation. Round 1: two independent reviews, merged in [reviews/2026-11-25-triage.md](../reviews/2026-11-25-triage.md). Reviewer brief: [REVIEW-BRIEF.md](REVIEW-BRIEF.md).
- Owner: Klaus Hofrichter (decides). Author: the Shop session.
- Decisions: [docs/adr](../adr/README.md). Evidence: [docs/research](../research/).

## Reading order

| # | Document | What it settles |
|---|---|---|
| 1 | [Requirements](01-requirements.md) | What must work, for whom, at what volume; R1–R23, Q1–Q9 |
| 2 | [Architecture](02-architecture.md) | Components, boundaries, the end-to-end process, alternatives |
| 3 | [Customer journey](03-customer-journey.md) | Every page from a gallery to the order status page; cart; find my order |
| 4 | [Catalog, sources and print files](04-catalog-and-print-files.md) | Launch SKUs, content sources, print files, display images, mockups |
| 5 | [Quote, checkout and payment](05-quote-checkout-payment.md) | Local checks, shipping rates, Stripe Checkout, webhooks, tax, refunds |
| 6 | [Fulfilment](06-fulfilment.md) | Provider interface, Printful adapter, submission, tracking, failures, fail-safes |
| 7 | [Orders, data and jobs](07-orders-data-jobs.md) | **The state model and invariants**, schema, jobs, reconciliation, retention |
| 8 | [Admin](08-admin.md) | What Klaus sets up and sees; he is never a step in an order |
| 9 | [Notifications](09-notifications.md) | Customer e-mails (at launch) and alerts |
| 10 | [Security, privacy and legal](10-security-privacy-legal.md) | Threats, data minimisation, what may be public, the runner |
| 11 | [Operations](11-operations.md) | Modes, configuration, deployment, backup, runbooks |
| 12 | [Testing](12-testing.md) | Unit, integration, invariant and e2e tests; real-service checks; go-live |
| 13 | [Plan and open questions](13-plan-and-open-questions.md) | Build order, Klaus's items, questions for round 2 |
| 14 | [Mock services](14-mock-services.md) | Mock Printful and Stripe, verified against recordings |

## The process in one paragraph

A visitor looking at a work on art clicks **Prints & merchandise** and lands on the work's
page in the shop, which shows the products it is offered as, with Printful mockups.
Products of any number of works go into one cart. The visitor enters a shipping
address; the shop checks it locally, asks Printful for shipping rates and checks its own
margin, then shows a quote. **Pay** redirects to Stripe's hosted Checkout, which already
knows the address. When Stripe reports the payment, the shop records it (even if the
checkout had been closed meanwhile), applies the fail-safes, creates a Printful draft
with only name and address, checks the real cost, and confirms it. Printful's webhooks
and an hourly poll bring status and tracking back; the customer gets a confirmation and
one e-mail per parcel with the tracking link, and can always find the order again.
Exceptions become holds with deadlines that resolve themselves; Klaus is told, and acts
only where only he can.

## Conventions

- **MUST / SHOULD / MAY** as in RFC 2119. *(verify)* marks a fact still to be checked against a real service ([13 §4](13-plan-and-open-questions.md#4-items-to-verify)).
- Money in integer cents (USD); Printful's decimal strings are converted at the adapter boundary.
- Times in UTC; shown to Klaus in America/Chicago. All code takes time from one `Clock`.
- "Work" is an image from a content source, keyed `(source, id)`.
- This repository is public: threshold values, account ids, host details and raw recordings are elsewhere (ADR-0028).

## Review checklist (round 2)

The questions in [13 §3](13-plan-and-open-questions.md#3-questions-for-review-round-2), and in particular:
1. Walk every invariant of [07 §2.6](07-orders-data-jobs.md#26-invariants) against every failure of [06 §7](06-fulfilment.md#7-failure-handling), the fail-safes of [06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders) and the webhook table of [05 §4](05-quote-checkout-payment.md#4-payment-webhooks).
2. Check that every round-1 finding marked "adopted" in the triage is actually in the documents.
3. Look for new problems the revision introduced (cart, sources, modes, e-mails, holds).
