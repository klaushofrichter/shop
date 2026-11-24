# ADR-0025: Fetch originals from art's existing public URL (supersedes ADR-0006 if accepted)

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

ADR-0006 assumed the full-resolution originals are private on art's volume and designed an internal, token-protected endpoint for the shop. Checked 2026-11-24: art already serves every original at full resolution, publicly, at `https://art.klaushofrichter.net/assets/<room>/<file>?v=<v>` (art's `pictureUrl`, "the original, at full resolution — what the download link serves"). Example: `colors/IMG_8403.jpg`, 3489 × 2962, Display P3, 3.6 MB.

## Options considered

1. **Use art's existing URL** (in-cluster: `http://art.art.svc.cluster.local/assets/<room>/<file>`). No change to art, no token, no Traefik rule. ADR-0019's concern about print-file URLs becomes moot (the same pixels are public already).
2. **Keep ADR-0006** (internal endpoint with a token): only meaningful if art stops serving originals publicly, which is a change to art (its download link and link previews use them).
3. **Make originals private on art** (serve only derivatives up to 2560 px publicly) and keep ADR-0006: protects the full resolution, but changes art's download feature.

## Decision

Pending Klaus. Recommendation: option 1 if Klaus is content with the originals being public, as they are today; option 3 if he wants them private, in which case ADR-0006 stands and art's change comes first.

## Consequences

- Option 1 removes a work item in art and kube-setup and a secret (`ART_INTERNAL_TOKEN`).
- Either way the shop still renders its own print files (crop, sRGB, exact size) and keeps uploaded masters as an override.
