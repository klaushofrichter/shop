# ADR-0039: Go live behind the preview gate; record Printful only

- Status: Accepted
- Date: 2026-11-26
- Decided by: Klaus, 2026-11-26, on the new round-2 decision (the preview gate as its own switch, Printful-only recording of the first live orders; amends ADR-0028): "New: ok"

## Context

The go-live checklist asked for one real order per product kind before `SHOP_MODE=live`, but real orders need live mode, and in live mode the preview gate was off and art showed the shop's links: strangers could buy from a shop that had never completed a real order. Three documents also disagreed on whether anything is recorded from live services (review C F5).

## Decision

- The preview gate is its own switch (`PREVIEW_GATE`). Live mode starts with it **on** (`/api/offers` empty, pages behind the preview key); Klaus places his own orders through it, receives and inspects them, then the gate goes off and art shows the links.
- During those orders only **Printful** is recorded: the shop's stored Printful webhook bodies (with signature headers) and a short-lived request trace of the Printful adapter, exported to the private repository (ADR-0028). Nothing is recorded from live Stripe.

## Consequences

- The export and the trace are built before go-live (step 9), not after the MVP.
- Printful webhook bodies are kept 30 days so the signature check can be replayed from the recording.
