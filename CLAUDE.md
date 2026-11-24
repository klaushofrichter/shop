# CLAUDE.md

Guidance for agents working in this repository.

## Read first

- `docs/handover.md`: current state, who decides what, next steps. Keep it current.
- `docs/adr/`: every decision is an ADR (ADR-0001). Only Klaus moves one from Proposed to Accepted.
- `docs/design/`: the design set (start at its README); `docs/research/`: findings behind it.
- The cluster's rules (ADR-0016): the vault "General 2026" (read-only), sources of truth in kube-setup's `docs/repository-baseline.md` and `docs/cluster-deployment-requirements.md`.

## Standing decisions

- Release when green: PRs to `main` merge once the required checks pass (Klaus, 2026-11-10). Cluster merges `main` → `production`.
- Klaus's alone: secrets and keys, prices, tax, legal texts, exposure and DNS, anything that costs money, going live, switching Stripe from test to live.
- Never print, log or commit a secret. Keys live in `.env` on the cluster node; this repo has `.env.example` with names only.
- Stripe: development and end-to-end runs use test-mode keys. The live key is not used until Klaus says go.
- Printful: test mode uses the separate test store and never confirms; confirming an order in the live store charges Klaus and happens only in live mode.
- This repository is public: no account or object ids, host paths, threshold values, raw API recordings or incident notes (ADR-0028); those go to the private repository or kube-setup.
- Cluster changes (namespace, manifests, runner, Ingress, Secrets, repo settings, branch protection) go through the Cluster session.

## Conventions

- Node 26 everywhere (Dockerfile, workflows, `@types/node`).
- Version `YYYY.MM.DD.N` is generated at deploy time; never in the source or README.
- `/health` returns `{status, version}`.
- `CHANGELOG.md` `## [Unreleased]` gets a line for every user-visible change.
- Public pages pass the four-browser e2e with axe and Lighthouse floors (performance 90, others 100).
