# ADR-0016: Follow the cluster's repository and deployment rules

- Status: Accepted
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24 ("Obsidian has certain rules for repository design, version strings etc, please honor these.")

## Context

The vault "General 2026" (notes generated from kube-setup's `docs/vault/`) holds the rules every repo and service under `klaushofrichter` follows. The sources of truth are kube-setup's `docs/repository-baseline.md` and `docs/cluster-deployment-requirements.md`. Read for this repo on 2026-11-24: Cluster Overview, Building a New Service, Deployments and CI, New Repository Checklist, cams-admin.

## Decision

The shop follows those rules. Where this repo's own docs disagree with them, the rules win, unless Klaus decides otherwise in a later ADR. Concretely:

- **Branches:** feature branch → PR → `main` → promotion PR → protected `production` → deploy. `main` is built, never deployed.
- **Workflows:** `production-checks.yml` (PR: `test`, `e2e`, `codeql`, `npm audit --audit-level=high`), `build-push.yml` (push to `main`: tests, image `:main` only), `deploy-production.yml` (push to `production`, in-cluster self-hosted runner: version, build, push `:<sha>`/`:v<version>`/`:latest`, update the kube-setup manifest, push before apply, smoke test, release).
- **Version:** `YYYY.MM.DD.N`, generated at deploy time from the release tags, `TZ=America/Chicago`, passed as `ARG APP_VERSION=dev` → `ENV APP_VERSION`; tag `v<version>`; never stored in the source; no version numbers in the README text.
- **`GET /health`** returns `{status, version}`; the smoke test waits until the served version equals the deployed one.
- **Release notes** from `CHANGELOG.md` `## [Unreleased]`, with "Verified at release" evidence.
- **Node 26** everywhere it appears (Dockerfile, `node-version`, `@types/node`), with the reference action set (`actions/checkout@v7`, `actions/setup-node@v7`, `docker/build-push-action@v7`, `docker/login-action@v4`, `github/codeql-action/*@v4`).
- **Dependabot:** `.github/dependabot.yml` for npm and github-actions, weekly on Monday (public repo), labels `dependencies` and `ci` (Cluster creates them and turns on alerts and security updates).
- **README badge row:** release, PR checks, image build, deploy, Dependabot.
- **Container:** non-root, `USER 1000:1000`, the drop-ALL `securityContext`, digest-pinned image for a Deployment, atomic writes to the PVC with random temp names.
- **Public pages baseline:** e2e in Chromium, Android, iPhone (WebKit) and Firefox with `failOnFlakyTests`, axe-core with zero WCAG 2.2 AA violations, Lighthouse floors, a live check after each release, text compression.
- **Google OAuth:** the hand-rolled pattern (`state` cookie, `verifyIdToken`, `ALLOWED_EMAILS`, HMAC-signed cookie, logout that really logs out, `trust proxy` as a CIDR list), its own OAuth client in the `skylar-technology` project.
- **Secrets:** never in git or chat; `.env` git-ignored, no inline comments in `.env` values; Kubernetes Secrets created with `kubectl create secret` by Klaus or Cluster.
- **Cluster changes** (namespace, manifests, runner, Ingress, NetworkPolicy, monitoring) are made by the Cluster session in kube-setup; repo settings and branch protection too.
- **Releases:** merge and release when all required checks are green (Klaus, 2026-11-10); exceptions (exposure, secrets, deletions, cost, permissions, going live) stay Klaus's.

## Consequences

- The delivery plan in design.md §13 is ordered to satisfy these from the first commit.
- When the rules change in kube-setup, this ADR's list may go stale; the kube-setup docs win.
