# ADR-0015: Email for order and shipping notices

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

Customers need an order confirmation and shipping notices with tracking; Klaus needs alerts for new orders and failures. Stripe sends payment receipts itself. Printful does not email the end customer for API orders (to verify).

## Options considered

1. **Amazon SES**: AWS is already in use; $0.10 per 1,000 emails; needs domain verification (DNS records at Squarespace) and leaving the SES sandbox.
2. An SMTP account Klaus already has (e.g. Google Workspace): quick, but sending limits and a personal mailbox as sender.
3. A transactional provider (Postmark, Resend): good deliverability, a new account and possibly a monthly fee.

## Decision

Pending Klaus. Recommendation: SES from `orders@shop.klaushofrichter.net` or similar.

## Consequences

- DKIM/SPF records at Squarespace (Klaus).
