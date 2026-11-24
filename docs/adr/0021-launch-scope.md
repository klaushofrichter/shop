# ADR-0021: What ships at launch and what waits

- Status: Proposed
- Date: 2026-11-24
- Decided by: (pending, Klaus)

## Context

The research produced a long list of shop features ([tiers](../research/oss-learnings.md#7-feature-tiers)). Pressline kept its v1 small and required an ADR for each later addition.

## Decision

Launch with the "Launch" tier in the research document. The "Within a year" and "Nice to have" tiers are not built until Klaus asks; each then gets its own ADR. Exclusions that matter: no customer accounts (order page by link instead), one currency, no limited editions, no second provider.

## Consequences

- The data model leaves room for editions (a counter per picture and SKU), currencies (amounts stored with a currency code) and a second provider (ADR-0017), so adding them later does not need a migration of existing orders.
