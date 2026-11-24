# ADR-0004: Stack and runtime: Node 26, server-rendered, plain Deployment

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 (accepted with group 1: "yes, accept group 1")

## Context

The cluster's services are Node/TypeScript with Express, hand-rolled Google OAuth, Playwright e2e. Knative services suit short HTTP requests; a single SQLite writer with background jobs and a Litestream sidecar is the plain-Deployment shape (cams-admin, games-cloud). See the vault note "Building a New Service".

## Options considered

1. **Node 26 + TypeScript + Express, server-rendered HTML, a little client JS; SQLite; `sharp`; a jobs table run in-process; plain Deployment, `replicas: 1`, `Recreate`, own Ingress + Certificate, Traefik compression middleware.**
2. Knative service with min-scale 1: works for HTTP, but the job runner and the Litestream sidecar fit the Deployment shape better, and a rollover would briefly run two writers on one SQLite file.
3. A frontend framework (Next.js, SvelteKit): more moving parts than a shop of a few pages needs.

## Decision

Option 1.

## Consequences

- Follows the existing runbooks: three workflows, calendar versions, `/health` with version, non-root image, digest pinning, runner RBAC on the one Deployment.
- One replica: brief downtime on deploys (Recreate). Stripe and Printful retry webhooks, and the reconciliation sweep catches anything missed.
