# ADR-0015: Email for order and shipping notices

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24: "re: mails: we can configure Amazon SES"

## Context

Customers need an order confirmation and shipping notices with tracking; Klaus needs alerts for new orders and failures. Stripe sends payment receipts itself. Printful does not email the end customer for API orders (to verify).

## Options considered

1. **Amazon SES**: AWS is already in use; $0.10 per 1,000 emails; needs domain verification (DNS records at Squarespace) and leaving the SES sandbox.
2. An SMTP account Klaus already has (e.g. Google Workspace): quick, but sending limits and a personal mailbox as sender.
3. A transactional provider (Postmark, Resend): good deliverability, a new account and possibly a monthly fee.

## Decision

Option 1: Amazon SES, sending from an address on `shop.klaushofrichter.net` (e.g. `orders@`), with SPF and DKIM records at Squarespace (Klaus) and production access (out of the SES sandbox) requested before go-live. Used for alerts to Klaus from the start and for customer emails when `EMAIL_ENABLED` is on.

## Consequences

- DKIM/SPF records at Squarespace (Klaus).
