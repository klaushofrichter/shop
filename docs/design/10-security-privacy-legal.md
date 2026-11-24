# 10. Security, privacy and legal

## 1. Assets

| Asset | Why it matters |
|---|---|
| Stripe restricted keys, webhook secrets | Create charges and refunds, read customers |
| Printful token | Create orders that charge Klaus's Printful account |
| Google OAuth client, `COOKIE_SECRET` | Admin access |
| `ART_INTERNAL_TOKEN` | Full-resolution originals of the paintings |
| Customer data (names, emails, addresses) | Personal data |
| Print files | Full-resolution reproductions |
| The order database | Money records |

## 2. Threats and controls

| Threat | Control |
|---|---|
| Price manipulation (browser sends a lower price) | Prices computed server-side from config and Printful; the browser sends only ids and quantities (Q3). Checkout re-validates before creating the session. |
| Forged webhooks (fake "paid") | Stripe: `Stripe-Signature` with the endpoint secret, 300 s tolerance. Printful: HMAC-SHA256 with the config's secret key, public-key match. Both: the shop re-fetches the object from the API before acting. |
| Replayed webhooks | `inbound_events` unique on (provider, event id); state transitions conditional on the current state. |
| Double fulfilment | Claim row + `@external_id` lookup + Printful's own unique `external_id` (§06.4). |
| Abuse of the quote endpoint (spends Printful's 120 req/min) | Per-IP rate limit (keyed on a normalised IP, IPv6 /64), quote caching, CAPTCHA not needed at this volume. |
| Card testing via Checkout | Stripe Radar (on by default); sessions are created only after a valid quote, rate-limited per IP. |
| Admin takeover | Google sign-in, allow-list checked on every request, HMAC cookie, CSRF tokens, `no-store`; no passwords stored. |
| XSS | Server-rendered with escaping by default; strict CSP without `unsafe-inline` (already in place); manifest text from art is escaped like user input. |
| Enumeration of orders | Status page requires the token; wrong token → 404; order ids are random. |
| Originals leaking | Originals only via art's internal endpoint (token, in-cluster, `/internal` blocked on art's public route); the shop doesn't store them. Print files are full-resolution but unguessable (accepted risk, ADR-0019). |
| Secrets leaking | Secrets only in Kubernetes Secrets created from the node's `.env` by Cluster or Klaus; never in git, logs or chat. The app logs no headers, no tokens, no full addresses. Startup checks log only *which* variables are present. |
| Dependency vulnerabilities | `npm audit` gates in CI, Dependabot, CodeQL (cluster baseline). |
| Container escape / privilege | Non-root (uid 1000), drop ALL capabilities, no privilege escalation, seccomp RuntimeDefault (cluster rule). |
| Network | Default-deny NetworkPolicy: ingress from Traefik only; egress DNS, TCP 443 to public addresses (cluster and LAN ranges excluded, since provider addresses change), and art's pods. |
| Deploy credentials in the app | The app's Secret is built from named keys only; GitHub tokens and the live Stripe key (before go-live) never enter the pod ([11 §1](11-operations.md#1-deployment)). |

## 3. PCI

Card data is entered only on Stripe's hosted Checkout page; the shop never sees it.
That is PCI DSS SAQ A, the lightest level (an annual self-assessment Stripe prompts
for in its Dashboard).

## 4. Privacy

- Collected: name, email, shipping address, phone (optional), order contents. Purpose: fulfilling and supporting the order. Shared with Stripe (payment), Printful (production and shipping, which passes the address to carriers), the email provider (if enabled).
- No analytics cookies, no third-party scripts on shop pages. Cookies: `shop_cart` (functional), `shop_admin` (admin only), Stripe's on its own domain. No consent banner needed for functional cookies.
- Retention as in [07 §6](07-orders-data-jobs.md#6-retention-and-purge). Deletion requests: Klaus can purge an order's personal data from the admin (amounts stay for accounting).
- If EU/UK shipping is enabled later (ADR-0011), GDPR applies to those customers; the privacy policy must name the processors and the retention.

## 5. Legal pages (texts are Klaus's)

| Page | Must cover |
|---|---|
| Terms of sale | Seller identity and contact, prices in USD (tax note), payment by Stripe, production by a print partner, shipping times as estimates, governing law. Linked from Checkout (`consent_collection`). |
| Shipping & returns | Printed to order: no change-of-mind returns; misprints and damage reported within 30 days with a photo are reprinted or refunded (mirrors Printful's policy); lost parcels. |
| Privacy | §4. |
| Contact | An email address for order questions. |

The shop renders these from Markdown files in the repo (`content/legal/*.md`), so
changing a text is a PR. Drafts can be prepared for Klaus to edit; they are not legal advice.

## 6. Tax

See [05 §6](05-quote-checkout-payment.md#6-tax) and ADR-0012 (pending). Not tax advice:
whether and where Klaus must collect sales tax is for him and his adviser.
