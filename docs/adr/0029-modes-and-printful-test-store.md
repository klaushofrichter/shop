# ADR-0029: One mode switch, a Printful store per mode, test mode only before go-live

- Status: Accepted (the test store, 2026-11-25; test mode only before go-live and mock mode only in CI, 2026-11-26); Proposed (the mode switch and the database files)
- Date: 2026-11-25, revised 2026-11-26 after review round 2
- Decided by: Klaus, 2026-11-25, for the store: "I created a new store in printful, 'klaushofrichter test' with a new token in the .env called PRINTFUL_TOKEN_TEST". Klaus, 2026-11-26, on round-2 decision 3 (test mode only before go-live, mock mode only in CI, the first cluster deployment using Stripe test mode and drafts in the test store): "decision 3: ok". The rest pending.

## Context

Round 1 had four settings that had to agree (`STRIPE_MODE`, `FULFILMENT_CONFIRM` and two base URLs), one database for test and live orders, and test drafts in the live Printful store, whose single webhook configuration per token and file library they would share. Review 1 F25 proposed one switch, a database per mode and a separate store (Printful's own advice for testing). Round 2 found that a database per mode loses Klaus's catalog setup at go-live (review B F3), that nothing described a test deployment after go-live (review B F4), and that a mock deployment on the cluster is more than this volume needs (review B F16).

## Decision

- `SHOP_MODE = mock | test | live` derives everything else (docs/design/11 §2.1): which services, keys, store and database file, and whether anything is confirmed (only in live, and against the mock in mock mode; in test mode the adapter has no confirm method).
- Test mode uses the **Printful test store** (`PRINTFUL_TOKEN_TEST`) and Stripe test mode; nothing is ever confirmed there.
- **Mock mode runs only in CI.** On the cluster the shop starts in **test** mode: the first deployment talks to Stripe test mode and makes drafts in the test store, never confirming (R19 reworded).
- **Test mode exists only before go-live**, on the same deployment. At go-live the Stripe test-mode endpoint and the test store's webhook are disabled. Later real-service checks are the capture script, run by hand.
- Database files (proposed): **`catalog.db` shared by all modes** (works, offers, print files, provider registrations per store), so the setup survives go-live; **one file per mode** for carts, quotes, orders and jobs. No foreign keys across the two; Litestream replicates both.
- The **preview gate** is its own switch (ADR-0039).
- Startup checks: key prefixes match the mode; the Printful token's store is the expected store from its own variable; mock keys only with mock hosts. A wrong answer stops the start; no answer from Printful doesn't.

## Consequences

- Test orders can never meet live reconciliation, the live store's webhook configuration or its file library.
- Recordings use the test store; Klaus's first live orders are recorded for Printful only (ADR-0039).
- Going live is `SHOP_MODE=live` plus the live Secret, applied by Cluster on Klaus's word, with the gate still on.
