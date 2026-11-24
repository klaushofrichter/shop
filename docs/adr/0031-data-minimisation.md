# ADR-0031: Send no personal data that isn't needed; consent where it would be

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25: "privacy: if we can avoid sending PII, we should not send PII. If is it needed for receiving tracking and progress information, we should get the consent of the customer"

## Context

Review 1 F19 asked whether Printful should get the customer's e-mail and phone. The shop receives tracking and status from Printful's webhooks and API, so neither Printful nor the carriers need to contact the customer.

## Decision

- **Printful** gets the recipient's name and shipping address only: no e-mail, no phone. Packing slips carry no customer contact data.
- **Stripe** gets name, e-mail and address (payment, receipt, tax, fraud screening).
- **SES** gets the customer's e-mail address for the shop's own e-mails (ADR-0027).
- If a future option needs more (e.g. a carrier requiring a phone for express or international shipping), the checkout asks with an explicit consent line naming the use.
- Retention: personal data purged 180 days after an order's end; Stripe Customers deleted at the same time.

## Consequences

- No phone field in the checkout. Carriers can't call the customer; delivery problems surface as returned parcels.
- The privacy text names exactly these recipients.
