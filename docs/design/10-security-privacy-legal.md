# 10. Security, privacy and legal

Revised for review round 2 (2026-11-25): data minimisation (ADR-0031), the public
repository's rules (ADR-0028), the self-hosted runner and fork pull requests, the
review's privacy and web details.

## 1. Assets

| Asset | Why it matters |
|---|---|
| Stripe restricted keys and webhook secrets | Create charges and refunds, read customers |
| Printful tokens (live store, test store) | Create orders that charge Klaus's Printful account |
| Google OAuth client, `COOKIE_SECRET` | Admin access |
| Customer data (names, e-mails, addresses) | Personal data |
| The order database | Money records |
| The deploy runner | Runs in the cluster |

## 2. Threats and controls

| Threat | Control |
|---|---|
| Price manipulation | Prices computed on the server from config and Printful; the browser sends only ids and quantities; checkout re-validates. |
| Forged webhooks | Stripe signature (300 s); Printful HMAC with public key and `store_id` check; the shop re-fetches before acting and uses nothing else from a payload. |
| Replayed or reordered webhooks | Event ledger unique on (provider, event id); conditional updates; re-fetch gives the current state. |
| Double fulfilment, lost money | The invariants I1–I9 of [07 §2.6](07-orders-data-jobs.md#26-invariants), tested by random sequences against the mocks ([12](12-testing.md)). |
| Abuse of the quote endpoint (Printful's 120 calls/min) | Rate limits per client address (IPv6 per /64); one Printful call per quote. |
| Card testing, stolen cards | Stripe Radar; sessions only after a valid quote, rate-limited; early fraud warnings and disputes stop fulfilment; fail-safe holds ([06 §8](06-fulfilment.md#8-fail-safes-against-large-or-unusual-orders)). |
| Abuse that reads the thresholds | The fail-safe **numbers** live in deployment configuration in kube-setup (private), not in this repository; the docs describe the mechanism (review 1 F27). |
| Admin takeover | Google sign-in with `state`, PKCE and `nonce`; allow-list checked on every request; HMAC cookie; CSRF tokens and same-origin checks; `no-store`. No test login route exists: e2e tests mint a real session cookie with a test secret (review 2 F8). |
| CSRF on public forms | Tokens on cart, address, checkout and find-my-order forms. |
| XSS | Escaping by default; strict CSP (`default-src 'self'`, no `unsafe-inline`, `img-src 'self'`, `form-action 'self' https://checkout.stripe.com`); source texts escaped like user input. |
| Order enumeration | Random order ids; status token (128 bits) exchanged for a cookie; wrong token → 404; rate limits on token checks and on find-my-order; find-my-order never reveals whether an order exists. |
| Hostile images | `limitInputPixels`, type and size limits on uploads, every served image re-encoded without metadata. |
| Secrets leaking | Kubernetes Secrets built from named keys only (`scripts/create-secrets.sh`); deploy tokens and the live Stripe key never in the app pod before go-live; logs carry no headers, query strings, tokens or full addresses; secret scanning and push protection are on for the repository (Cluster, 2026-11-25). |
| **Fork pull requests reaching the in-cluster runner** | Cluster found (2026-11-25): on a public repository a fork PR's workflow can request `runs-on: [self-hosted, k3s]`; after one merged PR a contributor's fork PRs run without approval; today's runners have a privileged Docker-in-Docker sidecar. For the shop: the runner has **no Docker-in-Docker** (the deploy job needs only `kubectl`, `git`, `sed`; images are built on GitHub's runners), an **egress NetworkPolicy** (Kubernetes API and GitHub only), RBAC on the one Deployment, and the repository requires **approval for all outside contributors'** workflow runs. Cluster is addressing the other runners cluster-wide. |
| Container | Non-root (uid 1000), drop ALL, no privilege escalation, seccomp RuntimeDefault. |
| Network | Default-deny NetworkPolicy: ingress from Traefik; egress DNS, TCP 443 to public addresses (cluster and LAN ranges excluded), art's pods. |
| Test deployments reached by strangers | Preview gate, banner, `noindex`, empty `/api/offers`, e-mail allow-list ([03 §9](03-customer-journey.md#9-before-go-live)); a test store at Printful and Stripe test mode (ADR-0029). |

## 3. PCI

Card data is entered only on Stripe's hosted page: PCI DSS SAQ A.

## 4. Privacy

**Principle (ADR-0031, Klaus 2026-11-25):** send no personal data that isn't needed; if
it's ever needed for tracking or progress information, ask the customer's consent.

| Recipient | What it gets | Why |
|---|---|---|
| Stripe | name, e-mail, shipping address (Customer and PaymentIntent) | payment, receipt, tax, fraud screening, dispute evidence |
| Printful | name and shipping address only — **no e-mail, no phone** | to produce and ship; tracking reaches the shop by webhook, so Printful and the carriers needn't contact the customer |
| Amazon SES | the customer's e-mail address and the e-mail contents | order and shipping e-mails the customer receives (ADR-0027) |

- If a carrier ever requires a phone number (e.g. a future express or international option), the checkout asks for it with a consent line naming its use.
- Cookies: `shop_cart`, order-status cookies, `shop_admin`, the preview key in non-live modes. All functional; no consent banner needed. No analytics, no third-party scripts on shop pages.
- Retention ([07 §6](07-orders-data-jobs.md#6-retention-and-purge)): personal data 180 days after the order's end (chargebacks), then purged; Stripe Customers deleted at the same time; amounts kept 10 years.
- Deletion on request: the admin purges an order's personal data (amounts stay).

## 5. What may be in this public repository

ADR-0028. Allowed: code, design, decisions, synthetic test data, public facts
(product ids, public prices, public URLs). **Not allowed**: credentials; raw API
captures; account, store or object ids of real accounts; host paths and LAN details;
incident notes; the fail-safe threshold values; customer data of any kind. These go to the
private repository (`shop-private`, no CI) or to kube-setup (private). A CI check on
fixtures enforces the synthetic rules ([12 §1](12-testing.md#1-layers)).

## 6. Legal pages (texts are Klaus's)

| Page | Must cover |
|---|---|
| Terms of sale | seller and contact, USD prices with the tax note, payment by Stripe, production by a print partner, shipping estimates, governing law; linked from Checkout |
| Shipping & returns | printed to order: no change-of-mind returns; misprints and damage reported within 30 days with a photo are reprinted or refunded; lost parcels |
| Privacy | §4, naming Stripe, Printful and Amazon SES, the retention periods |
| Contact | an address for order questions |

Rendered from Markdown in the repository (`content/legal/*.md`). Drafts on request; not
legal advice.

## 7. Tax

ADR-0012, [05 §6](05-quote-checkout-payment.md#6-tax), [research/sales-tax.md](../research/sales-tax.md). Not tax advice.
