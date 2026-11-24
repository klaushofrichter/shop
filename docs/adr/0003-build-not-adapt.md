# ADR-0003: Build the shop, borrow patterns from Pressline

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

Evaluated 2026-11-24 (details in design.md §12): Pressline (dworznik/pressline, MIT, Printful v2, Stripe Checkout, SvelteKit + Effect, one item per order, no cart), THREADFORM (no Printful integration at all), belialdigital (does not exist publicly), lbsudo/printful-nextjs-starter (archived 2023, unverified webhooks, leaked key pattern), medusa-printful (2022 experiment, Medusa v1, broken), kerkkoh/simple-clothing-store (PayPal, Printful v1, confirms the wrong order id), notrab/headless-dropshipping-starter (maintained, Printful v1, no license).

## Options considered

1. **Adapt Pressline.** The most rigorous (17 ADRs, order state machine, reconciliation, tests, Printful v2). But it is a bridge for image-generating apps: one item per order, no cart, no catalog admin, SvelteKit + Effect + Vercel/Cloudflare targets; reshaping it costs more than writing ours, and its stack differs from every other service on the cluster.
2. **Adapt another project.** None has the combination we need, and most are unmaintained or broken.
3. **Build a small service in the cluster's usual stack** (Node 26, Express-style server, server-rendered pages, SQLite), copying Pressline's patterns, with MIT attribution where code is copied.

## Decision

Option 3. Patterns to borrow: Pressline's order state machine with a recorded cause per transition, submit = look up by `external_id` then create draft then confirm, webhooks as hints followed by a re-fetch, a reconciliation sweep; notrab's rule to confirm a Printful order only when the amount paid covers Printful's cost.

## Consequences

- More code to write and test ourselves (estimated a few thousand lines with admin), but all of it in the stack the cluster's runbooks, CI and security rules already cover.
- Revisit if Pressline grows multi-item orders and a catalog admin.
