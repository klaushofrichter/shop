# ADR-0018: Order ledger, idempotent submit and hourly reconciliation

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 (accepted with group 1: "yes, accept group 1")

## Context

Payment and fulfilment happen in two outside systems whose webhooks can arrive twice, late, out of order or never. Pressline, print2medusa and notrab's starter each solved parts of this ([research](../research/oss-learnings.md#1-order-correctness)).

## Decision

- One order id for our database, Stripe (`client_reference_id`, metadata on session and payment intent) and Printful (`external_id`, at most 32 characters, suffixed `-N` on resubmission because Printful never releases an id).
- Every state change is an optimistic conditional update plus a row in `order_transitions` (from, to, cause, cause_ref, note, time), in one transaction. Same-state facts are annotations. Skip-forward edges are allowed.
- Inbound webhooks go into an event ledger unique on (provider, event id) with a claim lease; the handler verifies, stores, enqueues a job and returns 200. Jobs re-fetch the object before acting.
- Submit: claim, look up `@external_id`, create draft, wait for costs, **cost guard** (refuse to confirm if Printful's total exceeds what the customer paid minus the margin floor), confirm. Failures are classified as not-created or unknown; unknown means look up before retrying.
- Shipments are rows per parcel. The shipping method paid for is sent explicitly.
- Cancel at Printful uses v1 `DELETE /orders/{id}` (v2 only deletes drafts).
- Reconciliation runs **hourly**: stale checkouts, paid-but-unsubmitted orders, open Printful orders, refunds and disputes, unsettled events, unsent emails, catalog availability; a stored report; email to Klaus only on alarms.

## Consequences

- More tables (`order_transitions`, `inbound_events`, `shipments`, `jobs`, `reconciliation_runs`) and tests with fakes and recorded fixtures, but every failure mode found in those projects is covered.
- Raw webhook payloads contain personal data and are redacted by the purge job (ADR-0014 retention).
