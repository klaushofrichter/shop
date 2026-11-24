# ADR-0037: Status links computed from a secret, not stored

- Status: Accepted
- Date: 2026-11-26
- Decided by: Klaus, 2026-11-26, on round-2 decision 5 (with the order id as input): "decision 5: ok"

## Context

Round 1 stored only the SHA-256 of a random status token. Review B (F6) showed the consequence: e-mails sent later (shipped, delayed, refunded, "find my order") can't contain the link, because the token is gone after the first request, and minting a new one breaks the links sent earlier.

## Options considered

1. **Compute the token**: `HMAC-SHA256(STATUS_TOKEN_SECRET, order id)`, base64url, first 128 bits. Recomputed for every e-mail; nothing stored.
2. A table of token hashes, several per order.

## Decision

Option 1, keyed on the internal **order id** (unique for good), not the five-digit order number (reviews C and D). A new secret `STATUS_TOKEN_SECRET` in the shop's `.env` on the node (Klaus; Cluster can generate it without anyone seeing it).

## Consequences

- Every e-mail carries a working link; earlier links keep working.
- Rotating the secret revokes every status link at once ("find my order" still works, by e-mail).
- `orders.status_token_hash` is dropped from the schema.
