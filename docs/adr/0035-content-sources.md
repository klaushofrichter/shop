# ADR-0035: Works from content sources, keyed by source; the shop renders its own display images

- Status: Proposed
- Date: 2026-11-25
- Decided by: (pending, Klaus; for review round 2). Klaus, 2026-11-25, on the second gallery: "A second gallery does not matter much at this time, examples could be our own repos christina-art and instagetter."

## Context

Round 1 parsed art's home page, keyed works by art's bare `uid`, hot-linked art's derivative images (blocked by the shop's own CSP), and stored art's whole manifest entry. Both reviews (review 1 F21, review 2 F3, F4) asked for a source abstraction and a source id in every key now, because adding it later touches every table and URL.

## Decision

- `ContentSource` (`listWorks`, `fetchOriginal`) beside `FulfilmentProvider`; one adapter per source; `config/sources.json`.
- The shop's own `Work` shape, allow-listed; nothing else from a source is stored.
- Every table keys works by `(source_id, work_id)`; routes `/p/<source>/<work>` with `/p/<work>` as art's alias.
- A per-work `printsAllowed` flag from the source (art's decision on what may be sold), and Klaus's enable in the admin.
- The shop renders and serves its own display images without metadata; CSP stays `img-src 'self'`.
- Re-render only when the original's SHA-256 changes, not on a source's version string.
- Proposed to art (its decision): a versioned works feed instead of the page manifest.

## Consequences

- Adding christina-art or instagetter later is an adapter and a config entry.
- The art adapter has a contract test against a recorded manifest and a daily schema check.
