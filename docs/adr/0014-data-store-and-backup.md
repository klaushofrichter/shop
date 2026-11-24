# ADR-0014: SQLite with Litestream to S3, plus Velero

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 (accepted with group 1: "yes, accept group 1")

## Context

Orders are money and must not be lost. One writer, low volume. cams-admin's Litestream restore has been tested.

## Options considered

1. **SQLite on a Retain PVC, Litestream sidecar to a new S3 bucket**, plus a Velero file-system copy of a `VACUUM INTO` snapshot.
2. Velero only: hourly-ish copies, so orders between backups could be lost with the node.
3. Postgres: more to run than this volume needs.

## Decision

Option 1 (recommended by Cluster). New bucket and IAM user created by Klaus (e.g. `klaushofrichter-k3s-shop-backups`); never cams-admin's.

## Consequences

- A restore test before going live, and a backup dead-man alert like cams-admin's.
- Stripe and Printful also hold every order, so the reconciliation sweep can rebuild state for recent orders if the database were lost between syncs.
