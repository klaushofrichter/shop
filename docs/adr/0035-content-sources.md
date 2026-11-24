# ADR-0035: Works from content sources, keyed by source; the shop renders its own display images

- Status: Proposed
- Date: 2026-11-25, revised 2026-11-26 after review round 2
- Decided by: (pending, Klaus; round-2 decision 4). Klaus, 2026-11-25, on the second gallery: "A second gallery does not matter much at this time, examples could be our own repos christina-art and instagetter."

## Context

Round 1 parsed art's home page, keyed works by art's bare `uid`, hot-linked art's derivative images (blocked by the shop's own CSP), and stored art's whole manifest entry. Both reviews (review 1 F21, review 2 F3, F4) asked for a source abstraction and a source id in every key now, because adding it later touches every table and URL.

## Decision

- `ContentSource` (`listWorks`, `fetchOriginal`) beside `FulfilmentProvider`; one adapter per source; `config/sources.json`.
- The shop's own `Work` shape, allow-listed; nothing else from a source is stored.
- Every table keys works by `(source_id, work_id)`; routes `/p/<source>/<work>` with `/p/<work>` as art's alias.
- Consent per work: the source's own `printsAllowed` flag once it publishes one; until then a per-work allow-list `printsAllowedWorks` in `config/sources.json`, filled from the source owner's decision (for art, Klaus's); otherwise the source default (art: no). Then Klaus's enable in the admin (review B F5).
- For large sources: originals fetched and hashed only for works Klaus opens or enables; a nullable `title_override` (review C F18).
- One shop name on every packing slip, whatever the sources in the cart (review C F17).
- The shop renders and serves its own display images without metadata; CSP stays `img-src 'self'`.
- Re-render only when the original's SHA-256 changes, not on a source's version string.
- Proposed to art (its decision): a versioned works feed instead of the page manifest.

## Consequences

- Adding christina-art or instagetter later is an adapter and a config entry.
- The art adapter has a contract test against a recorded manifest and a daily schema check.
