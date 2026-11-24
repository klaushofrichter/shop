# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- First service skeleton: `/health` with the release version, a placeholder home page linking to the gallery, a 404 page, strict Content Security Policy, compressed text.
- Repository baseline: PR checks (unit tests, dependency audit, four-browser e2e with axe, Lighthouse, CodeQL), image build on `main`, deploy workflow for `production`, Dependabot.
