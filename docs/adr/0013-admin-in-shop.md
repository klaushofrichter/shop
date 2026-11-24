# ADR-0013: Admin inside the shop, Google sign-in, allow-list

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

The cluster's pattern: hand-rolled Google OAuth with `google-auth-library`, `ALLOWED_EMAILS`, HMAC-signed session cookie, logout that really logs out (vault: Building a New Service). New OAuth clients go into the Google Cloud project `skylar-technology`.

## Options considered

1. `/admin` inside the shop: one service, one database, one deploy.
2. A separate admin app: a second deploy and an API between them for no gain at this size.

## Decision

Option 1, with its own OAuth client (redirect `https://shop.klaushofrichter.net/auth/google/callback`), created by Klaus.

## Consequences

- The shop's public pages and admin share a process; admin routes get CSRF protection, `Cache-Control: no-store`, and an audit trail in `order_events`.
