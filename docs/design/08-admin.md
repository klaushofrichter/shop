# 8. Admin

Revised for review round 2 (2026-11-25): works by source, holds instead of states, PKCE in the sign-in, fewer pages (review 1 F29), threshold values not shown in public docs. Round 2 fold-in (2026-11-26): hold actions per reason, refunds as records, linked reshipments.

## 1. Principle

The admin is where Klaus **sets things up** (which pictures, which products, at what
price) and where he **looks** when told about an exception. It is never a step in
processing an order (R9). An order that needs his hands is the exception in
[06 §7](06-fulfilment.md#7-failure-handling), and each such case has a timer that
resolves it automatically if he doesn't act.

## 2. Sign-in

The cluster's hand-rolled Google OAuth pattern (ADR-0013, vault "Building a New Service"):

- `/admin/*` without a session → `/admin/login` (a 200 page with **Sign in with Google**), never a direct bounce to Google.
- `GET /auth/google/login` → Google with `scope=openid email`, a random `state` **and a PKCE code verifier plus a `nonce`** in short-lived cookies (review 1 F28).
- `GET /auth/google/callback` → check `state`, exchange the code with the PKCE verifier, check the ID token's `nonce`, `verifyIdToken({ audience: GOOGLE_CLIENT_ID })`, email verified and in `ALLOWED_EMAILS` (comma-separated, compared lower-case and trimmed) → session cookie `shop_admin` = HMAC-signed `{email, exp}` with `COOKIE_SECRET`, `HttpOnly; Secure; SameSite=Lax; Path=/`, 12 h.
- `GET /auth/logout` clears the cookie with the same attributes and lands on a 200 "Signed out" page with a Sign in link.
- Admin responses: `Cache-Control: no-store`. State-changing requests: POST with a CSRF token (double-submit, tied to the session) and a same-origin check.
- Kill switch: rotate `COOKIE_SECRET` and restart: every session ends.
- `ALLOWED_EMAILS` is checked at sign-in **and** on every request, so removing an address takes effect at once.

## 3. Pages

| Page | Content | Actions |
|---|---|---|
| **Dashboard** `/admin` | Mode banner (MOCK / TEST / LIVE); open **holds** with kind, reasons and time to deadline ("refunds automatically in 17 h"); the circuit breaker; orders by derived status (today, 7 days); last reconciliation and its alarms; backup age; the runner's heartbeat; addresses refused by the ZIP ↔ state check (count, to spot a false rejection). | — |
| **Works** `/admin/works` | Every work from every source: thumbnail, title, source, kind, original size, `prints_allowed` (from the source), enabled, offers and readiness (print file, provider file, mockup). | Enable/disable a work (only where `prints_allowed`); refresh sources; a title override (sources with captions). |
| **Work** `/admin/works/:source/:work` | One row per SKU: enable, price (default shown), orientation, effective DPI (refused below `minDpi`), a preview of the crop with **nine anchor positions** (review 1 F29: no draggable box at launch) and how much of the picture it cuts, print file and provider-file status, mockup. | Enable/disable an offer; price override; anchor; upload a print master; regenerate the mockup. |
| **Orders** `/admin/orders` | Search by number, e-mail, status, date. | — |
| **Order** `/admin/orders/:id` | Items by picture; amounts (paid, tax, Stripe fee, Printful cost, margin); payment, fulfilment and dispute state; holds with their reasons and actions; refunds (requested, succeeded, failed); attempts at Printful (including linked reshipments); shipments with their shipment and delivery status; e-mails sent; the full event history; links to the order in the Stripe and Printful dashboards. | **Approve** (approval hold); **false alarm** (fraud hold from an early fraud warning: `warning → none`); retry submission (attempt N+1, at most 3, [07 §2.4](07-orders-data-jobs.md#24-submission-attempts)); confirm anyway (cost-guard hold, recorded on the attempt); cancel at Printful; **full** refund, or **refund anyway** on an order in production (no hold follows); **retry refund** and **fulfil anyway** after a failed refund; resend an e-mail (a fresh e-mail key); purge personal data. Each asks for confirmation; a hold is resolved by a conditional update (only the first action wins) and every action is written to `admin_audit`. |
| **System** `/admin/system` | Version, mode, preview gate, the configured stores and their webhook configuration (and expiry), whether Printful is verified, Stripe endpoint health (last event received per type, and its API version next to the pinned one), rate-limit headroom, job queue and heartbeat, recent alarms. | Run reconciliation now; **reset the circuit breaker** (sets `breaker_reset_at`); on a reverse-sweep alarm for an unknown Printful order, **link it to order N as a reshipment**. |

Dropped for launch (review 1 F29): the SKU page (config file), the tax report (Stripe Tax's
report is what is filed; per-order tax stays recorded), a "re-register webhooks" button
(the script), partial refunds (Stripe Dashboard), a reship action (Klaus reships in Printful's dashboard and links it; review C).

## 4. What the admin cannot do

- Switch modes (`SHOP_MODE`, a deployment change, R14).
- Create SKUs (config + deploy, ADR-0022).
- See or change secrets.
- Edit an order's amounts or items after payment (refund and a new order instead).

## 5. Setting up a work (the only routine admin work)

1. Open the work (it must have `prints_allowed` from its source), enable it, and enable the SKUs it should offer. Nothing is enabled by default.
2. Check each crop preview; choose another anchor if the centred crop cuts something important (landscape works use the landscape variant of each size).
3. Optionally set prices other than the defaults.
4. Wait for the print files (seconds), their registration at Printful (~10 s) and the mockups (minutes, rate-limited). The work becomes sellable when its first offer is ready; art shows its link within 10 minutes.

Effort: a few minutes per work, once (R10). Crops deserve a look: a 3:4 crop of a 4:5
painting removes little, but very wide works lose more.
