# ADR-0021: What ships at launch and what waits

- Status: Accepted; customer e-mails amended by ADR-0027 (2026-11-25)
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24: the minimum requirements in his message ("…a handful of pre-defined SKUs…", "…may send tracking information and status update to the customer as well (this is optional for now)")

## Context

The research produced a long list of shop features ([tiers](../research/oss-learnings.md#7-feature-tiers)). Pressline kept its v1 small and required an ADR for each later addition.

## Decision

Launch with the minimum requirements R1–R15 of docs/design/01-requirements.md, which narrow the research's "Launch" tier: a handful of predefined SKUs (ADR-0022), one picture per order (ADR-0008), customer emails optional. The "Within a year" and "Nice to have" tiers are not built until Klaus asks; each then gets its own ADR. Exclusions that matter: no customer accounts (order page by link instead), one currency, no limited editions, no second provider.

## Consequences

- The data model leaves room for editions (a counter per picture and SKU), currencies (amounts stored with a currency code) and a second provider (ADR-0017), so adding them later does not need a migration of existing orders.
