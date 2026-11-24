# ADR-0032: Random five-digit order numbers

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25: "Order numbers: create random numbers, five digits may do for the beginning"

## Context

Round 1 used sequential numbers (`S-2026-000123`), which show customers the sales volume (review 1 F16).

## Decision

Order numbers are five random digits, 10000–99999, unique, drawn in the order's insert transaction and redrawn on a conflict (up to 10 tries, then an alert). Shown as "Order 48213". Internal ids (order id, Printful `external_id`) are separate and not shown.

## Consequences

- At ~500 orders a year the chance of a redraw stays small for years; widening to six digits is a configuration change that doesn't affect existing numbers.
- Customers quote the number with their e-mail in "find my order"; the pair, not the number alone, identifies an order.
