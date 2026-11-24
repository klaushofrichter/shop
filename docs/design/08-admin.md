# 8. Admin

## 1. Principle

The admin is where Klaus **sets things up** (which pictures, which products, at what
price) and where he **looks** when told about an exception. It is never a step in
processing an order (R9). An order that needs his hands is the exception in
[06 §7](06-fulfilment.md#7-failure-handling), and each such case has a timer that
resolves it automatically if he doesn't act.

## 2. Sign-in

The cluster's hand-rolled Google OAuth pattern (ADR-0013, vault "Building a New Service"):

- `/admin/*` without a session → `/admin/login` (a 200 page with **Sign in with Google**), never a direct bounce to Google.
- `GET /auth/google/login` → Google with `scope=openid email`, random `state` in a cookie.
- `GET /auth/google/callback` → check `state`, exchange the code, `verifyIdToken({ audience: GOOGLE_CLIENT_ID })`, email verified and in `ALLOWED_EMAILS` (comma-separated, compared lower-case and trimmed) → session cookie `shop_admin` = HMAC-signed `{email, exp}` with `COOKIE_SECRET`, `HttpOnly; Secure; SameSite=Lax; Path=/`, 12 h.
- `GET /auth/logout` clears the cookie with the same attributes and lands on a 200 "Signed out" page with a Sign in link.
- Admin responses: `Cache-Control: no-store`. State-changing requests: POST with a CSRF token (double-submit, tied to the session) and a same-origin check.
- Kill switch: rotate `COOKIE_SECRET` and restart: every session ends.
- `ALLOWED_EMAILS` is checked at sign-in **and** on every request, so removing an address takes effect at once.

## 3. Pages

| Page | Content | Actions |
|---|---|---|
| **Dashboard** `/admin` | Orders by state (today, 7 days), anything in `awaiting_approval` / `needs_attention` / `on_hold` with its timer ("refunds automatically in 17 h"), the circuit breaker's state, last reconciliation, backup age, mode (TEST/LIVE banner). | — |
| **Pictures** `/admin/pictures` | Every picture in art's manifest: thumbnail, title, source pixel size, enabled offers, readiness (print files, mockups). | Enable/disable picture; refresh manifest. |
| **Picture** `/admin/pictures/:uid` | One row per SKU: enable, price (default shown), effective DPI with warning colours, crop preview with a draggable crop box (fill SKUs), print file status, mockup. | Enable/disable offer; set price override; adjust crop (re-renders); upload a print master; regenerate mockup. |
| **SKUs** `/admin/skus` | The configured SKUs with Printful's current wholesale price, availability, print area, default retail price, typical margin. Read-only (SKUs are config, ADR-0022). | — |
| **Orders** `/admin/orders` | Search by number, email, state, date. | — |
| **Order** `/admin/orders/:id` | Everything: items, amounts (paid, Stripe fee, Printful cost, margin), address, Stripe and Printful ids with links to their dashboards, shipments and tracking, the full transition history, emails sent. | **Approve** (held order); retry submission; confirm anyway (cost guard); cancel at Printful; refund (full or partial); resend email. Each asks for confirmation and is written to `admin_audit`. |
| **System** `/admin/system` | Versions, mode, webhook registration status (Stripe, Printful), last events received, rate-limit headroom, job queue, recent alarms. | Run reconciliation now; re-register webhooks (test mode only from the UI); **reset the circuit breaker**. |

## 4. What the admin cannot do

- Switch between test and live mode (a deploy configuration change, R14).
- Create SKUs (config + deploy, ADR-0022).
- See or change secrets.
- Edit an order's amounts or items after payment (refund and a new order instead).

## 5. Setting up a picture (the only routine admin work)

1. Open the picture, enable the SKUs it should offer (all of them by default if the DPI allows).
2. Check the crop previews; adjust if a crop cuts something important.
3. Optionally set prices other than the defaults.
4. Wait for the print files (seconds) and mockups (minutes, rate-limited); the picture goes live in the shop when its first offer is ready, and art shows its link within 10 minutes.

Estimated effort: 1–3 minutes per painting, done once (R10).
