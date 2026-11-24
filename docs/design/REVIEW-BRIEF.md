# Design review brief

For the agent reviewing the shop's design before implementation starts. Klaus
(the owner) launches the review; the author is the "Shop - Cloud" session.

## What to review

Repository `klaushofrichter/shop`, branch `main`:

1. `docs/design/README.md`, then documents 01–14 in order. They are the design.
2. `docs/adr/` (25 decision records). **Accepted** records are Klaus's decisions: challenge them only with a concrete reason (a failure, a cost, a requirement they break), and say so explicitly. ADR-0025 is **Proposed** and open.
3. Evidence behind the design: `docs/research/` — `api-capture-findings.md` (what the real Printful and Stripe APIs did on 2026-11-24), `process-alternatives.md` (build vs Shopify etc.), `sales-tax.md`, `oss-learnings.md`. Raw captures: branches `capture/2026-11-24` and `capture/2026-11-24b`.
4. The code that exists: a service skeleton (`src/`), CI (`.github/workflows/`), `scripts/capture/capture-apis.mjs`.

Context: one artist, fewer than 10 orders a week, fully automated, on a single-node k3s
cluster with established conventions (ADR-0016). Simplicity is a requirement (R11).

## What we want from you

Use the checklist at the end of `docs/design/README.md`, and in particular:

- **Correctness of money and orders**: can a payment end without either a Printful order or a refund? Can an order be fulfilled twice? Can a held order cost Klaus money? Walk the state machine (07 §2) against every failure (06 §7) and fail-safe (06 §8).
- **Security and privacy**: webhooks, secrets, the admin, customer data, the "no real transaction in test deployments" rule (R19).
- **Gaps against the real APIs**: anything the design assumes that the captures contradict or don't cover.
- **Over-engineering**: what could be removed or deferred at this volume without risk.
- **Missing pieces** an implementer would have to invent.
- **Build vs buy**: is the case for a custom service (02 §6, `process-alternatives.md`) sound?

## Output

Write one file, `docs/reviews/2026-11-25-design-review.md`, on a branch, and open a pull
request to `main`. Structure:

1. Summary verdict: ready to implement / ready after listed changes / needs rework.
2. Findings, each with: id (F1, F2…), severity (**blocker**, **major**, **minor**, **question**), the document and section, what is wrong or unclear, why it matters (a concrete scenario), and a suggested change.
3. Challenges to Accepted ADRs, if any, separately, with the reason.
4. Things done well (short), so they aren't changed by accident.

Do not edit the design documents yourself; the author folds the findings in and records
any changed decision as an ADR.

## Rules

- **Read-only toward the outside world.** Do not call the Printful or Stripe APIs, do not run `scripts/capture/`, and do not use or ask for any key. Public documentation (developers.printful.com, docs.stripe.com) may be read.
- No secrets exist in the repository; if you find one, stop and report it.
- Don't merge anything; Klaus decides on the review's pull request.
