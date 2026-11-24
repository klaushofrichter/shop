# ADR-0009: From art to the shop: a link with the work's uid

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 (accepted with group 1: "yes, accept group 1")

## Context

art's works have a stable `uid` (permalinks `?id=<uid>`) and a changeable `slug`. art already sells originals at `/buy/<room>/<slug>`; prints must not be confused with them.

## Options considered

1. **A plain link `https://shop.klaushofrichter.net/p/<uid>`**, labelled "Prints & merchandise", next to but visually distinct from "Buy the original". The shop reads art's public manifest for everything else.
2. A signed token or session handoff: nothing to protect here, so no benefit.
3. Slug-based URLs: readable but break when a slug changes (the shop can still show the slug in the page title).

## Decision

Option 1.

## Consequences

- art's change is one link per work; the shop handles unknown or disabled uids with a friendly page linking back.
- The shop depends on art's manifest format; a daily check and an e2e test catch changes.
