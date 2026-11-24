# Design review, round 2 — reviewer A

Scope: the brief, the round-1 triage, documents 05–09 and 11, ADR-0010, ADR-0020, ADR-0029, ADR-0034 and ADR-0036. Printful's v2 OpenAPI spec was used to check provider behaviour. The Stripe docs were not consulted for this review. Nothing was run and no external API was called.

## 1. Verdict

**Ready after listed changes.**

The split into payment, fulfilment and dispute is sound. "A paid session always wins" and "expire before close" fix the round-1 late-payment hole. Per-mode databases and per-mode Secrets keep a test order away from live services.

I walked I1–I9 against 05 §4/§7, 06 §4–§8 and 07 §2/§5. The invariants do not yet deliver what ADR-0034 promises, for four reasons:

- I4's "fresh read" cannot exclude a confirm that is still in flight, so a timer can refund an order Printful then charges and ships (F1).
- A partial refund or a false-alarm fraud warning can permanently block an already-paid order from fulfilment, with no alert (F2, F3, F4, F5).
- The attempt model and the single `fulfilment_state` column disagree, so a self-inflicted cancel can trigger an automatic refund of the order's live attempt (F6).
- The retry path after an unknown confirm is undefined and contradicts I3 (F7).

None needs a redesign. Each is a rule or an edge to add.

## 2. Findings

### R2-A-F1 — blocker — 07 §2.6 I3/I4; 06 §4 step 7, §5 `confirming`; 05 §7

**Problem.** I3 writes `confirm_requested_at` before the confirm call. I4 allows an automatic refund when a fresh read shows the provider order is `draft`. A confirm call that timed out or is still in flight leaves the provider order at `draft` for a moment, so the read does not exclude it. Printful's confirm endpoint (`POST /v2/orders/{id}/confirmation`) has no idempotency key, and the spec documents only 200, 401 and 5XX responses for it. A client timeout does not stop the server processing the request.

**Scenario.**
1. The confirm times out at 15 s. The attempt stays `confirming` and a hold is opened, for example because the cost-guard "confirm anyway" fired and then Printful was slow.
2. A refund path runs: the `charge.refunded` alert-then-refund flow, a fraud hold, or a deadline. It writes `refund_requested_at`, reads the order, sees `draft`, and I4 passes.
3. Stripe refunds the customer.
4. The in-flight confirm lands. Printful charges Klaus, produces and ships.

Result: the customer is refunded and Klaus has paid for a shipped print. This is exactly "a confirmed order refunded by a timer."

**Suggested change.**
- Make deletion the arbiter, not a read. Per the v2 spec, `DELETE /v2/orders/{id}` succeeds only for `draft`, `failed` or `cancelled` orders that "must also have not been charged yet and there must be no payments pending". Redefine I4 as: an automatic refund requires that every attempt of the order is deleted or canceled, proven by a 204 or a subsequent 404.
- Add an explicit rule: an attempt with `confirm_requested_at` set and no answer is never refund-eligible until its draft has been deleted successfully. If the delete is refused because the order was confirmed, the attempt becomes `confirmed` and the refund path stops.
- Quiet-period rule: after an unknown confirm, wait at least the client timeout plus a margin (say two minutes) before the first read that can lead to a delete.

### R2-A-F2 — blocker — 07 §2.6 I7 and I2, 05 §4 `charge.refunded`, §7 (partial refunds)

**Problem.** I7 says any refund "(any source, Stripe Dashboard included)" cancels fulfilment if cancellable. The design designates the Stripe Dashboard as the place for partial refunds (05 §7, 08 §3). `charge.refunded` sets `partially_refunded`, then I7 runs. 07 §3 and 05 §7 also set `refund_requested_at`, which I2 and I3 treat as "block fulfilment".

**Scenario.**
1. Klaus gives a goodwill partial refund in the Dashboard for a late or damaged item on a confirmed, not-yet-produced order.
2. I7 cancels the print at Printful. If the order is not yet confirmed, `refund_requested_at` blocks submission.
3. The customer has been given a discount and now receives nothing, or the order is stuck (see F3).

**Suggested change.**
- Condition I2, I3 and I7 on a full refund: `refunded_cents >= paid_cents`, or a refund the shop itself issued as "cancel this order".
- Record a partial refund as an event only. If a partial refund arrives on an unconfirmed order, do not touch fulfilment.
- Raise an informational alert after confirmation only if the amount is large relative to the order.

### R2-A-F3 — major — 05 §7 and 07 §2.6 I3, `orders.refund_requested_at`

**Problem.** `refund_requested_at` is written before the refund and is never cleared. I2 requires it to be null. If the refund then fails (`refund.failed`, an API error, or Klaus aborting), nothing returns the order to a fulfillable state. The `attention` hold for a failed refund (05 §4) offers no "retry fulfilment" resolution, and I2 would reject it anyway.

**Scenario.** An approval hold's deadline fires. The refund job writes `refund_requested_at`. Stripe returns a permanent error, for example an expired card on a refund. The customer is charged, no goods ship, no refund exists, and the only signal is one alert. After resolving the hold Klaus clicks "Approve", and the submit job silently stops on I2.

**Suggested change.**
- Make `refund_requested_at` a refund-attempt record: `refund_requested_at`, `refund_failed_at`, or a `refunds` table.
- Define the transition on failure: the field is cleared when Stripe confirms the failure and the order returns to a hold with a new deadline. The new deadline must be longer than the old one, to avoid a refund-fail loop.
- Name the admin actions for this state: "retry refund" and "fulfil anyway".

### R2-A-F4 — major — 07 §2.1 (`dispute_state`) and §2.6 I2; 05 §4 `radar.early_fraud_warning.created`

**Problem 1.** I2 needs `dispute_state = none`. An early fraud warning sets `warning`. No edge returns it to `none`. If Klaus resolves the `fraud` hold as `approved` (a false alarm), `dispute_state` stays `warning`, so I2 blocks the submit job forever. The money is stranded: paid, approved, never submitted, never refunded, and nothing alerts (see F5). There is also no `fraud` hold outcome for "warning cleared".

**Problem 2.** The `fraud` hold is created from an early fraud warning with `deadline_action = refund`. Nothing says the action is recomputed when a dispute opens later. If `charge.dispute.created` arrives while that hold is open, the deadline refunds a charge whose money the bank has already taken. The design's own text says "no refund" for disputes. That is a double loss.

**Suggested change.**
- Define `dispute_state` transitions, including `warning → none` on hold resolution `approved`.
- Gate I2 on `dispute_state ∈ {open, lost}`, not on anything other than `none` or `won`.
- State that `dispute.created` rewrites the `deadline_action` of open `fraud` holds to `alert`.
- Add to I4: no automatic refund while `dispute_state ∈ {open, lost}`.

### R2-A-F5 — major — 07 §2.6 and §5 step 2

**Problem.** Nothing guarantees that a `paid` order which is not at an end state has an owner (a running job, an open hold, or a refund in progress). Reconciliation step 2 enqueues `order.submit` for `paid` orders with `fulfilment_state = none` and no open hold. The submit job stops if I2 fails ("Otherwise stop", 06 §4 step 1) and creates no hold. So an I2-blocked order is re-enqueued every hour, silently, forever. The invariant test text in 12 §1 says "an open hold with a deadline" is the alternative to a refund or a confirmed order. The invariants as written (I1–I9) do not contain that rule.

**Suggested change.**
- Add I10: every `paid` order with `fulfilment_state ∈ {none, submitting, draft, confirming}` has, within some bounded time, either a runnable job, an open hold with a deadline, or a refund in progress.
- Make the submit job create an `attention` hold, reasons including the blocked condition, whenever I2 fails and no hold exists.
- Encode I10 in the random-sequence test with the mock as the oracle.

### R2-A-F6 — major — 07 §2.2–§2.3, 06 §5 (`order_canceled`), §6, 07 I5

**Problem.** Attempts are rows, but `fulfilment_state` is one column and holds, webhooks and I4 refer to "the provider order" in the singular. Several consequences follow:

- Retrying means canceling attempt N (I5). Printful then sends `order_canceled` for N. Per 06 §5 that opens an `attention` hold with refund action, though the shop did it deliberately.
- A late `order_updated` or `order_canceled` for attempt N, arriving after N+1 is confirmed, would "sync `fulfilment_state`" to `canceled`. Nothing maps an inbound event to an attempt by `external_id`.
- I4 is phrased per provider order, so it can pass on N (`canceled`) while N+1 is confirmed.

**Scenario.** Attempt 1 is stopped by Klaus after the cost-guard hold ("retry submission", 08 §3). The `order_canceled` webhook for attempt 1 arrives. It opens a hold with refund action. The deadline fires while attempt 2 is `submitted`. I4 reads attempt 1, finds `canceled`, and refunds a live order.

**Suggested change.**
- State that webhooks and polls are resolved to an attempt via `external_id`.
- Say only the highest attempt drives `fulfilment_state` and holds.
- Say a cancel the shop issued itself never opens a refund hold.
- Make I4 quantified over all attempts, as in F1.
- Add the missing trigger for N+1, which is never specified. Candidates are the admin "retry submission" action and a provider cancel when the policy is to resubmit. Currently §4 step 2 describes how N+1 may be allocated, but not who asks for it.

### R2-A-F7 — major — 06 §4 step 7 and 07 §5 step 4, I3

**Problem.** Reconciliation step 4 resolves `confirming` attempts "to `confirmed` or back to `draft`". I3 forbids a second confirm for the same attempt. After "back to `draft`" there is no defined way forward. The attempt cannot be confirmed again, and as shown in F1 it cannot be safely refunded.

**Suggested change.**
- Define the route as: delete the draft (arbiter, F1), allocate attempt N+1, restart at §4 step 2, with a bounded number of attempts and then an `attention` hold.
- Add the missing edge `draft → confirming`-blocked to the fulfilment state description.
- State the maximum attempts, so a flapping provider cannot create unbounded drafts.

### R2-A-F8 — major — 07 §2.6 I4 ("`failed` and not charged"), 06 §5

**Problem.** I4 allows an automatic refund when the provider order is `failed` and "not charged". The design does not say how to know "not charged". Printful's status text says `failed` covers "problem with address, printfiles, charging, etc.", and the same status is reached by an order that was charged. The `costs` object is not defined as a charged-indicator, and the design stores `costs_json` only as an estimate. An implementer has to invent the test, and a wrong guess is the "refund a charged order" case.

**Suggested change.** Use the same arbiter as F1: for a `failed` order, `DELETE /v2/orders/{id}` succeeding is the proof it was not charged (the spec says deletion requires "not been charged yet and there must be no payments pending"). If the delete is refused, the refund action becomes `alert`. Update I4 and 06 §7 ("`order_failed` after confirmation" row), and note that the v2 delete applies to `draft`, `failed` and `cancelled`, not only to drafts as 06 §3 and §6 say.

### R2-A-F9 — minor — 07 §3 (modes), 06 §3 order item example, 11 §1, §2.1, 06 §5 webhook script

**Problem.** I found no path by which a test order reaches the live Stripe or live Printful. Keys are per-mode Secrets, the prefix checks hold, and the databases are separate. Four residual weaknesses remain:

- The order-item example hard-codes the live shop address in the file URL. A test-store draft pointing at the live address either fetches nothing or fetches a file that exists only in the live database. The URL must derive from the mode's `PUBLIC_URL`, and test mode needs a publicly reachable test address. The test file-registration step is what verifies this.
- `scripts/printful-webhook.ts` "replaces the token's config". Run with the wrong token or `.env` section, it silently repoints the live store's webhook at the test deployment, and live events are then lost until reconciliation. The script should read the mode, check the store, and show the old configuration before replacing.
- The startup check proves the token belongs to "the mode's store", but the expected store identifier has to come from somewhere. If it sits in the same `.env` as the token, a copy-paste error passes the check. Take the expected identifier from a separate variable per mode and refuse a live start whose store equals the test store.
- `confirm` is gated by one condition, `SHOP_MODE = live`. A second, independent guard is cheap: construct the provider adapter without a `confirm` method outside live mode, so a logic bug cannot reach it.

The runbook should also say how the test and live deployments coexist after go-live: one namespace with `replicas: 1` and `Recreate` implies one app, and 11 §1 does not describe a second one.

### R2-A-F10 — minor — 07 §2.2

**Problem.** §2.2 lists fulfilment states but, unlike §2.1, no edge table. Implied edges the text needs to state:

- `confirming → draft` (07 §5 step 4)
- `canceled → submitting` (I5)
- `on_hold → submitted` (the `order_remove_hold` row)
- `submitted → draft` never

§2.2 calls `canceled` an end state ("followed until `delivered`, `canceled` or `failed`", I6), which contradicts I5's retry-after-cancel. With an end state that is not terminal, I6 stops reconciliation exactly when attempt N+1 would need it.

**Suggested change.** Add the edge table. Define "end state" as terminal for the order, not for an attempt.

### R2-A-F11 — minor — 07 §2.7, §2.4

**Problem.** §2.7 states the conditional-update rule for the three parts only. Holds are not covered. "Approve" by Klaus and the deadline refund can run at the same instant. Both read "open" and both act: one confirms while the other refunds. I3's check covers the confirm side (no refund requested), but the refund side has no equivalent check for "hold resolved as approved just now".

**Suggested change.** Resolve a hold with `UPDATE holds SET resolved_at = … WHERE id = ? AND resolved_at IS NULL`, and let the winner decide: the deadline job proceeds only if its update affected a row, and Approve likewise.

### R2-A-F12 — minor — 07 §2.6 I9, 05 §3 step 1, 07 §3 `carts`

**Problem.** I9 is enforced in application code only. `carts.open_order_id` is a plain column, and nothing prevents two `checkout_open` orders for the cart by a race between two requests. Also unspecified: if the expire call at Stripe fails because the session was just paid, the flow must stop and show the paid order, not "continue" to create a new session as 05 §3 step 1 says. Otherwise the customer pays twice. The cart's fate after payment (cleared on success page or not) is not stated in documents 05 or 07.

**Suggested change.**
- Add `CREATE UNIQUE INDEX … ON orders(cart_id) WHERE payment_state = 'checkout_open'`.
- Specify that an expire call refused with "already complete" routes to the order page.
- State when a cart is emptied or detached (the first paid transition).

### R2-A-F13 — question — 06 §4 step 7, I3

Should the confirm precondition also re-read the charge's `amount_refunded` from Stripe? A refund made in the Dashboard whose `charge.refunded` webhook has not yet arrived is invisible to I3. The window is small (seconds), but one extra read at the moment Klaus's money is committed is cheap compared with the cost of a wrong confirm.

### R2-A-F14 — minor — 07 §2.5

**Problem.** `payment_state = refunded` is the first match in the derived status, so a parcel that is shipped or delivered shows "Refunded". That is probably intended after a "refund anyway", but the status should then say "Refunded — your item may still arrive" when the fulfilment is past `in_production`. `partially_refunded` has no row, so it silently falls through to fulfilment; the customer who got a goodwill refund sees nothing about it.

**Suggested change.** Add one row or a sentence of wording per case, and the Dashboard-refund case in particular.

### Over-engineering (for this volume)

- Fifteen job kinds, a leased queue and a reconciliation of eight forward and one reverse sweep are justified by the failure analysis above, but the random-sequence invariant test is where the real value sits. Spend implementation effort there and cut elsewhere.
- Three database files plus Litestream, Velero and a nightly `VACUUM INTO` at fewer than 10 orders a week: Litestream plus the nightly copy would be enough at launch.
- `emails` per-parcel keys and bounce tracking are fine. `reasons_json` with multiple stored reasons is fine. A separate `dispute_state` column is fine once F4 is fixed.

## 3. Round-1 findings not or wrongly addressed

Ids use the triage's convention ("R1 Fn" = review 1, finding n).

- **R1 F4** (confirm once; refund only after a fresh read): adopted as I3/I4, but the read-based proof is wrong for an in-flight confirm. See F1, F7, F8.
- **R1 F6** (fraud warnings and disputes block or cancel fulfilment): the block has no way back (F4) and the hold action is not recomputed on a later dispute (F4).
- **R1 F8** (all hold reasons; timers): the data is stored, but I2-blocked paid orders get no hold (F5), and hold races are not specified (F11).
- **R1 F10** ("failed" handling): adopted without a defined "not charged" test (F8).
- **R1 F14** (refund details): partial refunds were pushed to the Dashboard, but I7 then treats them as cancellations (F2); `refund_requested_at` has no failure path (F3).
- **R1 F16** (attempts): the table is there, but events, holds and `fulfilment_state` are not attempt-aware (F6, F7).
- **R1 F25** (modes): adopted. Residual gaps in F9.
- **R1 F2** (one open checkout per cart): the enforcement is app-level only (F12).

## 4. Challenges to Accepted ADRs

- **ADR-0010 (Accepted)**: the decision text still says an automatic full refund after 72 h on a Printful billing hold, and the Consequences say Printful cancellations land in a hold where "refunding the customer stays Klaus's decision". The design (06 §7) does the opposite on both counts: a `provider` hold's deadline action is `alert`, and a Printful cancel refunds automatically when I4 allows. The design is right. A billing hold on a confirmed order is exactly the case where a timer refund would refund an order Printful will produce once billing is fixed. The ADR text should be amended, with Klaus's agreement, so the Accepted record does not contradict the design. Consider also what the customer experiences while Klaus's billing hold is unresolved: an alert, not a deadline. A "delayed" e-mail already exists, but there is no end to the wait. A long deadline that alerts again each day would be enough.
- **ADR-0020 (Accepted)**: the Consequences say "held orders then proceed" after a breaker reset. The design correctly releases only holds whose sole reason is the breaker. Update the ADR note so the two agree.

## 5. Things done well

- Payment and fulfilment as separate dimensions, with "a paid session always wins" and "expire before close", close the stranded-money hole of round 1.
- Handlers use only `event.id`, `event.type` and `data.object.id` and re-fetch the rest, with a fixture in the old payload shape to prove it.
- `confirm_requested_at` written before the call, in the same transaction that checks for a refund, is the right shape. It only needs the arbiter of F1.
- Per-mode databases, per-mode Secrets that carry only that mode's keys, key-prefix checks and the store check at startup make a test-to-live leak hard.
- Reverse reconciliation that alerts but does not rebuild rows is the right call after a restore.
- The `jobs_open` partial unique index and `inbound_events` primary key give cheap, effective idempotency.
- Shipping compared on `shipping_cost.amount_subtotal`, not `amount_total`, handles taxed shipping correctly.
- Fail-safe thresholds kept out of the public repository, with the code requiring them in live mode.
