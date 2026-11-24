# Design review, round 2 — reviewer C

- Reviewed: `main` at ee42663 (the design as revised after round 1), all of `docs/design/` 01–14, ADR-0001–0036, the workflows, the skeleton and the capture script.
- Also read: the two other round-2 reviews (A, B) and their triage on branch `review-round-2`. This file does not repeat them. §2 holds only what they don't contain; §3 says where I agree and where the triage's own decisions need a second look before they are folded in.
- Checked against: Printful's v2 OpenAPI spec (2.0.0-beta, downloaded for this review), Stripe's docs (webhooks and versioning, Checkout Session create, line items), art's live manifest and originals (sizes only). No Printful or Stripe API call, no key, nothing run from the project.
- I wrote review 1 of round 1. Two of the problems below are side effects of what I proposed there (C-F4, and the catalog problem in B F3); they are marked.

Severity as in round 1: **blocker** = money or an order can be lost; **major** = fails or causes manual work in a foreseeable case; **minor** = small fix or clarification; **question** = needs a decision or a fact.

## 1. Verdict

**Ready to implement after the listed changes.** No rework.

The revision is careful and most of round 1 is really in the documents. The state-model problems (in-flight confirm, partial refunds, attempts, dispute ends) are found and well handled by reviews A and B and their triage; I walked the same paths and agree with their fixes (§3). What they leave open is mostly **around** the state model:

1. **The fail-safes can be skipped** by a restart at the wrong moment, because the check is a separate step after `paid` and nothing records that it ran (C-F1).
2. **The shop refuses to start when Printful is unreachable** (C-F2), and **nothing watches the job runner or the one alert channel** (C-F4): two ways for the whole system to stop silently.
3. **Orders have no completion rule**: a parcel that is never marked delivered is polled every hour forever and its personal data is never purged (C-F3).
4. **The go-live sequence** exposes Klaus's own test orders to the public, and three documents disagree on whether anything is recorded from live services (C-F5).

Answers to the brief's four questions, with A's and B's fixes assumed:

| Question | Answer |
|---|---|
| Can money be stranded? | Not through the checkout. Yes in two quiet ways: an order whose parcel is never marked delivered never ends (C-F3), and a stalled runner strands everything without an alert (C-F4). |
| Can an order be fulfilled twice? | No path found. The triage's new "reship" action adds one that needs the same guard as confirm (§3). |
| Can a timer refund a confirmed order? | Not once delete is the proof (A F1, B F8). |
| Can a test order reach a live service? | No path found. |

## 2. Findings

### C-F1 — major — The fail-safe check can be skipped
**Where:** `05 §4` (row `checkout.session.completed`: "`payment_state → paid` … Then the fail-safe check"), `05 §5` (the success page "performs the same transition"), `06 §4` ("enqueued when payment is `paid` and the fail-safe check passed"), `07 §5` step 2.

**Problem:** Recording the payment and evaluating the fail-safes are two steps, and no field says the second one ran. Reconciliation step 2 enqueues `order.submit` for every `paid` order with fulfilment `none` and no open hold. An order whose check never ran looks exactly like one that passed. The same holds for the amount-mismatch case ("`paid` is still recorded, then an `attention` hold").

**Scenario:** A payment of an amount that should be held arrives. The job sets `paid`; the pod is replaced by a deploy (`Recreate`) or the next Stripe read fails. On retry the conditional update finds `paid` already set, "changes nothing and re-reads"; the text doesn't say it continues. Fifteen minutes later reconciliation enqueues the submit. The preconditions pass (no hold exists), and the order is confirmed at Printful without approval. The success-page path has the same gap.

**Change:**
- Do the Stripe reads first, then **one transaction**: `payment_state → paid`, the stored amounts and fail-safe inputs, the evaluation of every hold condition and the breaker, the hold row or the submit job. SQLite serialises it, so the breaker count is exact.
- Add `orders.failsafe_checked_at`. Submit's step 1 requires it. Reconciliation step 2 enqueues the **check** for orders without it, never the submit.
- An invariant for the tests: no provider order exists for an order without `failsafe_checked_at`. Add "restart between any two steps" to the random sequences as an explicit action.

### C-F2 — major — A provider outage at start-up keeps the whole shop down
**Where:** `06 §3` ("otherwise the process refuses to start"), `11 §2.1` ("Any mismatch stops the start"), `04 §2` (variants "read from Printful at startup").

**Problem:** The start-up checks call Printful (`/v2/oauth-scopes`, `/v2/stores`, the catalog). The text treats "no answer" like "wrong answer". `11 §4` keeps `/health` free of dependencies for exactly this reason; the start-up path undoes it.

**Scenario:** Printful is unreachable for an hour. During it the pod restarts (a deploy, a node reboot, an out-of-memory kill). The process exits, Kubernetes restarts it in a loop, and for that hour Stripe's webhooks get no answer, status pages and the admin are down, and customers who pay are not recorded until Stripe retries.

**Change:**
- Refuse to start only on a **positive wrong answer** (wrong store, missing scope, key prefix against the mode) and on local configuration errors.
- On no answer: start, mark the provider "unverified", keep Printful-calling jobs paused, retry the check; alert if it lasts.
- The catalog check uses the last good copy in the database; a SKU is disabled by a mismatch, never by a timeout.

### C-F3 — major — Orders have no completion rule
**Where:** `07 §2.2` ("followed until the provider reports `delivered`, `canceled` or `failed`"), `07 §5` step 3, `07 §6` ("180 days after the order's last end state"), I6.

**Problem:** Printful has no "delivered" order status; delivery comes per shipment, and the spec's `delivery_status` includes `unknown`, `return_to_sender` and `failure`. A parcel without usable tracking never becomes delivered. Nothing else ends an order: not time, not a lost dispute, not a won dispute on an order that was never produced.

**Scenario:** Postcards go out by a service whose tracking stops at "in transit". The order stays `shipped`. Reconciliation re-fetches it every hour, for years; after a year hundreds of such orders are polled around the clock, one Printful call at a time. The retention clock never starts, so the name, e-mail and address the privacy text promises to delete stay forever.

**Change:** Define **completion** and store `orders.completed_at`:
- all shipments delivered; or
- everything shipped and a configured number of days passed since the last shipment ("shipped, delivery not confirmed"); or
- fully refunded and nothing live at the provider; or
- never paid; or
- a dispute closed with nothing left to do.

Completion stops the polling and starts the retention clock. Late webhooks for a completed order are still recorded. The triage's I10 should say "not completed" instead of "not at an end state". Map `return_to_sender` and `failure` to an alert and a customer-visible line (C-F19).

### C-F4 — major — Nothing watches the job runner or the alert channel *(side effect of round 1, my F29)*
**Where:** `09 §2`, `11 §4`, Q2.

**Problem:** Every safeguard is a job: reconciliation, hold deadlines, the backup check, the alerts themselves. Alerts go out through one channel, SES. Round 1 dropped `/metrics` on my suggestion, and with it the only signal that didn't depend on the runner. `/health` stays green while the runner is stuck.

**Scenario:** A job hangs on a call without a timeout, or SES rejects mail (sandbox, a revoked key, a suspended account). The process answers `/health`. No reconciliation runs or no alert leaves. Paid orders sit, holds pass their deadlines, and Klaus hears nothing: the opposite of Q2.

**Change:** One more unauthenticated endpoint, for example `/health/worker`: 200 while the runner's last tick is recent, the last reconciliation finished within two hours, and the last alert e-mail was accepted; 503 otherwise. No provider is called, so it doesn't flap with Printful. The uptime monitor that already checks `/health` gets a second check, and its own notification is the second channel. Every outbound call gets a timeout.

### C-F5 — major — The go-live sequence
**Where:** `12 §4`, `11 §2.1` (live: no gate), `14 §7.2` ("never live"), `14 §7.3`, ADR-0028 ("never … from the live Stripe account"), `13 §1` steps 10–11.

**Problems:**
1. The checklist asks for "one real order per product kind" **before** `SHOP_MODE=live`, but real orders need live mode. In live mode the preview gate is off and `/api/offers` is filled, so the moment Klaus enables works for his own orders, art shows the links and strangers can buy from a shop that has never completed a real order.
2. `12 §4` and `14 §7.3` record "every webhook body … and every GET" during those live orders. `14 §7.2` says the recorder never runs against live, ADR-0028 says raw captures are never made from the live Stripe account, and `13 §1` builds the recorder in step 11, after go-live.
3. Nothing says how webhook bodies are captured: they arrive at the shop, not at a recorder script.

**Change:**
- Make the gate its own switch that live mode may keep on: live keys, gate on, `/api/offers` empty. Order: live Secret and mode with the gate → Klaus's orders, received and inspected → gate off, works visible.
- Decide the recording and align the three texts. Proposal: at go-live only **Printful** is recorded, from Klaus's own orders, by exporting the stored `inbound_events` rows and a short-lived request trace in the adapter; nothing from live Stripe. Store the raw body and the signature headers for Printful events, or the signature check can't be replayed from the recording.
- Move what is needed for it from step 11 to before step 10.

### C-F6 — minor — Tax per line is lost for carts with more than ten lines
**Where:** `05 §4` ("tax per line"), `05 §6`, `07 §3` (`order_items.tax_cents`).

**Problem:** A session's `line_items` come as a list of ten by default (`has_more` beyond that), whether expanded or listed. With a cart of any pictures, more than ten lines is ordinary. Nothing ties a Stripe line back to an `order_items` row either.

**Change:** List the line items with `limit=100` and page on `has_more`; put the order-item id in `price_data.product_data.metadata`; check that the lines' tax sums to `total_details.amount_tax` minus the shipping tax, and open an `attention` hold if not.

### C-F7 — minor — ADR-0030: the Dashboard can't pin an arbitrary API version
**Where:** ADR-0030, `05 §4`, `11 §5`.

**Problem:** Stripe's webhook-versioning page says: "If you're upgrading to the latest API version, you can use the Dashboard or the API to create the endpoint. For other versions, use the API to set a specific version." So "created in the Dashboard with `2026-11-18.endive`" is possible only while that version is the latest. The live endpoint is created weeks after the test one.

**Change:** Say what the design already makes true: the endpoint's version doesn't matter, because handlers use three fields and re-fetch. Klaus picks "latest"; the System page shows the version of the last event next to the pinned one, as information. Keep the 2017-shaped fixture. Nothing else changes.

### C-F8 — minor — The mock checkout page and the CSP in CI
**Where:** `14 §5` ("same origin for the CSP's `form-action`"), `14 §8`, `12 §1` (e2e: "shop image + mocks image"), `src/app.ts`.

**Problem:** `form-action 'self' https://checkout.stripe.com` also governs the redirect that answers `POST /checkout`. In CI the two images listen on different ports, which are different origins, so Chromium and WebKit block the redirect to the mock page. The design asks for the same origin and doesn't say how.

**Change:** In mock mode the shop serves `/__mock-pages/*` by passing it through to the mock. It is a small mock-only path; say so under M1. It works the same in CI and anywhere else, and puts those pages behind whatever the shop puts in front of its own.

### C-F9 — minor — Upload limits against the memory limit
**Where:** `04 §5.5` (≤ 20,000 px per side), `11 §1` (512 Mi limit; "peak memory below 384 MiB" for a 3600 × 4800 file).

**Problem:** 20,000 × 20,000 px is 400 megapixels, more than a gigabyte decoded. One upload by Klaus kills the only process, mid-webhook. `limitInputPixels` has no stated value.

**Change:** One number, derived from the memory test (in the order of 50–60 megapixels), used for `limitInputPixels`, uploads and source originals alike; a test at that size.

### C-F10 — minor — The DPI figures don't hold for every work
**Where:** `04 §2` (table and "every measured original passes at 12 × 16"), `01` A2, ADR-0033.

**Problem:** One of art's works is 3619 × 2096 px (aspect 1.73). Its 3:4 crop gives about **175 DPI at 12 × 16**, below the floor of 180; about 262 at 8 × 10 and 349 at 6 × 8, below the table's minimums of 286 and 361. The other works are inside the ranges (the smallest painting photo, 2890 px wide, gives the table's 181).

**Effect:** None on behaviour: the admin refuses that one offer, as designed. The statements "every measured original passes" and the ranges are wrong, and ADR-0033 repeats them. Wide works also lose about a quarter of the picture in a 3:4 or 4:5 crop, which the nine anchors can't fix; the admin should show how much is cut.

**Change:** Recompute the table over the 25 works; reword A2 and the ADR note.

### C-F11 — minor — The capture script can still put raw recordings into this repository
**Where:** `scripts/capture/capture-apis.mjs`, `scripts/capture/README.md`, `.gitignore`, ADR-0028.

**Problem:** ADR-0028 says the script writes to a checkout of the private repository. The script is unchanged: the same value-based redaction, `--out captures/<date>` relative to the working directory, and a README that ends "review the files before committing them". `.gitignore` has no `captures/`. Until the scrubber exists (after the MVP), one routine run repeats round 1's problem.

**Change:** Now, not at step 11: add `captures/` to `.gitignore`; the script refuses an output directory inside this repository's work tree; the README names the private checkout.

### C-F12 — minor — Additions to the verify list
**Where:** `13 §4`.

Not observed by any capture, and each can break a whole path:
1. **The full Checkout Session of `05 §3`.** The captures created sessions with `shipping_options` and `automatic_tax` only. `payment_intent_data.shipping` and `.description`, `custom_text.submit`, `consent_collection`, and `payment_method_types` with `card` and `link` have never been sent together. One rejected combination means no checkout. One test-mode create settles it.
2. **Printful's webhook signature against a real delivery.** The scheme (hex-decoded key, raw body, hex digest) is from the documentation only; no webhook was registered during the captures. A draft in the test store should produce `order_created`. If the reading of the scheme is wrong, every Printful webhook is refused and only the hourly poll works.
3. **The new variant ids** (6 × 8, 12 × 16, framed 12 × 16) and their print areas, if they weren't part of the captures.
4. What `GET /v2/stores` returns for a store-level token (exactly one store?).
5. Whether Link payments carry `latest_charge.outcome` and a fingerprint (the design tolerates absence; knowing it sizes the repeat rule).

### C-F13 — minor — Unpaid checkouts use up order numbers
**Where:** `07 §1`, ADR-0032.

**Problem:** The number is drawn at `POST /checkout`, and "orders never paid" keep their row (only personal data is purged). The space is 90,000. Abandoned checkouts, and anyone who scripts the checkout form within the rate limit, consume it; each also leaves a Stripe Customer.

**Change:** Delete never-paid orders entirely after the purge period (they have no accounting value), which frees their numbers; or draw the number only when the payment is recorded and show the receipt line without it. Purge the Stripe Customer of a never-paid order at the same time.

### C-F14 — minor — Personal data still sent or kept without need (question 6 of `13 §3`)
- `inbound_events.payload_json` keeps Stripe payloads for 30 days, with names and addresses, although handlers use three fields. Store those three fields for Stripe; keep bodies only for Printful (no customer data in them, and C-F5 needs them).
- **Alerts to Klaus** ("with all reasons", "with the tracking evidence") travel through SES to a mailbox. They should carry the order number and an admin link, no customer name, address or e-mail.
- The confirmation e-mail lists the full ship-to. Name, city and state, as on the status page, are enough.
- Carts keep the e-mail and address for 30 days. B F16 moves the address to the quote (7 days); do the same for the e-mail.

### C-F15 — minor — Hold and breaker details still open after the triage
- **"Confirm anyway"** after a cost-guard hold: the submit job runs the cost guard again and fails again. Record the override on the attempt (who, when), as `08` does for Approve.
- **Breaker reset** has no baseline: the 24-hour count is still above the limit, so the next order trips it again. Store `breaker_reset_at` and count from there. Say whether the order that crosses the limit is itself held.
- **A full refund resolves every open hold** of the order (`resolution = refunded`); otherwise deadlines fire on a closed order.
- **Reverse sweep**: a paid session whose local order exists but is unpaid is not an alarm; apply I1.
- **A `Permanent` error for one item** (say the t-shirt size is discontinued) refunds the whole mixed cart. Acceptable for simplicity; the customer e-mail must then say that nothing ships.

### C-F16 — minor — The ZIP ↔ state table can turn a real customer away
**Where:** `05 §2` step 1, ADR-0036.

**Problem:** ZIP prefixes are not a clean function of the state: a few ZIP codes are served from the neighbouring state, and the prefix table has known exceptions. A false "ZIP and state don't match" has no way forward for the customer; the opposite error (the table accepts, Printful refuses after payment) costs a refund and Stripe's fee.

**Change:** Name the data source and test the documented exceptions. On a mismatch, block with the contact address, and count rejections in the admin so a false one is seen. Decide the default for unknown prefixes (accept).

### C-F17 — question — Orders that mix sources
**Where:** `06 §3` (packing slip "store name from the source configuration"), ADR-0026 ("and, later, of any content source"), `04 §4.2`.

A cart may hold works of two sources, but the packing slip has one store name. Use the shop's own name on every slip and keep the per-source name for pages. A second gallery by another artist also raises who the seller is (A3 says Klaus) and whose decision "prints allowed" is; one sentence in ADR-0035 is enough for now.

### C-F18 — minor — The `Work` contract for a large source (question 5 of `13 §3`)
The contract is enough for a second gallery of art's size. For a source with a thousand images three things would need a schema or behaviour change later:
- `works.title` is required, but such sources have captions; "titles come from the admin" needs a `title_override` column. Add it now (nullable).
- Fetch and hash originals **only for works Klaus opens or enables**, not for every listed work; say so in `04 §4.5`.
- The admin's work list needs thumbnails for works whose originals were never fetched: an admin-only route that fetches and resizes on demand, cached.

### C-F19 — minor — Schema details
- `order_items.print_file_sha` references `print_files`, order items are kept ten years, print files twelve months. With foreign keys on, the row can't be deleted: keep the row, delete the file, mark it (`deleted_at`).
- `shipments`: the spec's `estimated_delivery` is an object (`from_date`, `to_date`); the column is one text. Add `shipment_status` and `delivery_status`; show "returned to sender" and "delivery failed" to the customer instead of leaving "Shipped".
- `shipments.id` is the provider's id alone; add the provider (and the attempt, which the triage's attempt-aware rule needs).

### C-F20 — question — For Cluster
1. art is a Knative service. In-cluster calls to it go through Knative's gateway, not straight to art's pods, so an egress rule for "art's pods on art's port" may not match. Does the shop reach art under the planned policy? The same for art fetching `/api/offers` while the shop accepts ingress from Traefik only.
2. The kube-setup deploy token as an **environment secret** of a protected environment limited to the `production` branch, with the deploy job naming that environment. A job from any other ref then never receives the token, whatever runner it lands on. This complements B F9.

## 3. Reviews A and B, and their triage

**Agreement.** I checked these independently and reach the same conclusion; nothing to add:

| Topic | A / B | Triage |
|---|---|---|
| Delete, not a read, is the proof before a refund; quiet period after an unanswered confirm | A F1, A F8, B F8 | §2 |
| Only a full refund cancels | A F2, B F1 | §2 |
| I3 restated; re-confirming the same provider order is allowed | A F7, B F7 | §2 |
| Dispute and fraud-warning transitions, action per reason | A F4, B F8 | §2 |
| Attempt-aware events and holds; fulfilment edge table | A F6, A F10 | §2 |
| I10 (every paid order has an owner) | A F5, B F17 | §2 |
| `/files`, `/img`, `/mockups` outside the gate | B F2 | §3 |
| The cart after payment; expire refused as complete; lost session id | A F12, B F10 | §3 |
| Status links can't come from a stored hash; `link` e-mails need a `ref` | B F6 | D5, §3 |
| No art work is sellable with the configured default | B F5 | D4 |
| Derived status ranks holds above shipped | A F14, B F11 | §2 |
| Configuration that isn't named | B F14 | §3 |
| Runner: RBAC patch reaches the Secrets; egress doesn't fit the job | B F9 | §4 |

**Second look at the triage's own decisions**, before they are written into the design:

| Triage item | Comment |
|---|---|
| **D2**, one catalog file for all modes *(the problem is a side effect of my round-1 F25)* | Right choice. Consequences to write down: foreign keys don't work across files (`order_items → print_files`), so the reference becomes a checked value; Litestream replicates two files; `provider_files` is keyed by store. |
| **D3**, test mode only before go-live; mock mode only in CI | Fits R11. Three things follow that the triage doesn't say. (1) The **weekly** real Stripe run (`12 §3`, `14 §7.4`) and the scheduled recorder (`14 §7.2`) have no instance to run against: drop "weekly" and "on a schedule". (2) "A temporary test deployment" after go-live needs its own public address for Stripe's and Printful's webhooks; without one, say that later real-service checks are the recorder script alone. (3) With no mock deployment, the **first cluster deployment touches real services** (Stripe test mode, drafts in the test store). R19 and Klaus's condition of 2026-11-24 ("no transaction with a real service and no Printful order" in test deployments) say otherwise. That needs Klaus's explicit word and a reworded R19, not a silent change. |
| **D5**, token = HMAC(secret, order number) | Use the **order id**, as B proposed. The number is five digits, may be widened, and could be reused if never-paid orders are deleted (C-F13); the id is unique for good. |
| **D10**, SES bounces through an SQS queue | Simpler for this volume: SES can forward bounce and complaint notices by e-mail to the sender's address. Klaus reads them; no queue, no IAM permission, no polling job, no `provider_message_id`. Add the queue when bounces become frequent. |
| §2, "outside live mode the adapter has no confirm method" and "the mock confirms" | The two sentences contradict. Mean: no confirm in **test** mode. |
| §2, test mode deletes the draft after the cost guard and refunds | Then per-parcel pages and shipped e-mails are never seen outside CI. Fine; say it in `12 §3`, so nobody waits for a shipment in test mode. |
| §3, an admin **reship** that creates a provider order `<order>-r1` | It is a second path that creates and confirms a Printful order and charges Klaus, outside the paid-order path. It needs the same guard as confirm and its own cost limit. Cheaper: Klaus reships in Printful's dashboard, and the reverse sweep's alarm for the unknown order offers "link to order N". |

## 4. Round-1 findings not or wrongly addressed

By round-1 id (review 1). Items already listed by A or B are not repeated.

| Id | State | What remains |
|---|---|---|
| F26 | Partly | The capture script and `.gitignore` are unchanged (C-F11). One further point went to Klaus directly. |
| F23.3 | Contradictory | Recording at go-live against "never live" and the build order (C-F5). |
| F23.6 | Can't run after D3 | See §3. |
| F23.8 | Unspecified | How a deployed shop learns the mock's clock offset. With D3 (mock only in CI) the deployed offset can be dropped; say so in `14 §6`. |
| F24 | Adopted; gap at go-live | The gate is tied to the mode, so the first real orders happen in public (C-F5). |
| F28 | Shop side adopted | The source-side item reported privately in round 1 is unchanged at the source. |
| F29 | Adopted; side effect | Dropping metrics left no watchdog (C-F4). |
| §2.8 | One more | R17 still says "exportable by period and state" although the export page was dropped; R19 as in §3; `06 §4` step 7 says "only in live mode" where `11 §2.1` has the mock confirm. |

## 5. Challenges to Accepted ADRs

- **ADR-0032 (random five-digit order numbers).** The decision stands. Challenged: drawing the number for checkouts that are never paid (C-F13). No new ADR; a note.
- **ADR-0033 (launch sizes).** The decision stands. Its statement that every measured original reaches the floor at 12 × 16 is not true for one work (C-F10). A note.
- **ADR-0028 (private repository).** The decision stands. Its consequence "the capture script writes to a checkout of the private repository" is not yet true (C-F11), and its last line conflicts with the go-live recording (C-F5).
- **ADR-0010 and ADR-0020:** I agree with A and B.

On the Proposed ADRs: **0034** accept with the triage's §2 and C-F1, C-F3; **0029** accept with D2, D3 as commented in §3 and the gate as its own switch (C-F5); **0030** accept with C-F7; **0035** accept with D4 and C-F18's column; **0036** accept with C-F16.

## 6. Still more than this volume needs

Beyond A's and B's lists:
- The SQS intake for bounces (§3, D10).
- The admin reship action (§3).
- A clock offset in a deployed mock environment (gone with D3).
- `dispute_state` with five values next to fraud holds with reasons: after A F4 the hold carries the same information. One of the two can go; the hold is the one the code acts on.
- Three display widths in two formats per work are fine for art; for a large source render them when a work is enabled, not when it is listed (C-F18).

## 7. Done well

- Round 1 was adopted with care: the three-part state, holds with every reason and a deadline, "a paid session always wins", one open checkout per cart, the side-effect-free cancel return.
- The local pre-payment checks: one Printful call per quote, a misconfigured price never reaches a payment, and the exact guard stays behind it.
- Data minimisation written as a table of who gets what and why.
- The source contract kept to two methods, with consent as a flag from the source and a second key in the admin.
- Admin e2e through a minted real cookie; no test route in the application.
- The reverse sweep that alarms and does not rebuild.
- The verify list in `13 §4`: the design knows what it hasn't seen.
- Threshold values, host details and recordings moved out of the public documents, and the rule written into `CLAUDE.md` and the brief.
