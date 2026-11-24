# ADR-0024: Mock Printful and mock Stripe as an independent service, verified against the real ones

- Status: Accepted (the mocks and their verification); the location detail below is a recommendation for the review
- Date: 2026-11-24
- Decided by: Klaus, 2026-11-24: "I would like to create a mock printful and mock stripe instance that can be easily configured to be used instead of the 'real thing'. That can be an independent service, we can spend some time and energy on it. It must be able to work in CI, and we might want to make sure that we verify the mock services when using the actual service, perhaps by recording real interactions and compare later to the mock, or do that in real time."

## Context

Printful has no sandbox, and every confirmed order charges Klaus. Stripe has test mode, but its hosted Checkout needs a browser and real webhooks need a public URL. The shop's riskiest code (payment webhooks, submission, failures, the fail-safes) must be exercised end to end in CI and on a test deployment without touching real money or real orders. Mocks that drift from the real APIs give false confidence, so they must be checked against the real services.

## Options considered

1. In-process fakes inside the shop's test suite only (the first design): fast, but not usable for a deployed test instance, and nothing verifies them.
2. Third-party mocks (`stripe-mock`, generic OpenAPI mock servers): `stripe-mock` is stateless and doesn't do Checkout flows or webhooks; nothing exists for Printful.
3. **An independent mock service** ("shop-mocks") speaking Printful's and Stripe's HTTP APIs, stateful, scriptable, sending correctly signed webhooks, with a simulated Checkout page; selected by configuration (base URLs and keys); verified by schema validation against the published OpenAPI specs, by record-and-compare against the real services, and by shadow calls in real time.

## Decision

Option 3. Design in docs/design/14-mock-services.md.

Location (recommendation, for the review): its own directory `mocks/` in this repository with its own `package.json`, tests, Dockerfile and image `ghcr.io/klaushofrichter/shop-mocks`, so the shop and its mocks change in the same PR; moved to its own repository later if another project wants it.

## Consequences

- CI and the test deployment run the full purchase flow, including failures that can't be produced on demand with the real services (lost responses, 429s, holds, disputes).
- Real services are touched only in safe ways: Stripe in test mode, Printful read-only. No Printful order (not even a draft) unless Klaus allows drafts later.
- A real API change shows up as a drift report rather than as a production incident.
- Work: estimated as large as a third of the shop itself.

## Notes
- 2026-11-26: superseded in detail by ADR-0029 and docs/design/14 §7: Printful **drafts** are allowed in the test store (Klaus, 2026-11-24), never confirmed; shadow calls are dropped (review 1 F23.2); mock mode runs only in CI, not as a deployment (ADR-0029); Stripe requests are validated against hand-written schemas, Printful's against its OpenAPI spec.
