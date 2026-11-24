# ADR-0030: Stripe webhook endpoints created by Klaus in the Dashboard, with the pinned API version

- Status: Proposed
- Date: 2026-11-25
- Decided by: (pending, Klaus)

## Context

Stripe tells the shop about payments by calling a URL the shop exposes (a "webhook endpoint"): when a Checkout Session is paid or expires, a refund changes, a dispute opens. Each endpoint is registered at Stripe with its URL, the list of events, and an API version; Stripe signs every delivery with an endpoint-specific secret (`whsec_…`), which the shop uses to check the delivery is genuine. Test mode and live mode have separate endpoints and secrets.

Two facts from the captures and review 1 (F12): the account's default API version is `2017-04-06`, and an endpoint created without a version sends its payloads in the default shape; and the shop's restricted key has no permission to create endpoints (deliberately).

## Options considered

1. **Klaus creates each endpoint in the Stripe Dashboard** (Developers → Webhooks → Add endpoint): the URL, API version `2026-11-18.endive`, the event list below; he copies the signing secret into the node's `.env`. Two minutes per mode, no extra key.
2. A setup script with a temporary full secret key: automatable, but a broad key exists for a while.
3. Give the restricted key webhook-endpoint permissions: a standing broader key for a one-time task.

## Decision

Option 1 proposed:
- **Test endpoint** when the test deployment is reachable (step 10): URL of the test deployment's `/webhooks/stripe` (exempt from the preview gate), secret → `STRIPE_TEST_WEBHOOK_SECRET`.
- **Live endpoint** at go-live: `https://shop.klaushofrichter.net/webhooks/stripe`, secret → `STRIPE_LIVE_WEBHOOK_SECRET`.
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `refund.updated`, `refund.failed`, `charge.dispute.created`, `charge.dispute.closed`, `radar.early_fraud_warning.created`.
- The shop uses only `event.id`, `type` and `data.object.id` from a payload and re-fetches the rest with the pinned version, so a wrong endpoint version can't corrupt data; the admin's System page shows the last event received per type, so a missing or misconfigured endpoint is visible.

## Consequences

- A short runbook with screenshots-free steps in the private repository.
- In mock mode the mock signs with a fixed test secret; no Dashboard step.
