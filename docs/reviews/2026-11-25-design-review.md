# Design review, round 1

- Reviewed: 2026-11-24 (the file keeps the name the brief asked for), `main` at 991245b, branches `capture/2026-11-24` and `capture/2026-11-24b`.
- Reviewer: a separate agent session, launched by Klaus. Read-only: no Printful or Stripe API call, no key used, the capture script not run.
- For: the Shop session (folds the findings into `docs/design/` and the ADRs) and Klaus (decides the items marked **Klaus**).

## 1. Verdict

**Ready to implement after the listed changes.** The architecture is sound and right-sized in most places: hosted Checkout, draft → cost guard → confirm, webhooks as hints followed by a re-fetch, an idempotent submit keyed by `external_id`, a jobs table and an hourly sweep. Nothing needs rework. Three groups of changes should land in the design before the code that depends on them:

1. **Money paths with a hole** (F1, F2, F4, F5): a payment can arrive on an order the shop already closed; a refund can be issued while Printful's state is unknown; a refund from the Stripe Dashboard hides a Printful order that still ships.
2. **Premises that the real content and the real APIs contradict** (F3, F12, F20, F21): the shipping check fails on every order taxed in a state that taxes shipping; Stripe sends webhook payloads in the account's 2017 format unless the endpoint is pinned; 22 of art's 25 works are photographs that art already sells as signed prints, and art promises that the three paintings will never be printed; the shop reads art by scraping its home page.
3. **What is public** (F26, F27, F24): the capture branches hold material that should not be in a public repository, the capture scrubber is a deny-list, and a test deployment is open to strangers.

Klaus's stated goals for this review map to the findings like this:

| Goal | Findings |
|---|---|
| No bad transactions, no wrong orders | F1–F16 |
| Customer kept in the loop | F17–F19 |
| Art → shop data, a second source later (insta) | F20–F22 |
| Testability, mocks in CI | F23–F25 |
| Nothing inappropriate in public repositories | F26–F28 |
| Architecture that can grow, without overhead | F5, F21, F25, F29 |

Severity: **blocker** = can lose money or an order, fix in the design before the code; **major** = will fail or cause manual work in a foreseeable case; **minor** = small fix or clarification; **question** = needs a decision or a fact.

### What I checked against

| Source | How | Used for |
|---|---|---|
| Printful v2 OpenAPI spec (`developers.printful.com/docs/v2-beta/openapi.json`, version 2.0.0-beta) | downloaded and queried 2026-11-24 | F10, F22, F23 |
| Stripe docs: Checkout Session create, webhooks, webhook versioning, tax customer locations | read 2026-11-24 | F3, F12, F13 |
| `art.klaushofrichter.net`: home page manifest, one buy page, all 33 originals (headers and metadata presence only) | fetched 2026-11-24 | F20–F22, F28 |
| `insta.klaushofrichter.net`: `/api/images` (1,188 images) | fetched 2026-11-24 | F21 |
| Both capture branches and the full git history | pattern and field scan | F26 |

Not verifiable by me (as for the author): everything after a Printful confirmation, and Stripe Tax amounts with a registration.

## 2. Findings

### 2.1 Money and orders

**F1 — blocker — A payment can arrive on an order the shop has closed.** `07 §2`, `03 §6`, `05 §3`.
`abandoned`, `expired` and `payment_failed` are terminal and have no edge to `paid`. `GET /checkout/cancelled` marks the order `abandoned` and expires the session through the API.
Scenario: the customer has Stripe's page open in two tabs, or returns through the cancel link and then goes forward again. The shop marks the order `abandoned`; the expire call times out, or the pod restarts between the two steps. The session stays payable for up to 60 minutes. The customer pays. `checkout.session.completed` meets an `abandoned` order, the edge is illegal, and the payment has neither an order nor a refund (Q1).
Change:
- Rule: **a paid Checkout Session always wins.** Add `abandoned → paid` and `expired → paid` (cause `late_payment`), handled like any payment; if the offer is no longer sellable, refund at once.
- Mark `abandoned` only after Stripe confirmed the session is expired (expire call succeeded, or a re-fetch says `expired`).
- Make the cancel return side-effect free (show the cart; the session expires on its own or at the next checkout, F2), or make it a POST. A GET that changes state is also triggered by link previews and history navigation.
- Shorten `expires_at` to 30 minutes, Stripe's minimum. It narrows this window and the one in F2.
- Mock scenario and test: "pay after cancel".

**F2 — major — More than one payable session per cart.** `03 §6`, `05 §3`.
Browser *back* from Stripe lands on `/quote`; **Pay** creates a second order and session while the first stays open. A double-click on **Pay** does the same. Two paid orders follow, the second is caught only by the repeat-customer hold, and Klaus has to act.
Change: one open checkout per cart. At `POST /checkout`, if the cart has a `checkout_open` order whose session is open and whose quote is unchanged, redirect to that session again; otherwise expire the old session (confirmed) before creating a new order. Store the open order id on the cart.

**F3 — major — The shipping check compares a tax-inclusive amount.** `05 §4`.
The job checks `shipping_cost.amount_total` = the order's shipping. With `tax_behavior: exclusive`, `amount_total` is `amount_subtotal + amount_tax`. Where shipping is taxable the two differ, and the order goes to `needs_attention` as "should never happen". Texas taxes delivery charges on taxable goods, and art's About page says the work is made in Texas, so this would hit **every in-state order from the day the registration is added**. The capture could not show it (no test registration, tax 0).
Change: compare `shipping_cost.amount_subtotal`; check `amount_total = amount_subtotal + shipping subtotal + total_details.amount_tax`. Give the mock's tax table one state that taxes shipping and one that doesn't. Keep "Stripe Tax amounts" on the verify list with this case named.

**F4 — major — Automatic refund while Printful's state is unknown; resubmission without proof of cancellation.** `06 §4`, `06 §7`, ADR-0010.
Scenario: the confirm call times out (`Unknown`) and Printful stays unreachable for the retry window. The order goes to `needs_attention` and is refunded by timer. Printful had confirmed: it charges Klaus and ships. The mirror case: a cancel answer is lost, the shop resubmits as `<id>-2`, and two orders ship.
Change:
- Write `confirm_requested_at` on `provider_orders` **before** calling confirm.
- An automatic refund requires a fresh, successful read of the Printful order showing a state that cannot be charged (not found, `draft`, `canceled`, `failed` and not charged). Otherwise the order stays where it is and Klaus is alerted.
- Attempt N+1 is allocated only after a successful read shows attempt N `canceled` or gone.
- Never confirm when a refund exists or a refund job is open (checked in the same transaction as the write above).
- State these as invariants and test them (F23).

**F5 — major — `refunded` as a terminal state hides a live Printful order; payment and fulfilment are one dimension.** `07 §2`, `07 §5`.
"Any paid state → `refunded`" on a full `charge.refunded` makes the order terminal. Reconciliation step 3 follows only non-terminal orders, nothing tries to cancel at Printful, and later shipment webhooks meet a terminal state. Scenario: Klaus refunds in the Stripe Dashboard while the order is `submitted`; it ships anyway and the shop never notices. `needs_attention` has the same weakness from the other side: it forgets where the order was (draft exists? confirm attempted?).
Change (architecture, cheap now, a migration later): two fields instead of one.
- `payment_state`: `unpaid | paid | partially_refunded | refunded | disputed`
- `fulfilment_state`: `none | submitting | submitted | on_hold | in_production | partially_shipped | shipped | delivered | canceled | failed`
- A **hold** record instead of the states `awaiting_approval` and `needs_attention`: `{reason(s), since, deadline_at, resolved_by}`. It also gives the timers a home (F8).
- The customer-facing status is derived from the three (F17).
- A refund triggers "cancel fulfilment if still cancellable, otherwise alert". Reconciliation follows fulfilment until Printful reports an end state, whatever the payment state.
This removes about eight special edges and the "annotation" workaround for refunds and disputes on delivered orders.

**F6 — major — Disputes and early fraud warnings don't stop fulfilment.** `05 §4`.
`charge.dispute.created` only annotates. Scenario: a stolen card, the order is held or still a draft, the bank reports fraud, Klaus approves from the alert e-mail without seeing it, or the hold is released by a breaker reset.
Change: subscribe `radar.early_fraud_warning.created`. On a warning or a dispute: not yet confirmed → block submission (warning: refund; dispute: do not refund, the bank already took the money back); confirmed and cancellable → cancel; otherwise alert.

**F7 — major — The repeat-customer hold collides with one picture per order.** `06 §8`, ADR-0008, ADR-0020.
A customer who wants two pictures must place two orders. The second is held ("same email or card within 24 h"), waits for Klaus, and is refunded after 72 h if he is away. The shop's best customers get its worst experience, and Klaus becomes a step in a normal purchase (R9).
Change: make the rule cumulative (hold when the same email or fingerprint has paid more than `APPROVAL_OVER_CENTS` in 24 h, or placed three or more orders), and see the challenge to ADR-0008 in §3.

**F8 — major — Hold and release semantics are underspecified.** `06 §8`, `07 §2`.
- After **Approve**, the order returns to `paid` and the fail-safe check "runs once in the job that follows `paid`": nothing says it won't hold the order again. Needs `approved_by`, `approved_at`.
- The check stops at the first hit (breaker first). An order that is also over the amount or flagged by Radar is recorded as "breaker" only, and **Reset breaker** releases it without anyone looking. Evaluate every condition, store all reasons; a reset releases only orders whose sole reason is the breaker.
- The timers (72 h, 24 h) have no mechanism. Use `deadline_at` on the hold, enforced by reconciliation and visible in the admin.
- Radar's level and the fingerprint need `expand: ['payment_intent.latest_charge']`; both are absent for Link and some wallets. Say what a missing value means (not a hold reason).

**F9 — major — Run the cost guard before payment; the quote is no longer one call.** `05 §2`, `06 §4`, Q6.
Step 5 of the quote already fetches Printful's exact cost through the estimation task. Compare it with the price there: if the order would fail the guard, don't offer **Pay** and alert Klaus, instead of taking the money, holding 24 h and refunding. Keep the post-payment guard as the backstop.
Also: the quote is now shipping rates (about 1 s) plus an estimation task (POST and at least two polls, 2–3 s). Q6 ("< 3 s, one Printful call") no longer holds. Run both in parallel, show progress, state which shipping amount is charged if the two disagree, and redo the rate-limit arithmetic (a quote costs at least four Printful calls).
On open question 5 (tolerance): not needed. With retail well above wholesale the guard fires only on gross misconfiguration; use a positive `MARGIN_FLOOR_CENTS` rather than a tolerance in the other direction.

**F10 — major — Printful states and events the design doesn't cover (from the v2 spec).** `06 §2`, `06 §5`.
- Order status `inreview` exists; the normalised list has no place for it.
- `costs.calculation_status` can be `failed`; step 4 only knows `calculating` and `done` and would poll forever.
- `order_put_hold` and `order_failed` carry a free-text `reason` only. The design branches on "billing" versus "other" holds. Don't parse the text: alert at once on every hold or failure, one deadline.
- Webhook bodies have `occurred_at`, `retries` and `store_id`, no `created`. Build the event id from `occurred_at`; check `store_id` against the configured store.
- Not subscribed: `shipment_put_hold_approval`, `shipment_remove_hold`, `approval_sheet_status_changed`.
- The webhook configuration has `expires_at` (default null). Register with null and show it on the System page.
- The shipment in a webhook has no carrier, service or estimated delivery; those come from `GET /v2/orders/{id}/shipments` (the design re-fetches, so this is a note for the mock).
- `GET /v2/orders` filters only by limit and offset (relevant to F15).

**F11 — minor — Schema contradicts the limits.** `07 §3`. `order_items.quantity CHECK (BETWEEN 1 AND 10)` rejects 11–25 postcards, which `06 §8` allows; the insert at `POST /checkout` would fail. Drop the upper bound from the schema; limits are configuration.

**F12 — major — Stripe renders webhook payloads in the endpoint's API version, not the request's.** `05 §4`, `05 §8`.
The design pins `2026-11-18.endive` for API calls because the account default is `2017-04-06`. A webhook endpoint created without `api_version` gets the account default, so `event.data.object` would arrive in the 2017 shape.
Change:
- Create the endpoint with `api_version` set to the pinned version.
- Rule for handlers: use only `event.id`, `event.type` and `data.object.id` from the payload; everything else comes from the re-fetch (already the design's intent; make it a rule so nobody parses the payload).
- The mock sends the pinned shape; one fixture in the 2017 shape proves the handler doesn't care.
- Who registers the endpoint, with which credential? The restricted key has no permission for webhook endpoints. Either Klaus creates it in the Dashboard, or the script gets its own short-lived key. **Klaus.**

**F13 — minor — Checkout Session parameters to add.** `05 §3`.
- `payment_method_types` (or `excluded_payment_method_types`) set in code, so a Dashboard toggle can never enable a delayed method. The async handlers stay as a safety net.
- `payment_intent_data.shipping` with the recipient: Radar uses it, the Dashboard shows it, dispute evidence starts from it.
- `payment_intent_data.description` with the order number, so Stripe's receipt carries it.
- `custom_text.submit.message`: "Ships to Jane Doe, 1 Main St, Austin, TX 78701". The customer cannot see or change the address on Stripe's page otherwise.
- Handle `customer_tax_location_invalid` at session creation as an address error on the form, not as "payment unavailable". Stripe Tax validates the Customer's shipping address and does not fall back.

**F14 — minor — Refund details.** `05 §7`.
- Treat `charge_already_refunded` as success.
- A refund can fail later: subscribe `refund.failed` / `refund.updated`; move to `refunded` only on a succeeded refund.
- Idempotency keys live 24 h at Stripe. Before any refund, read the charge's `amount_refunded`; don't rely on the key alone.
- Partial refunds: leave them to the Stripe Dashboard at launch (the shop already picks them up through `charge.refunded`), see F29.

**F15 — major — Reconciliation only looks outward; the restore runbook promises more than exists.** `07 §5`, `11 §5`, ADR-0014.
Every step starts from a local row. Nothing lists recent Printful orders or paid Stripe sessions and asks "do we know this one, in a matching state?". The restore runbook says "reconciliation catches up from Stripe and Printful": after a restore, an order paid in the lost seconds has no local row, so it is never fulfilled and never refunded.
Change: add a reverse sweep (last N Printful orders, paid sessions of the last days; an unmatched or mismatched one is an alarm), and state honestly that it alerts and does not rebuild.

**F16 — minor — Smaller data points.**
- `provider_orders` has the primary key (order, provider): a resubmission overwrites the cancelled attempt. Key by attempt.
- "`submitted (test)`" (`06 §4` step 6) is not in the state machine.
- Sequential order numbers (`S-2026-000123`) show customers the sales volume. A choice, not a defect. **Klaus.**

### 2.2 Keeping the customer in the loop

**F17 — major — Customer e-mails belong in the launch scope.** `09`, R8, ADR-0021.
Without them the only way to the status page is the browser returning from Stripe. On phones, wallet and 3-D Secure flows often don't return; tabs get closed. The customer has paid and holds a receipt without a link; a delay or an automatic refund happens silently; every question becomes an e-mail to Klaus (R9). SES is required for alerts anyway (ADR-0015), so the extra cost is four templates.
Change:
- At launch: confirmation (with the status link), shipped (one per parcel, with tracking), delayed (hold or failure older than a set time), refunded or cancelled.
- A **find my order** page: order number and e-mail → the link is sent again by e-mail, never shown; same answer whether or not the order exists; rate-limited.
- One customer vocabulary, derived from F5's fields, with honest wording for holds ("we're checking your order", not "preparing" for 72 h and then "refunded").
- Bounces: SES reports them; mark the order and show it in the admin, because a mistyped address means the customer hears nothing.
- Non-live modes send only to an allow-list.

**F18 — minor — Status page.** `03 §7`.
- The token sits in the query string, so it is in the ingress access log (question to Cluster, §5) and stored at Stripe as `success_url`. Exchange it for an HttpOnly cookie and redirect to the clean URL, and keep query strings out of the shop's own logs.
- Show per-parcel contents and the estimated delivery; say early that an order with paper and apparel ships in two parcels (the capture shows two facilities).
- Refresh by itself while "confirming your payment".

**F19 — question — Does Printful get the customer's e-mail and phone?** `06 §3`. `recipient.email` and `phone` are optional in the spec. Sending them lets Printful or a carrier contact the customer; not sending keeps one voice. Recommendation: no e-mail to Printful at launch, phone only if the customer gave one, say so in the privacy text, check at the first live order. **Klaus.**

### 2.3 Catalog, content and the art → shop handoff

**F20 — major / Klaus — The content is not what the design assumes.**
art's manifest on 2026-11-24 has 25 works in three rooms: **3 paintings** (*Colors*), **7 dog photographs**, **15 food photographs**, plus 8 detail views that are not works. The design, the requirements and the skeleton's pages speak of paintings throughout ("Reproductions of the original painting", "prints of paintings").
- art's *Colors* room, its meta description and its About text say the paintings are "one of one — there are no prints of these … no prints and no editions". The design's running example is a framed print of *Undertow*, a *Colors* painting. One of the three is sold.
- art already sells the photographs as "Archival pigment print, personally signed", $60–110, by enquiry. The shop would offer an unsigned Printful print of the same image under the name "Art print 8 × 10".
Decisions for **Klaus**: are the paintings offered at all; how the shop's prints are named and priced next to art's signed prints; which texts on art change at launch.
For the design: wording comes from data (a `kind` per work: painting, photograph), not from templates; no "enable every SKU by default"; `04 §5.3`'s measurements should be redone on the 25 works (the dog photographs are 3054 × 2290, about 286 DPI at 8 × 10, not "≥ 289"; *Made in Texas* is 12 × 7, so a 4:5 crop removes a quarter of it). Crops matter more than "1–3 minutes per painting" suggests.

**F21 — major — Replace scraping with a contract: a content-source interface and a feed.** `04 §4`, `03 §2`, ADR-0009, ADR-0025.
Today the shop would parse `<script id="manifest">` out of art's home page, build original URLs from the room id and file name, and hot-link art's derivatives, whose URL scheme lives in art's `app.js` and is not in the manifest. The manifest carries things the shop has no use for (prices and sale status of originals, the About block with the contact address), and the shop stores it whole in `pictures.manifest_json`. The skeleton's CSP (`img-src 'self' data:`) forbids the hot-linked images. A second source is already planned.
Change:
1. **`ContentSource`**, the sibling of `FulfilmentProvider`: `listWorks()`, `fetchOriginal(work)`. One adapter per source; only the adapter knows the source's format.
2. **The shop's own `Work` shape**, validated, allow-listed, nothing else stored: `source`, `id`, `title`, `creator`, `year`, `kind`, `canonicalUrl`, `original {url, widthPx, heightPx, contentHash}`, `printsAllowed`.
3. **Key by `(source, id)` now.** URLs `/p/<source>/<id>` (keep `/p/<uid>` as art's alias). A composite key added later touches pictures, offers, order items, render keys and public URLs.
4. **Consent at the source**: a per-work flag in the feed ("prints allowed"). The admin's enable is the second key. It settles F20 where the work is described, and insta needs it.
5. **A real feed on art** (for example `/feed/works.v1.json`, versioned), or at least a contract test: the adapter against a recorded copy of art's manifest, and the daily check ADR-0009 already mentions raising an alarm on a schema mismatch.
6. **The shop makes its own display images** in the render job (it runs `sharp` there anyway) and serves them itself. Pages no longer depend on art's uptime or URL scheme, the CSP stays `'self'`, and Lighthouse has no third-party origin to wait for.
7. **Every image the shop serves is re-encoded and carries no metadata** (print files already, `04 §5.2` step 4; extend to display images, mockups and uploaded masters). One test asserts it for every served image type.

What insta would bring (from its `/api/images`): 1,188 images; ids like `<shortcode>_<nn>`; mostly 612–1440 px squares, so only postcards, mugs and t-shirts pass the DPI floor and the SKU set has no square print; captions, not titles; snapshots that include shop interiors and brand names. So: opt-in per image with a rights check, never in bulk, and a title field in the admin.

**F22 — minor — Print files and Printful's file library.** `04 §5`, `04 §6`.
- `POST /v2/files` takes `visible: false` ("Show file in the Printfile Library"). Use it with `role: printfile`; the accepted cost "the library only grows" goes away.
- Order layers accept a `url` only, no file id. Say plainly that registration is a pre-flight check and that orders still reference the URL.
- `sharp` with `limitInputPixels`, and size and type limits on uploaded masters (decompression bombs).
- 16 × 20 from 12 MP is 144–189 DPI. A higher `minDpi` for paper (180–200) or leaving 16 × 20 out at launch is a quality decision. **Klaus.**
- Open question 9 is answered by the spec: `orientation` (`horizontal | vertical | any`) exists on the order item, "applies only to products that allow multiple orientations such as framed posters"; the mockup request has it too. Still verify the unframed poster with a draft.

### 2.4 Testability and the mock services

**F23 — major — Right-size the mock verification and close its contradictions.** `14`, `12`, ADR-0024.
1. **Contradiction.** `14 §7.2` says Printful recording is "read-only and order-free … if Klaus later allows draft orders". Both captures already created and deleted drafts with his permission, and `12 §1` uses a draft for the contract fixtures. Put draft create → get → patch → delete and the estimation task into the recorder; they are exactly what the submit job parses.
2. **Drop shadow mode (`14 §7.3`) for now.** It is a mock-specific path inside the adapter (against M1), it puts the real Printful token into a deployment whose safety argument is "no real keys by construction" (R19), and it adds little over the weekly record-and-compare.
3. **The invented part is the important part.** Everything after confirmation (statuses, shipments, cancel of a confirmed order, `order_failed`, the webhooks) is built from the spec alone. Mark those mock behaviours "spec-derived, unverified" in code. Plan the recorder to run **during the go-live test orders** (`12 §4`): record every webhook body with its signature headers and every GET, scrub, commit as fixtures; cancel one confirmed order on purpose to record the v1 cancel.
4. **Validate requests, not only responses.** The mock checks every request against the OpenAPI spec and, in tests, fails on unknown fields. Printful tends to ignore a misspelled field silently; a strict mock is the only place a typo in `orientation` shows.
5. **Stripe mock fidelity:** form-encoded bodies with bracket keys; reject a request whose `Stripe-Version` is not the pinned one; idempotency replay returns the first response; `expand[]`; Stripe's error envelope; the session `url` must be the public address of the mock page in a test deployment (a setting), and same-origin for the CSP's `form-action`.
6. **One scheduled run against real Stripe test mode**: Playwright through the real hosted page with card 4242 and a real test webhook, weekly on the cluster and before go-live. `14 §7.2` calls it optional; it is the cheapest real check there is.
7. **Control API additions:** duplicate delivery; reordered delivery; pay after cancel; two paid sessions for one cart; dispute and early fraud warning; refund failure; costs `failed`; `inreview`; confirm that times out after succeeding; cancel whose answer is lost; a webhook with a bad signature or a stale timestamp.
8. **One clock.** The shop's own timers (quote expiry, 24 h, 72 h) need the controllable clock too: a `Clock` interface, no direct `Date.now()` (lint rule). For a deployed mock environment, a clock offset the process refuses outside mock mode.
9. **Invariant tests.** Random sequences of actions (pay, duplicate webhook, timeout, cancel, refund, dispute, clock advance) against shop and mocks, with the mock's state as the oracle. After each run: every paid session has at most one confirmed Printful order, or a full refund, or an open hold with a deadline; never confirmed and fully refunded without an admin override; the amount charged equals the quote. This is the test that finds F1 and F4, and it is cheap once the mock exists.
10. **Mock keys must not look real.** `rk_test_mock_…` and a fixed `whsec_…` in a public repository can trip secret scanners. Keep them short and oddly shaped, and run a secret scan in CI to prove it.
11. **Size.** "A third of the shop" is optimistic; expect about the same again. Build each mock piece when the shop step that needs it starts, not ahead.

**F24 — major — A test deployment is open to the public.** `14 §9`, `11 §2`.
`shop.klaushofrichter.net` resolves publicly, and the mock checkout is routed through the ingress so a tester can buy from a phone. A stranger can do the same and is told "Payment received". In real test mode a real card is declined, but the stranger's name and address land in the database and in a Printful **draft in Klaus's account**. The TEST and MOCK banners exist only in the admin.
Change: in every non-live mode, a banner on every public page, `noindex`, an empty `/api/offers` (art shows no link), e-mail only to an allow-list, and a preview gate (a shared key that sets a cookie, or the admin sign-in) until go-live.

**F25 — major — One mode switch, one database per mode, one Printful store per mode.** `11 §2`, `05 §8`, `14 §3`.
- Today four settings must agree (`STRIPE_MODE`, `FULFILMENT_CONFIRM`, two base URLs) and a guard rejects bad pairs. Use one `SHOP_MODE = mock | test | live` that derives the rest; keep the key-prefix checks.
- Test orders and live orders share one database. After go-live, reconciliation would re-fetch test session ids with the live key and raise alarms, and a test order must never be confirmed. Simplest and strongest: a database file per mode.
- Printful allows one webhook configuration per token, and its own documentation says "create a separate store to test". A second store with its own token for mock recording and test mode keeps drafts, the file library and the webhook configuration away from the live store, and makes F15's reverse sweep meaningful there. **Klaus** (creating the store and token).

### 2.5 Security, privacy and what is public

**F26 — major — The capture branches and the capture scrubber.** Branches `capture/2026-11-24`, `capture/2026-11-24b`; `scripts/capture/capture-apis.mjs`.
The branches are public. A scan of both and of the full history found **no API key, token, webhook secret or password**, no real person's data, and landmark or fake addresses only. It did find, by category (exact locations went to Klaus, not into this file):
- payable Stripe Checkout URLs and PaymentIntent client secrets, test mode, from sessions whose recorded expiry time has passed (not checked against Stripe);
- the account's publishable test key, encoded inside those URLs' fragments, so the key pattern did not match;
- the Stripe account's business display name and branding file ids;
- a constant segment of the account id inside every Stripe object id, although `acct_` itself is replaced;
- the Printful store id and store name;
- request ids, object ids and Printful dashboard URLs.
Why it matters beyond these two branches: the scrubber replaces known secret **values** and a few key patterns, and nothing by field name. Response headers are an allow-list; bodies are not. Printful's webhook `secret_key` is a bare hex string that no rule matches; it is absent only because no webhook is registered yet. `SUMMARY.txt` bypasses the scrubber, and `GET /v1/events` records whatever the account did last, which after go-live is customer data.
Change:
- Delete both branches after extracting scrubbed fixtures; re-record. **Klaus** decides on the branches.
- Scrub by **allow-list**: per endpoint, the fields that may be kept verbatim; everything else is replaced by a typed placeholder. Ids are rewritten to synthetic ones consistently.
- A fixtures check in CI: e-mail only at `example.com`, addresses only from a fixed list, no `client_secret`, no `url` to a provider's pay page, no id that matches a live prefix.
- The same scrubber in front of anything else that leaves the cluster for the repository: recorded webhooks, the drift report that `14 §7.2` wants to open as a GitHub **issue**, CI artifacts.
- Never record from the live account.

**F27 — major — What the public documents give away.** `06 §8`, `11`, ADR-0020, `docs/handover.md`.
- **The abuse thresholds with their exact numbers** ($250 hold, $500 cap, the repeat rule, the breaker at 10 orders or $600, 72 h to an automatic refund). Someone abusing the shop reads them and stays below. Publish the mechanism; keep the numbers in deployment configuration that is not public (question to Cluster on kube-setup, §5).
- **Operational detail**: the LAN range, the `.env` path on the node, Secret and deploy-token names, the Google Cloud project name, the note about a secret that was exposed and rotated, Printful file ids. None is a credential; together they are a map. Rule for this repository: no incident notes, no host paths, no account or object ids; those live in the private vault.
- Wholesale prices and the placeholder retail prices are public too. Printful's prices are public anyway; the margin is Klaus's to show or not. **Klaus.**
- Turn on secret scanning with push protection for the repository if it isn't (Cluster).
- CI logs and artifacts are public: e2e data stays synthetic, the live check never opens an order or admin page, and the server log printed on failure must hold no personal data (already the logging rule; add a test).
- The test-only sign-in route "absent from the production build" needs an exact mechanism: registered only in mock mode with an explicit flag, and the process refuses to start with that flag and a real key.

**F28 — minor — Privacy and web details.** `10`, `07 §6`.
- **Source images.** A metadata finding on the source site went to Klaus directly and is not described here. For the shop it becomes rule 7 of F21.
- Addresses are purged 90 days after the order ends, but a chargeback can arrive later and needs the shipping proof. Either keep the address 180 days, or rely on the copy at Stripe (F13 puts it on the PaymentIntent) and say so.
- One Stripe Customer per order stays at Stripe forever with name and address. Delete it in the purge job, or name it in the privacy text.
- Rate limits also on `POST /checkout` and on wrong status tokens; CSRF on the public forms as well as the admin's.
- The OAuth flow: add a nonce or PKCE next to `state`.

### 2.6 Simpler, later, or not at all

**F29 — over-engineering (checklist 6, open question 13).**
Keep: the jobs table, the event ledger, hourly reconciliation, the thin provider interface. They are what makes Q1 and Q2 true, and they are small.
Defer or drop, without risk at this volume:

| Item | Instead |
|---|---|
| Shadow mode (`14 §7.3`) | weekly record-and-compare (F23) |
| `catalog_price_changed`, `catalog_stock_updated`, `mockup_task_finished` webhooks | the daily check and polling that exist anyway |
| `/metrics` and a Grafana rule in addition to e-mail alerts | e-mail alerts and the uptime check; metrics when something needs a graph |
| Partial refunds in the admin | Stripe Dashboard; the shop records them from `charge.refunded` |
| Tax export page | Stripe Tax's own report is what gets filed; keep the per-order tax fields |
| The 5-minute quote cache | the per-IP limit |
| SKUs page, "re-register webhooks" button | config file and the script |
| Draggable crop box | a centred crop plus a nine-position anchor and a preview; add dragging if the anchor isn't enough |
| Billing-hold versus other-hold branches | one path (F10) |

### 2.7 Pieces an implementer would have to invent

Not defects, but each needs one sentence in the design:
- The address: what "normalised" means; which characters Printful accepts; PO boxes, military addresses, US territories in the state list.
- Which shipping amount is charged when rates and the estimate disagree (F9).
- Order number allocation (a counter row in the same transaction).
- The e-mail texts and the customer status vocabulary (F17).
- The startup check of the Printful token's scopes (`/v2/oauth-scopes` exists).
- What the status page shows for an order that is `checkout_open` and not from the return URL.
- Returns and reshipments: who pays, which order number.

### 2.8 Inconsistencies in the documents

- ADR-0012: the Options and Decision sections are interleaved mid-sentence.
- ADR-0010's consequences send Printful cancellations to `needs_attention` with the refund left to Klaus; `06 §7` refunds automatically.
- ADR-0007 and ADR-0011 still describe `allowed_countries` and comparing addresses after payment; ADR-0023 replaced that.
- ADR-0002's consequences still list the internal originals endpoint (ADR-0025 removed it).
- ADR-0013 puts the audit trail in `order_events`; the schema has `admin_audit`.
- `10 §6` calls ADR-0012 pending and `01` A4 calls ADR-0011 proposed; both are Accepted.
- `01` Q4 says originals are never publicly reachable; ADR-0025 says they are public on art.
- `docs/handover.md` counts 13 design documents (14).
- `deploy-production.yml`: "Adapted from klaushofrichter/shop" names itself.
- `06 §5`: the event id uses `created`; the field is `occurred_at`.

## 3. Challenges to Accepted ADRs

**ADR-0008 (one picture per order).** Reason: a concrete cost and a conflict with ADR-0020 (F7). Two postcards of different pictures mean two orders, two shipping charges of several dollars each, two Stripe fixed fees, and a second order that is held for approval. The restriction also costs code rather than saving it: the "replace your cart?" confirmation exists only because of it, while order items, print files and the Printful order body are per item already. Proposal: the cart takes items of any picture; the picture page stays the entry point. If Klaus keeps the ADR, F7's rule change is required.

**ADR-0021 (customer e-mails optional at launch).** Reason: F17. Klaus's goal for this review is that the customer is kept in the loop; without the confirmation e-mail the loop depends on a browser tab.

**ADR-0024 (mock services), in part.** The decision stands. Challenged: shadow mode, the "no drafts" premise that the captures already left behind, and the size estimate (F23).

**ADR-0009 and ADR-0025 (art handoff, originals from public URLs).** The decisions stand. Challenged: the shop depending on art's page markup and derivative URLs, and the bare `uid` as key (F21).

**ADR-0020 (fail-safes).** The decision stands. Challenged: publishing the numbers (F27), the repeat-customer rule (F7), first-hit evaluation (F8).

**ADR-0003 (build, not buy).** Confirmed, with two corrections to its basis. The research counts "about 25 paintings × 5 products" of manual setup in a hosted store; that is a one-time day of work, and on money alone Shopify Starter wins. What carries the decision is the deep link from the picture, the own pages, and above all a second source: 1,188 images cannot be set up by hand anywhere. The running cost is a beta API (ADR-0005) and the mocks; F23 and F29 keep that in proportion.

## 4. Done well: please keep

- Hosted Checkout with the address entered once and passed on a Customer (ADR-0023); verified by capture.
- Draft → wait for costs → cost guard → confirm, with the claim row and the `@external_id` lookup before every create.
- Webhooks as hints: verify, store, enqueue, answer 200, re-fetch.
- The conditional state update with a transition row in one transaction.
- Print files rendered, validated and registered **before** an offer can be sold; content-addressed, immutable URLs; EXIF stripped.
- Capturing the real APIs before designing against them. The findings that changed the design (API version pin, address check before payment, file library) are exactly the kind a review can't find on paper.
- Money as integer cents with exact decimal parsing at the adapter edge.
- Named-key Secrets, the live key absent until go-live, the prefix check at startup.
- Every exception has a timer that ends in a refund; Klaus is never a step in the normal path.
- The go-live rule "one real order per product kind, and refund one".
- The capture script's allow-list of endpoints and its hard refusal of confirmation.

## 5. Answers and open questions

### The design's open questions (`13 §3`)

| # | Answer |
|---|---|
| 1 Build vs buy | Build (§3, ADR-0003). |
| 2 One picture per order | Lift it (§3, ADR-0008). |
| 3 Shipping without address collection | Works (captured). Add F13's parameters. |
| 4 Print files at unguessable URLs | Acceptable; the same pixels are public on art. Use `visible: false` (F22). |
| 5 Cost-guard tolerance | None; check before payment (F9). |
| 6 art's link only for enabled pictures | Yes, through `/api/offers`, per source (F21). |
| 7 Alerts channel | SES e-mail from the start; metrics later (F29). |
| 8 Mug layout | Taste. **Klaus.** |
| 9 Orientation | The field exists (F22); verify the unframed poster with a draft. |
| 10 Thresholds and the 72 h refund | Mechanism right; fix F7 and F8; numbers out of the repository (F27). |
| 12 Street addresses | No address service. Show the address on Stripe's pay button (F13); accept the rare return. |
| 13 Over-engineered? | F29. |

### For Klaus

1. Are the three paintings offered as prints, against art's "no prints" statement? (F20)
2. Naming and prices of the shop's prints next to art's signed archival prints. (F20)
3. The capture branches: delete and re-record? (F26)
4. A second Printful store for test and recording. (F25)
5. Who creates the Stripe webhook endpoint, and with which key. (F12)
6. E-mails at launch; one picture per order. (§3)
7. E-mail and phone to Printful. (F19)

### For Cluster

I could not reach the Cluster session from this one. The questions:
1. The self-hosted runner and a public repository: can a pull request from a fork that edits a workflow to `runs-on: [self-hosted, k3s]` get a job onto the runner? (Fork-approval setting, runner group limited to chosen workflows and branches, ephemeral runner.) What can the runner's service account and network reach?
2. Is kube-setup public? It decides where the fail-safe numbers can live. (F27)
3. Does the ingress access log keep query strings? (F18)
4. How are `/metrics` scraped and alerts routed today? (`11 §4`)
5. Secret scanning and push protection on `klaushofrichter/shop`. (F27)

## 6. Suggested order for folding this in

1. F26 (the public branches) and F27 first: they are independent of the design.
2. Klaus's answers on F20 and ADR-0008, because they change pages and the cart.
3. F5 (two state fields and holds), then F1, F2, F4, F6, F8 on top of it; F21's `(source, id)` key and `Work` shape. These change the schema, so they come before step 2 of the build order.
4. F3, F9–F15 into `05`, `06`, `07`.
5. F23–F25 into `12` and `14` before the mocks are started (build step 2a).
6. F17 into `09` and ADR-0021.

A second review round is useful once 3 is written down: the state tables are where the remaining mistakes would be.
