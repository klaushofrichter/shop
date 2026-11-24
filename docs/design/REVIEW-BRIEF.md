# Design review brief — round 2

For agents reviewing the shop's design before implementation. Klaus (the owner)
launches the reviews; the author is the Shop session. Round 1 (two reviews) is done; the
design was revised in response.

## What to review

Repository `klaushofrichter/shop`, branch `main`:

1. `docs/reviews/2026-11-25-triage.md`: what round 1 found, what was decided and what was adopted. Read it first.
2. `docs/design/README.md`, then documents 01–14. Document 07 §2 (state model and invariants) is the heart of round 2.
3. `docs/adr/`. **Accepted** records are Klaus's decisions: challenge only with a concrete reason (a failure, a cost, a broken requirement). ADR-0029 (mode switch part), 0030, 0034, 0035 and 0036 are **Proposed** and open to challenge.
4. Evidence: `docs/research/` (`api-capture-findings.md`: what the real APIs did; `process-alternatives.md`; `sales-tax.md`; `oss-learnings.md`). The raw recordings are being moved to a private repository (ADR-0028); please do not review or quote the `capture/*` branches.
5. The code that exists: a skeleton (`src/`), CI (`.github/workflows/`), `scripts/capture/capture-apis.mjs`.

Context: one artist, fewer than 10 orders a week, fully automated (R9), a single-node k3s
cluster with established conventions (ADR-0016), simplicity as a requirement (R11). The
second gallery (christina-art, instagetter) is not needed now; the design only has to
allow it.

## What we want from you

- **Round-1 closure**: is every adopted finding really in the documents, consistently?
- **The state model**: walk I1–I9 against every failure, webhook and fail-safe. Can money be stranded, an order be fulfilled twice, a confirmed order be refunded by a timer, or a test order reach a live service?
- **New problems** introduced by the revision: the cart with several works, content sources, modes and the test store, holds and deadlines, customer e-mails, data minimisation, the hardened runner.
- **Over-engineering** still present for this volume.
- **Gaps** an implementer would still have to invent.

## Output

One file, `docs/reviews/2026-11-26-design-review-round-2-<your short name>.md`, on a
branch, with a pull request to `main`:
1. Verdict: ready to implement / ready after listed changes / needs rework.
2. Findings: id (R2-F1…), severity (**blocker**, **major**, **minor**, **question**), document and section, the problem, a concrete scenario, a suggested change.
3. Round-1 findings not (or wrongly) addressed, by their round-1 id.
4. Challenges to Accepted ADRs, separately, with the reason.
5. Things done well, briefly.

Don't edit the design documents; the author folds findings in.

## Rules

- **Read-only toward the outside world**: no Printful or Stripe API calls, no capture runs, no keys. Public documentation (developers.printful.com, docs.stripe.com) may be read.
- The repository is public: don't put account ids, host details, threshold values or anything sensitive into your file. If you find something sensitive in the repository, report it to Klaus directly, not in the file.
- Don't merge anything.
