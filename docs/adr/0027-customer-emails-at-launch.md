# ADR-0027: Customer e-mails at launch (amends ADR-0021)

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25: "we can offer emails to customers for status updates and tracking link"

## Context

ADR-0021 made customer e-mails optional at launch. Both reviews showed why that fails: on phones the browser often doesn't return from Stripe, so the customer has a receipt but no link to the order; a delay or refund would happen silently; questions become e-mails to Klaus (R9). Amazon SES is set up for alerts anyway (ADR-0015).

## Decision

At launch the shop e-mails customers: order confirmation with the status link; one "shipped" e-mail per parcel with carrier and tracking link; "delayed" when a hold or failure lasts beyond a set time; "refunded" or "cancelled". A "find my order" page re-sends the status link to the order's e-mail address (same answer whether or not the order exists, rate-limited). `EMAIL_ENABLED` remains as a kill switch. Non-live modes send only to an allow-list.

## Consequences

- E-mails are keyed by (order, kind, reference), so a split shipment sends one e-mail per parcel.
- SES bounces are recorded on the order and shown in the admin.
- ADR-0021's launch scope otherwise stands.
