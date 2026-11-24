# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 ("I want you to keep architecture decision records of every decision we take.")

## Context

The shop is built by agents across sessions (Shop - Cloud, Cluster) with Klaus deciding. Decisions get made in chat and are lost when a session ends. Payment, order and data-handling choices need a durable why.

## Decision

Every decision is recorded as an ADR in `docs/adr/`, in the format of [template.md](template.md), committed through the normal PR flow. Open questions for Klaus are written as Proposed ADRs; his answer moves them to Accepted or Rejected. `docs/design.md` describes the current design and links to the ADRs behind it.

## Consequences

- A new session can reconstruct why the shop is the way it is from the repo alone.
- Each decision costs a short file; small, reversible implementation choices go in code comments or PR descriptions instead, unless Klaus asks.
