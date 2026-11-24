# Shop design

Design of `shop.klaushofrichter.net`: prints and merchandise of the paintings on
`art.klaushofrichter.net`, paid with Stripe, printed and shipped by Printful.

- Status: **ready for review**, 2026-11-24, before implementation. Reviewer brief: [REVIEW-BRIEF.md](REVIEW-BRIEF.md).
- Owner: Klaus Hofrichter (decides). Author: Shop - Cloud (agent).
- Decisions behind this design: [docs/adr](../adr/README.md). Research: [docs/research](../research/).

## Reading order

| # | Document | What it settles |
|---|---|---|
| 1 | [Requirements](01-requirements.md) | What must work, for whom, at what volume; what is out of scope |
| 2 | [Architecture](02-architecture.md) | Components, boundaries, the end-to-end process, alternatives to building it |
| 3 | [Customer journey](03-customer-journey.md) | Every page and step from the gallery to the order status page |
| 4 | [Catalog, SKUs and print files](04-catalog-and-print-files.md) | The predefined products, per-picture offers, prices, print files, previews |
| 5 | [Quote, checkout and payment](05-quote-checkout-payment.md) | Shipping quote, totals, Stripe Checkout, payment webhooks, refunds |
| 6 | [Fulfilment](06-fulfilment.md) | The provider interface, the Printful adapter, submission, tracking, failures |
| 7 | [Orders, data and jobs](07-orders-data-jobs.md) | State machine, database schema, job runner, reconciliation, retention |
| 8 | [Admin](08-admin.md) | What Klaus can see and do, and what he never has to do |
| 9 | [Notifications](09-notifications.md) | Emails to customers (optional at launch) and alerts to Klaus |
| 10 | [Security, privacy and legal](10-security-privacy-legal.md) | Threats, secrets, personal data, legal pages, tax |
| 11 | [Operations](11-operations.md) | Configuration, deployment, backup, monitoring, runbooks |
| 12 | [Testing](12-testing.md) | Unit, integration, e2e, test mode, go-live checks |
| 13 | [Delivery plan and open questions](13-plan-and-open-questions.md) | Build order, what Klaus still decides, what the review should challenge |
| 14 | [Mock services](14-mock-services.md) | Mock Printful and mock Stripe for CI and test deployments, and how they are verified against the real services |

## The process in one paragraph

A visitor looking at a painting on art clicks **Prints & merchandise** and lands on
`shop.klaushofrichter.net/p/<uid>`. The shop shows that painting with the products
it is offered as (Printful mockup previews), the visitor picks one or more products
and quantities, enters a shipping address, and sees a quote: items, shipping
(live from Printful) and, if enabled, tax. **Pay** redirects to Stripe's hosted
Checkout. When Stripe confirms the payment by webhook, the shop creates the Printful
order (draft), checks that the money received covers Printful's cost, and confirms
it. Printful prints and ships; its webhooks (and an hourly poll) bring status and
tracking back. The customer can follow the order on a private status page and,
once email is enabled, gets confirmation and tracking emails. Nothing in this
path needs Klaus; he is told only when something cannot be fixed automatically.

## Conventions in these documents

- **MUST / SHOULD / MAY** as in RFC 2119.
- *(verify)* marks a fact that must be checked in Stripe test mode or with a Printful draft order before code depends on it.
- Money is integer **cents** (USD) everywhere in the code and database; Printful's decimal strings are converted at the adapter boundary.
- Times are UTC in storage, shown in America/Chicago to Klaus.
- "Picture", "painting" and "work" mean an entry of art's manifest, identified by its `uid`.

## Review checklist (for the design review)

1. Is every minimum requirement in [01](01-requirements.md#3-minimum-requirements) traced to a design element (table in §5 there)?
2. Can a paid order get lost or be fulfilled twice? Walk [07 §2](07-orders-data-jobs.md#2-state-machine) with each failure in [06 §7](06-fulfilment.md#7-failure-handling).
3. Can the customer be charged a price the shop didn't compute, or ship to an address that wasn't quoted? ([05 §3](05-quote-checkout-payment.md#3-checkout-session))
4. Does anything require Klaus's routine involvement? (Requirement R9.)
5. Are secrets, the originals and customer data protected as [10](10-security-privacy-legal.md) claims?
6. Is anything here more than <10 orders a week needs? (Simplicity is a requirement, R11.)
7. Should we build at all? ([02 §6](02-architecture.md#6-alternatives-to-building-it))
8. Do the fail-safes ([06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders)) stop misuse without bothering real customers, and can a held order ever cost Klaus a Printful charge?
9. Can the mock services ([14](14-mock-services.md)) drift from the real APIs unnoticed, and is any path through them able to reach a real payment or a real Printful order (R19)?
10. Does the design use what the real APIs actually did ([research/api-capture-findings.md](../research/api-capture-findings.md)), e.g. address validation before payment and print files via the file library?
