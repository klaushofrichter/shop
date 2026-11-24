# ADR-0006: Print files come from art's originals through an internal endpoint

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

Full-resolution originals live only on art's volume (`art-assets-pvc`, RWO, local-path, single node, mounted read-only into art) and must never become public. Printful needs print files by URL. The largest public derivative is 2560 px wide, too small for large prints.

## Options considered

1. **art exposes `GET /internal/originals/<uid>`**, bearer token mandatory, and the path is blocked on art's public route (Traefik rule) and/or refused unless the request came via the cluster-local host. The shop fetches in-cluster, renders print files and serves them to Printful through signed, expiring URLs.
2. **Mount art's volume read-only into the shop.** Works on today's single node, but couples both pods to one node and to art's file layout.
3. **Klaus uploads print files per picture in the shop admin.** No coupling, but manual work per picture.

## Decision

Option 1 (Cluster agrees), with option 3 as a per-picture override.

## Consequences

- Work in art's repo (the endpoint, a token Secret) and in kube-setup (the Traefik rule).
- Print files exist on the shop's volume and at signed URLs; the signature and expiry are what protect them while Printful fetches.
