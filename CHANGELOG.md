# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Admin at `/admin`: Google sign-in for the allowed address only, a dashboard, the works from the galleries with enable and disable, and per work the products offered, prices and crops, with a preview of each print file.
- Picture images and print files are served from the shop itself (`/img/*`, `/files/*`), named by their content, rate-limited.
- `/health/worker`: 200 while the background job runner is alive, 503 otherwise, for the uptime monitor.
- The shop refuses to start with a configuration that doesn't fit its mode (`SHOP_MODE` mock, test or live) and names the problem.
- First service skeleton: `/health` with the release version, a placeholder home page linking to the gallery, a 404 page, strict Content Security Policy, compressed text.
- Repository baseline: PR checks (unit tests, dependency audit, four-browser e2e with axe, Lighthouse, CodeQL), image build on `main`, deploy workflow for `production`, Dependabot.
