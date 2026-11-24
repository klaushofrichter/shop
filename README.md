# shop

[![Release](https://img.shields.io/github/v/release/klaushofrichter/shop?label=release&color=blue)](https://github.com/klaushofrichter/shop/releases)
[![PR checks](https://github.com/klaushofrichter/shop/actions/workflows/production-checks.yml/badge.svg)](https://github.com/klaushofrichter/shop/actions/workflows/production-checks.yml)
[![Build and publish image](https://github.com/klaushofrichter/shop/actions/workflows/build-push.yml/badge.svg?branch=main)](https://github.com/klaushofrichter/shop/actions/workflows/build-push.yml)
[![Deploy production](https://github.com/klaushofrichter/shop/actions/workflows/deploy-production.yml/badge.svg?branch=production)](https://github.com/klaushofrichter/shop/actions/workflows/deploy-production.yml)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot&logoColor=white)](https://github.com/klaushofrichter/shop/security/dependabot)

<!-- The release badge is the newest tag. Dependabot is a static badge:
     alerts and security updates are repository settings, version updates
     come from .github/dependabot.yml. No version numbers in the text below. -->

Prints and merchandise from the paintings on [art.klaushofrichter.net](https://art.klaushofrichter.net),
served at `shop.klaushofrichter.net`: a visitor picks a picture in the gallery,
chooses a product (postcard, print, framed print, mug, t-shirt), pays with
Stripe, and the order goes to Printful, which prints and ships it.

- Design: [docs/design/](docs/design/README.md)
- Decisions: [docs/adr](docs/adr/README.md)
- Research: [docs/research/oss-learnings.md](docs/research/oss-learnings.md)
- Current state: [docs/handover.md](docs/handover.md)

## Develop

Node 26.

```bash
npm ci
npm run dev          # http://localhost:8080, reads .env if present
npm test             # unit tests
npm run test:e2e     # browser tests (starts the server itself)
```

Secrets are never in the repository: `.env` is git-ignored, and `.env.example`
lists the names.

## Branches and releases

Feature branch → PR → `main` (built as `ghcr.io/klaushofrichter/shop:main`,
never deployed) → promotion PR → `production` (deployed by the in-cluster
runner, versioned `YYYY.MM.DD.N`, released with notes from `CHANGELOG.md`).

## License

MIT. `scripts/audit-gate.mjs` comes from klaushofrichter/cams-admin and
`scripts/lighthouse-gate.sh` from klaushofrichter/art.
