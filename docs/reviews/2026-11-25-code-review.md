# Code review after steps 2–8: findings to fix

- Reviewed: branch `claude/lucid-planck-x9ie75` at abbd7c0, which is `main` at 3aeb3b0 (step 8) plus the `/simplify` commits. Line numbers are from that commit.
- For: the Shop session. Eight findings are open (F1–F8), all in code that was already on `main`. Two more were introduced or exposed by the `/simplify` work and are already fixed on the branch (§3).
- How it was done: one reviewer, one pass. Read in full: the `/simplify` diff, `src/orders/*`, `src/payments/stripe.ts`, the Printful adapter's order calls, the job runner, the admin order actions, the sessions and sign-in. **Not** reviewed in the same depth: `mocks/`, `src/images/`, `src/catalog/`, `src/public/quote.ts`, `src/sources/`.
- State of the branch: type check clean, 189 unit tests pass, the eight Chromium browser tests pass locally against the mocks. The other three browsers, Lighthouse and CodeQL have only run in CI on `main`, not on this branch.

Each finding has: where, what happens, a scenario, the fix, and the test that should fail before the fix and pass after.

## 1. Order of work

| # | Finding | Why first |
|---|---|---|
| F1 | A Stripe timeout at checkout locks the cart for 24 hours | loses a sale on a transient error |
| F2 | No "shipped" e-mail for a parcel first seen before it shipped | may affect most real orders; tests can't see it |
| F3 | Any partial refund blocks confirmation for good | a paid order that can never be fulfilled |
| F4 | The retry-window hold only applies before the draft exists | a paid order waits for weeks without an alert |
| F5 | The cost half of the circuit breaker is never evaluated | a required setting that protects nothing |
| F6 | A refund request after a full refund is stranded | hourly re-runs and a hold nobody can clear |
| F7 | Non-form POSTs to public forms answer 500 | noise, and an error where a refusal belongs |
| F8 | Paying an older checkout empties the current cart | the customer loses what they added |

F1–F4 before the first deployment in test mode (step 9); F5 before go-live; F6–F8 when convenient.

## 2. Open findings

### F1 — A Stripe timeout at checkout locks the cart for 24 hours

**Where:** `src/orders/checkout.ts:92` and `:157`, `src/orders/reconcile.ts:56`.

**What happens:** When `createCustomer` or `createCheckoutSession` gets no answer, a 5xx or a 429, the order stays `checkout_open` without a `stripe_session_id` and the customer sees "Payment is unavailable right now". On the next **Pay**, step 1 finds an open order without a session id and answers `unavailable` again. Reconciliation only closes such an order once it is older than 24 hours. Both comments say reconciliation "repeats the create with the same key", but nothing reads `orders.checkout_idempotency_key`.

**Scenario:** Stripe answers 503 once. For the next 24 hours every retry from that browser shows the same page.

**Fix:**
- In `startCheckout` step 1, for an open order without a session id: repeat `createCustomer` (key `customer-<order id>`) and `createCheckoutSession` (the stored key) for **that** order, then redirect.
- The repeat must send identical parameters, or Stripe refuses the key. `expires_at` is computed from the clock at call time (`sessionParams`), so store it on the order at creation and reuse it; if it has passed, close the order (`closeUnpaid`) and start a new one.
- A `permanent` or `idempotency` answer on the repeat closes the order, as the first attempt does.
- Correct the two comments, and `07 §2.1.1` if it describes the repeat as reconciliation's job.

**Test:** mock Stripe answers 503 to the first session create; the second `POST /checkout` from the same cart must redirect to a session, and exactly one order must be `checkout_open`.

### F2 — No "shipped" e-mail for a parcel first seen before it shipped

**Where:** `src/orders/fulfilment-events.ts:87`; hidden by `mocks/printful/server.ts:525`.

**What happens:** `syncShipments` queues the e-mail only when the shipment row is new **and** its status is `shipped`. Printful's v2 spec gives shipments the states `pending`, `onhold`, `packaged`, `outstock` before `shipped`. Reconciliation step 3 calls `syncShipments` every hour for every confirmed order, so if Printful lists a shipment before it ships, the row is inserted as `pending`; when `shipment_sent` arrives, the row exists, `isNew` is false, and no e-mail is queued. The mock only adds a shipment at the moment it ships, so no test covers the earlier states.

**Scenario:** Confirmed at 10:00; at 11:00 the sweep inserts a `pending` shipment; it ships the next day; the customer never gets the tracking link.

**Not verified against Printful:** whether the real API lists unshipped shipments (the enum says it can). Worth one look at a real order during the go-live orders.

**Fix:**
- Queue the e-mail for every shipment whose status is `shipped` and whose `emails` row (`shipped`, shipment id) is not sent. The `emails` key and the open-job index already make it once per parcel.
- The mock: create shipments as `pending` at confirmation and move them to `shipped` later, so the path is exercised.

**Test:** a shipment synced as `pending`, then as `shipped`: exactly one `email.send` job for it; synced as `shipped` twice: still one.

### F3 — Any partial refund blocks confirmation for good

**Where:** `src/orders/submit.ts:331` (`confirmAttempt`).

**What happens:** `i2Failures` allows `partially_refunded` on purpose (round-2 triage: only a full refund cancels). `confirmAttempt` then reads the charge and blocks when `amount_refunded > 0`, opening a `fulfilment_blocked` hold. Approving that hold runs into the same check.

**Scenario:** An order waits in an approval hold; Klaus refunds a few dollars in the Stripe Dashboard as goodwill and approves. Submit passes the cost guard, reads the charge, blocks, alerts. Every approval repeats it.

**Fix:** block only when the charge is fully refunded (`amount_refunded >= amount`). Check that the cost guard still uses what was actually kept if that matters for the margin (`costGuard` takes `paid_cents`, not the refunded amount).

**Test:** a partial refund recorded before confirm; the order must reach `submitted`. A full refund must still block.

### F4 — The retry-window hold only applies before the draft exists

**Where:** `src/orders/submit.ts:309`.

**What happens:** When Printful is unavailable, the `provider_unavailable` hold is opened only if the attempt is still `submitting`. Once a draft exists (`draft`), every failure is rethrown and the job retries up to 1,000 times with a backoff capped at 30 minutes, about 20 days. A 404 from `getOrder` (the draft was deleted at Printful) is a `permanent` error and takes the same path. Reconciliation's I10 check sees a queued job and raises nothing; no hold means no "delayed" e-mail.

**Scenario:** Draft created, costs calculating; Printful answers 500 for two days. The customer sees "checking your order"; Klaus gets warn-level log lines only.

**Fix:**
- Apply the retry window in every pre-confirm state. Measure it from the first failure, not from `updated_at`, which `adoptProviderOrder` renews on every successful read.
- Treat a 404 on a known draft as "gone": mark the attempt `deleted` and open an `attention` hold (a new attempt is Klaus's decision, I5).
- Let I10 treat an `order.submit` job that has been failing for longer than the window as "nothing in progress".

**Test:** attempt in `draft`, mock Printful answers 500 past the window: a hold is open and an alert was logged. Draft deleted at the mock: the attempt becomes `deleted` and a hold is open.

### F5 — The cost half of the circuit breaker is never evaluated

**Where:** `src/orders/payment.ts:114`; `src/config.ts:17`, `:130`.

**What happens:** `BREAKER_COST_CENTS_24H` is a required setting and `06 §8` describes it, but `breakerCostCents24h` is read nowhere. Only the order count trips the breaker.

**Fix:** either implement it or remove it.
- Implement: in the payment transaction, sum the provider cost (`provider_orders.costs_json`, confirmed attempts) since `max(now − 24 h, breaker_reset_at)` and add `breaker` when it exceeds the limit.
- Remove: drop the setting from `LIMIT_VARS`, `.env.example` and `06 §8`, and tell Cluster the ConfigMap key is gone.

The design also says the breaker "trips (stored in `settings`)". The code recomputes the count each time, so it un-trips by itself when old orders leave the 24-hour window. Decide which is meant and make `06 §8` and the code agree. **Klaus** decides if the behaviour changes.

**Test:** with the cost limit exceeded and the order count below its limit, the next paid order is held with reason `breaker`.

### F6 — A refund request after a full refund is stranded

**Where:** `src/orders/refunds.ts:139` (`syncPayment`), `requestFullRefund`, `onEarlyFraudWarning`.

**What happens:** `syncPayment` returns early when the charge's `amount_refunded` equals the stored value, before it marks `requested` refunds as succeeded and resolves holds. If a refund is requested after the charge is already fully refunded and synced, `runRefund` finds nothing left, calls `syncPayment`, and the row stays `requested`. Reconciliation re-runs it every hour. The usual way in: an early fraud warning for an order Klaus already refunded. It also opens a fraud hold; if the parcel shipped, the hold turns into a daily alert with no action that clears it.

**Fix:**
- In `syncPayment`, run "mark requested refunds as covered" and "resolve holds on a full refund" even when the amount is unchanged.
- `requestFullRefund`: when nothing is left to refund, don't create a row.
- `onEarlyFraudWarning`: for an order that is already `refunded`, record the warning (`dispute_state`) and stop; no hold, no refund.

**Test:** full Dashboard refund synced, then an early fraud warning: no `requested` refund remains, no open hold, the order completes.

### F7 — Non-form POSTs to public forms answer 500

**Where:** `src/public/router.ts:89` (the `csrf` middleware; the inline checks it replaced behaved the same).

**What happens:** Express 5 leaves `req.body` undefined when no parser matched. The middleware reads `._csrf` from it and throws. Reproduced: a JSON body to `/cart/items` and an empty body to `/order/find` both answer 500.

**Fix:** read `req.body?._csrf`. The handlers behind the middleware only run after the token matched, so they always have a parsed body.

**Test:** both requests above answer 403.

### F8 — Paying an older checkout empties the current cart

**Where:** `src/orders/payment.ts:126`.

**What happens:** The cancel return is side-effect free, so a customer can go back to the cart, change it, and still pay the first session. `applyPayment` then deletes every `cart_items` row of that cart. The statement after it is guarded by `open_order_id = ?`; the delete is not.

**Scenario:** Stripe is open for order A; the customer returns, adds a mug, and pays A in the other tab. The mug is gone from the cart.

**Fix:** delete the items only when `carts.open_order_id` is this order **and** the cart still matches the order's quote (`quote_id` is cleared when the cart changes). Otherwise leave the items and only detach the order.

**Test:** pay after adding an item: the added item is still in the cart; pay without changing the cart: the cart is empty.

## 3. Already fixed on the branch

| Finding | Commit |
|---|---|
| A hold's reminder alert went out once a minute (up to about 1,440 e-mails before a refunding deadline), and reconciliation alarms hourly: `enqueue` only refuses a duplicate while the first job is open. | b883bd2 |
| That fix keyed alerts by message, order and day, so a second, different alarm on the same day was dropped. The key now includes the alert's details; a failed alert job no longer counts as sent. Changelog line added. | abbd7c0 |

## 4. Left over from `/simplify`

Not bugs. Listed so they aren't lost; none is urgent.

| Item | Where |
|---|---|
| Reconciliation makes one Stripe call per paid order of the last 90 days, every hour. A paged charge list would do; it may need another permission on the restricted key (**Klaus**). | `src/orders/reconcile.ts` step 5 |
| Every print-file render downloads and decodes the original again (about 12 downloads for a work with 11 products). | `src/catalog/offers.ts` |
| The memory test `docs/design/11 §1` promises (peak below 384 MiB) doesn't exist; the render still holds the whole raw original. | `src/images/printfile.ts`, `test/` |
| Three Stripe-fee estimates differ slightly: the quote check uses the revenue, the cost guard `paid_cents`, the admin page `paid_cents` without a fallback. | `src/public/quote.ts`, `src/orders/submit.ts`, `src/admin/orders.ts` |
| Payment, dispute and completion changes are inline SQL; only fulfilment has a transition function. Three dispute updates are unconditional, and completion writes no history row. | `src/orders/refunds.ts`, `src/admin/orders.ts`, `src/orders/reconcile.ts` |
| Hold resolution writes a history row only for admin actions. | `src/orders/holds.ts` (`resolveHolds`) |
| Mode comparisons in business code instead of capabilities derived once in `config.ts`. | `submit.ts`, `email/jobs.ts`, `purge.ts`, `public/router.ts`, `admin/orders.ts` |
| Two e-mail job dialects (`shipment`/`shipmentId` and `shipped`/`ref`), normalised in the receiver; a test asserts the old key. | `fulfilment-events.ts`, `email/jobs.ts`, `test/fulfilment-events.test.ts` |
| Code that matches on the shop's own message text. | `submit.ts` (`i2Failures` strings in `blocked`), `email/jobs.ts` (`'payment applied'`), `admin/orders.ts` (`reasons_json = '["breaker"]'`) |
| `test/checkout.test.ts` copies about 80 lines of `test/helpers/harness.ts`. | `test/` |
| The three mocks have three control styles; refund, dispute and SES scenarios have no HTTP route, so they can't be used when the mocks run as a container. | `mocks/` |

## 5. Status (Shop session, 2026-11-25)

| Finding | Status |
|---|---|
| F1 | Fixed: the next Pay repeats the create for the open order with its own keys and the stored session expiry (mode migration 5); 07 §2.1.1 updated. |
| F2 | Fixed: an e-mail for every shipped parcel whose e-mail isn't sent; mock Printful lists a `pending` shipment from the confirmation on. |
| F3 | Fixed: only a full refund blocks the confirm. |
| F4 | Fixed: the window counts from the attempt's first failure (`failing_since`, migration 5) in every state before the confirm; a draft gone at Printful marks the attempt deleted and opens `provider_order_missing`; I10 counts a submit job failing for twice the window as nothing in progress. |
| F5 | Fixed: the cost half is built; the breaker resets itself; Klaus's Reset re-enables everything at once (ADR-0042, Klaus 2026-11-25). |
| F6 | Fixed: covered refund requests and holds are settled even when the amount didn't change; no row when nothing is left; a warning on a refunded order is recorded and stops. |
| F7 | Fixed: `req.body?._csrf`. |
| F8 | Fixed: the cart is emptied only when it is still the one the order was made from. |

Tests for each are in `test/review-fixes.test.ts`.
| §4 transitions | Done: `setDispute` and `completeOrder` in `src/orders/holds.ts` (conditional, with a history line naming the cause or rule); every hold resolution writes a history line. |

