# ADR-0029: One mode switch, a database file and a Printful store per mode

- Status: Accepted (the test store); Proposed (the mode switch and per-mode databases, for review round 2)
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25, for the store: "I created a new store in printful, 'klaushofrichter test' with a new token in the .env called PRINTFUL_TOKEN_TEST". The rest pending.

## Context

Round 1 had four settings that had to agree (`STRIPE_MODE`, `FULFILMENT_CONFIRM` and two base URLs), one database for test and live orders, and test drafts in the live Printful store, whose single webhook configuration per token and file library they would share. Review 1 F25 proposed one switch, a database per mode and a separate store (Printful's own advice for testing).

## Decision

- `SHOP_MODE = mock | test | live` derives everything else (docs/design/11 §2.1): which services, keys, store and database file; whether anything is confirmed (only live); the preview gate.
- Test mode uses the **Printful test store** (`PRINTFUL_TOKEN_TEST`, same scopes as the live token, checked 2026-11-25) and Stripe test mode; nothing is ever confirmed there.
- One database file per mode (`mock.db`, `test.db`, `live.db`).
- Startup checks: key prefixes match the mode; the Printful token's store is the mode's store; mock keys only with mock hosts.

## Consequences

- Test orders can never meet live reconciliation, the live store's webhook configuration or its file library.
- Recordings (ADR-0024, ADR-0028) use the test store.
- Going live is one change, applied by Cluster on Klaus's word.
