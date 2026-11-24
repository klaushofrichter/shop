# Design review, round 2 — reviewer B

- Reviewed: 2026-11-24, `klaushofrichter/shop` `main` (shallow clone, read-only). Scope as in `docs/design/REVIEW-BRIEF.md`.
- Checked against: the Printful v2 OpenAPI spec (2.0.0-beta, downloaded today) and the Stripe docs (Checkout Session expire, error codes). No Printful or Stripe API was called, no key was used, no project code was run.
- Severity scale (from review 1): **blocker** means an order or money can be lost or wrongly handled, so fix it before the code. **Major** means it will fail, or cause manual work, in a case we can foresee. **Minor** is a small fix or clarification. **Question** needs a decision or a fact.

## 1. Verdict

**Ready to implement after the listed changes.** Nothing needs rework. The revision is careful. Splitting payment, fulfilment and dispute state and adding holds is the right structure, and most adopted round-1 findings are really in the documents.

The remaining problems fall into three groups:

1. **Invariants that are wrong or can't be implemented as written** (F1, F7, F8). A partial refund cancels a live order. I3 and reconciliation contradict each other. I4 asks for a fact ("not charged") that the Printful API doesn't expose. Dispute holds have no defined end.
2. **The modes revision has gaps that block test mode or go-live** (F2, F3, F4, F5):
   - the preview gate blocks Printful from fetching the print files;
   - Klaus's whole catalog setup lives in a per-mode database that starts empty in live mode;
   - the design never says where the test deployment lives after go-live;
   - with the configured source default, no art work can be sold at launch.
3. **Customer e-mails can't carry the status link** (F6). Only a hash of the token is stored, and the e-mail key lets "find my order" send at most once.

Answers to the brief's four state-model questions:

- **Can money be stranded?** I found no path. The late-payment edge (I1) and one open checkout per cart (I9) hold. Remaining edge cases are in F10.
- **Can an order be fulfilled twice?** Not by the submit algorithm (I5). A reshipment made by hand in Printful's dashboard is a gap: see round-1 §2.7 below.
- **Can a timer refund a confirmed order?** I4 prevents it, except where the design reads "failed and not charged" from the API, which can't be done (F8). The Accepted ADR-0010 still says the opposite (§4).
- **Can a test order reach a live service?** I found no path. The only cross-mode effect is the test webhook endpoint posting to the live host after go-live (F4), which is noise, not harm.

## 2. Findings

### R2-B-F1 — blocker — A partial refund cancels the whole order (I7)
**Where:** `07 §2.6` I7, `05 §4` (row `charge.refunded`), `05 §7`.

**Problem:** I7 fires on any refund ("any source, Stripe Dashboard included"): cancel fulfilment if still cancellable, otherwise an `attention` hold. `05 §4` applies I7 to both `partially_refunded` and `refunded`. Yet the design sends partial refunds to the Stripe Dashboard on purpose, and those are typically goodwill amounts.

**Scenario:**
- An order is `submitted` (Printful `pending`, still cancellable). The customer asks about a delay, and Klaus refunds a few dollars in the Dashboard.
- `charge.refunded` arrives, so I7 runs and the v1 `DELETE` cancels the Printful order.
- `order_canceled` arrives next. That opens an `attention` hold with action refund, and I4's read shows `canceled`, so the rest is refunded automatically.
- The customer receives nothing and is refunded in two parts. Klaus wanted to keep the order.
- On a delivered order, the same refund creates an `attention` hold. The status page then says "we're checking your order", and after `DELAY_NOTICE_HOURS` a "delayed" e-mail goes out (see F11).

**Change:**
- I7 applies only to a **full** refund, and only before a fulfilment end state.
- A partial refund is recorded (`partially_refunded` plus an event), and nothing else happens.
- An admin "refund anyway" on an order in production records Klaus's choice and opens no hold.
- Add the partial-refund-while-`pending` case to the invariant tests.

### R2-B-F2 — major — The preview gate blocks Printful's fetch of print files in test mode
**Where:** `03 §9`, `04 §5.3–5.4`, `04 §7`, `12 §3` item 2.

**Problem:** In `mock` and `test` mode, every path except `/health`, `/webhooks/*` and `/auth/*` asks for the preview key. `/files/*` is behind the gate. Printful fetches `https://shop…/files/<sha>.jpg` for `POST /v2/files`, for mockup tasks and for drafts, and it has no cookie.

**Scenario:** In test mode, Klaus enables an offer. Printful gets the gate page instead of a JPEG, so the registration ends `failed` (the capture showed `failed` for a non-image). The offer never becomes sellable, and `12 §3` item 2 can't pass. Stripe's fetch of `product_data.images` (from `/img/*`) is blocked as well, which is cosmetic.

**Change:**
- Exempt `/files/*` from the gate. Those URLs are already unguessable and public in live mode.
- Exempt `/img/*` and `/mockups/*` too, or drop `images` from line items outside live mode.
- Add an e2e assertion that `/files/<known sha>` is served without the preview cookie in test mode.

### R2-B-F3 — major — One database per mode puts Klaus's catalog setup in a file that is empty at go-live
**Where:** ADR-0029 (Proposed part), `07 §3`, `11 §2.1`, `08 §5`, `12 §4`.

**Problem:** Everything the admin sets up lives in the mode's database: `works.enabled`, `offers` (prices, anchors, orientation), `print_files`, `provider_files`, mockups. Moving to `SHOP_MODE=live` opens an empty `live.db`. In practice (and correctly), `provider_files` is also per store, because each Printful store has its own file library.

**Scenario:** Klaus sets up 25 works in test mode and the go-live checklist passes. On switching to live, the shop lists no offers. Klaus has to repeat every enable, price and anchor by hand, and that configuration has never been through a test order. art shows no links until he does.

**Change:** Pick one, and say it in ADR-0029:
1. Keep the catalog (works, offers, print files) in a mode-independent file, and only orders, carts, quotes, jobs and events per mode. Key `provider_files` by `(print_file_sha, provider, store)`.
2. Keep the per-mode files, and add an admin "export catalog / import catalog" step to the go-live checklist. On import, re-register the files in the live store.

The first is simpler for Klaus.

### R2-B-F4 — major — There is no deployment topology per mode, so nothing exists for test mode after go-live
**Where:** `11 §1` (one namespace `shop`, one Ingress for `shop.klaushofrichter.net`, one PVC), `12 §3` (the scheduled weekly test-mode run), `14 §7.2` (the recorder against the test store), ADR-0030 (the test endpoint at "the test deployment's address").

**Problem:** The documents read as if one Deployment moves from mock to test to live.

**Scenario:** After go-live:
- the weekly real-Stripe run and the test-store recorder have no shop instance to run against;
- the Stripe test-mode endpoint still points to the same hostname, so any test-mode event (the weekly run, Klaus trying something in test mode) reaches the live process and fails the signature check. That triggers the "webhook signature failures" alert.

**Change:** Decide one of these and record it in ADR-0029:
- **(a)** A long-lived test Deployment with its own host behind the preview gate, its own PVC or database and its own Secret. This needs DNS and a certificate (Klaus) and the cluster's resources (Cluster).
- **(b)** Test mode exists only before go-live. Drop the weekly run, run the recorder by hand from a temporary test deployment, and add "disable the test-mode webhook endpoint" to the go-live checklist.

(b) fits R11 better.

### R2-B-F5 — major — With art's configured default, no work can be sold at launch
**Where:** `04 §4.2` (`"printsAllowedDefault": false` for art), `04 §4.3`, `08 §3` ("enable … only where `prints_allowed`"), `11 §1` ("later, if art wants, the works feed"), `13 §2` ("which of art's works may be sold (art's decision)", step 10).

**Problem:** `prints_allowed` comes only from a per-work source flag or the source default. art's default is false, and art's feed is "later, if art wants". So no mechanism expresses art's decision before the feed exists, and the admin can't enable anything.

**Scenario:** At step 10, every work shows `prints_allowed = 0`. The only ways out are setting the default to `true`, which allows every work including the paintings art promises never to print (review 1 F20), or waiting on art's repository.

**Change:**
- Either make art's feed with `printsAllowed` an explicit art task in step 9,
- or add a per-work override in `config/sources.json` (a list of work ids that may be printed, decided by art's owner) that the adapter applies until the feed exists.

Say which one ADR-0035 uses.

### R2-B-F6 — major — Status links can't be put in e-mails, and "find my order" works only once
**Where:** `07 §1` (only the token's SHA-256 is stored), `07 §3` (`orders.status_token_hash`, `emails` primary key `(order_id, kind, ref)`), `09 §1`, `03 §8`, `08 §3` ("resend an e-mail").

**Problem:**
- The confirmation, delayed, refunded and link e-mails all carry "the status link". `email.send` is a job that runs after the request, and the plaintext token is gone by then.
- Minting a new token means replacing the single stored hash. That breaks every link sent earlier, including the one in the confirmation e-mail.
- The `link` kind has `ref = ''` and "at most once per key", so a second "find my order" request, or Klaus's "resend", silently sends nothing.

**Scenario:** The customer gets the confirmation and, later, the "shipped" e-mail. Then they open the link in the first e-mail: either it now returns 404, or the shipped e-mail had no link. Weeks later they use "find my order" a second time, and no e-mail arrives.

**Change:**
- Derive the token instead of storing it: `HMAC(STATUS_TOKEN_SECRET, order id)`. It can be recomputed for any e-mail, and rotating the secret revokes all links. Or keep a `status_tokens` table with several hashes per order.
- Give `link` e-mails a `ref` (the request's id or date), and let admin resends use a fresh `ref`.
- Rate limiting stays as designed.

### R2-B-F7 — major — I3 contradicts reconciliation, and an attempt can stall at `draft` forever
**Where:** `07 §2.6` I3 and I5, `07 §5` step 4, `06 §4` step 7.

**Problem:** I3 allows one confirm per attempt. Reconciliation step 4 resolves a `confirming` attempt "to `confirmed` or back to `draft`". Back at `draft`, I3 forbids another confirm. I5 forbids attempt N+1, because N isn't proven cancelled. Nothing moves the order on.

**Scenario:** The confirm answer is lost, and Printful had not processed it. The read shows `draft`, the attempt goes back to `draft`, and the order sits there. The customer sees "checking your order" and no hold or deadline exists.

**Change:** Restate I3 by what it protects: confirm is requested only inside a transaction that sees no refund requested and no open hold, and that writes `confirm_requested_at` (overwritten on a retry).
- Re-confirming the **same** provider order after a fresh read shows `draft` is allowed. It is one Printful order, so it can't be charged twice.
- The invariant-test oracle checks "at most one confirmed provider order per paid order", not "one confirm call per attempt".

### R2-B-F8 — major — I4's "failed and not charged" and the fraud and dispute holds are undefined
**Where:** `07 §2.6` I4, `07 §2.4`, `05 §4` (rows for `radar.early_fraud_warning.created` and `charge.dispute.*`), `06 §7`.

**Problem:**
1. **I4.** The v2 `Order` schema has no charged indicator. `failed` means "submitted … not accepted because of an error (… charging, etc.)", so a read can't show "not charged".
   - The spec does give a proof: v2 `DELETE /v2/orders/{id}` succeeds only for `draft`, `failed` or `cancelled` orders that "have not been charged yet and there must be no payments pending".
   - The spec also says `canceled` returns any charge to the store, so `canceled` is safe.
2. **Fraud holds.**
   - Holds have a deadline action per *kind*, but one kind (`fraud`) needs refund for an early fraud warning and must never refund for a dispute. Stripe rejects refunds on a charged-back charge with `charge_disputed`.
   - "Fraud hold with action refund" doesn't say whether the refund is immediate or at the deadline. Stripe's guidance for early fraud warnings favours refunding promptly.
   - A dispute hold has no resolution: nothing moves it after `charge.dispute.closed`. Reconciliation step 6 would apply "alert" every day.

**Scenario:** An order is `failed` after confirmation, with the cause unknown. The deadline needs I4. An implementer either guesses "not charged" and may refund an order Printful did charge, or never refunds.

**Change:**
- I4 accepts only: the order is not found, `draft`, `canceled`, or a v2 `DELETE` that succeeds (after which the order is not found). Otherwise, alert.
- Store `deadline_action` per *reason*, not per kind:
  - early fraud warning before confirm: refund at once;
  - dispute: alert only, never refund; treat `charge_disputed` as final, not as a retry;
  - `charge.dispute.closed`: resolve the hold (won: Klaus decides on fulfilment; lost: close it).

### R2-B-F9 — major — The hardened runner doesn't fit the deploy job, and RBAC patch on the Deployment exposes the shop's Secrets
**Where:** `10 §2` (the fork pull request row), `11 §1`, `.github/workflows/deploy-production.yml`.

**Problems:**
1. **Egress.** The egress policy allows only "the Kubernetes API and GitHub", but the deploy job:
   - smoke-tests `https://shop.klaushofrichter.net` from the runner (`curl` to `/health` and `/`), which is neither;
   - downloads `kubectl` from `dl.k8s.io` and calls `sudo` if it's missing.

   NetworkPolicy works by IP address, and GitHub's documented list of hosts a self-hosted runner must reach includes Actions service and storage hosts outside github.com. As specified, the job fails at the smoke test.
2. **RBAC.** "get/watch/patch on the one Deployment" is enough to change the pod template: any image, any command, and an environment drawn from any Secret in namespace `shop`, which after go-live holds the live Stripe key and the live Printful token. The approval setting for outside contributors is then the only thing between a careless "Approve and run" and those keys.

**Change (Cluster's):**
- Bake `kubectl` into the runner image and remove the download step.
- Either run the smoke test from a GitHub-hosted job (it only needs the public URL), or allow egress to the shop's own Ingress.
- Derive the allow-list from GitHub's documented runner hosts.
- Add an admission policy on namespace `shop` (a ValidatingAdmissionPolicy) that admits Deployment changes only when the image is `ghcr.io/klaushofrichter/shop@sha256:…` and the rest of the pod template is unchanged. Alternatively, let the cluster apply kube-setup's manifest and the runner only push to kube-setup.
- Make the runner ephemeral.

### R2-B-F10 — major — The cart after payment, and three checkout edge cases, are undefined
**Where:** `05 §3` step 1, `05 §5`, `07 §3` (`carts.open_order_id`).

**Problems:**
1. Nothing says what happens to the cart once its order is paid: emptied, detached, kept?
2. Step 1 says "expire that session at Stripe and wait for the confirmation (§5)". §5 describes no waiting. Expire succeeds only for `open` sessions. If it fails because the session is `complete`, the customer paid in another tab, and the step has no defined outcome.
3. Suppose the process dies after Stripe created the session but before the shop stored its id. The order stays `checkout_open` with no session id. Reconciliation step 1 "re-fetches" by an id it doesn't have, and I9 blocks the cart.

**Scenario:** A customer pays, returns later to the same browser (the cart cookie lives 30 days), adds a postcard and presses Pay. What happens depends on the implementer: a second order may be created for the already-paid items too, or the request errors.

**Change:**
- On `paid`, detach the order from the cart and empty the cart, in the same transaction.
- At `POST /checkout`: if expire reports the session `complete`, apply the payment (I1) and redirect to the status page.
- Recover a missing session id by repeating the create with the same idempotency key (valid 24 h), or by listing the Customer's sessions. After that, `closed_unpaid` with a note.
- Fix the `05 §3` "Errors" wording: `closed_unpaid` is also used when no session exists, which conflicts with its definition in `07 §2.1`.

### R2-B-F11 — minor — The derived status ranks holds above shipped and delivered
**Where:** `07 §2.5`, `09 §1` ("Delayed").

**Problem:** "Open hold of any kind" matches before `shipped` and `delivered`.

**Scenario:** The customer opens a dispute after delivery, or a refund fails after delivery. The status page switches back to "Payment received — we're checking your order", and the customer gets a "delayed" e-mail for a parcel they already have.

**Change:** That row applies only while `fulfilment_state ∈ {none, submitting, draft, confirming}`. The delayed e-mail is sent only before the first shipment.

### R2-B-F12 — minor — Test-mode orders have no fulfilment end state, and mock and test disagree on confirming
**Where:** `06 §4` step 7, `07 §5` step 3, `11 §2.1`.

**Problem:**
- A test order stays at `draft`. Reconciliation polls it every hour. After the nightly purge deletes the draft, the read returns 404, and the design doesn't say whether that means `canceled` (which opens an `attention` hold and an alert per test order).
- `06 §4` says "confirm, only in live mode", while `11 §2.1` has the mock confirm.

**Change:**
- In test mode, after the cost guard passes, delete the draft at once and set `fulfilment_state = canceled` with cause `test_mode`, no hold and no alert. Optionally refund in Stripe test mode, which also exercises the refund path.
- Write "confirm in mock and live" in `06 §4`.

### R2-B-F13 — minor — SES bounce intake is not designed
**Where:** `09 §1` (bounces), `03 §1`, `07 §3` (`emails`).

**Problem:** SES reports bounces through SNS: an HTTPS subscription or an SQS queue. The design has:
- no endpoint (`/webhooks/ses`?) and no SNS signature check;
- no preview-gate exemption for it;
- no SES message id stored on `emails` to map a bounce back to an order.

An implementer would have to invent all of it.

**Change:**
- Add a column `emails.provider_message_id`.
- Choose one intake: an SNS HTTPS endpoint with signature verification, exempt from the gate, or polling an SQS queue with an IAM permission. At this volume, polling is simpler and needs no public endpoint.

### R2-B-F14 — minor — Configuration the design relies on but doesn't name
**Where:** `11 §2.2`, `11 §1` (Secrets), `.env.example`, `docs/handover.md` "Keys", `06 §3`.

**Missing:**
- The expected Printful store per mode, needed for the startup check (`GET /v2/stores`) and the webhook `store_id` check. Store ids may not be public (ADR-0028), so this belongs in the kube-setup ConfigMap.
- The Printful webhook **public key**, checked against `x-pf-webhook-public-key` (only `PRINTFUL_WEBHOOK_SECRET` is listed).
- `STRIPE_TEST_WEBHOOK_SECRET` and `STRIPE_LIVE_WEBHOOK_SECRET`, `PREVIEW_KEY` and the SES credentials are missing from `.env.example` and the handover's key list.
- The Stripe fee estimate used by both cost checks. Stripe Tax through Checkout adds a percentage on top of the card fee.
- The retry window variable named in ADR-0010 and `06 §7`.

**Change:** List them in `11 §2.2`, with the private ones marked "value in kube-setup".

### R2-B-F15 — minor — Fixtures depend on a scrubber that is built after the MVP
**Where:** `12 §1` (contract tests "derived from the real captures (scrubbed)"), `14 §4` (catalog "seeded from scrubbed captures"), `14 §10` and `13 §1` step 11 (the scrubber comes after the MVP).

**Problem:** Steps 3–7 need synthetic fixtures, and the tool that produces them comes at step 11.

**Change:** State that the fixtures until step 11 are hand-written from the private captures and the spec, and are checked by the CI fixtures check. Alternatively, build only the allow-list scrubber (not the recorder or comparator) in step 3.

### R2-B-F16 — minor — Over-engineering still present
- **The mock-mode deployment on the cluster** (`14 §9`, `12 §3` "first in mock mode"): routing `/__mock-pages/` through the ingress, a clock offset, a second image deployed. CI's e2e already runs shop and mocks side by side, and Stripe test mode is free and real. Drop it. On the cluster, the modes are `test` and `live`, and `mock` is CI-only. This also simplifies F4.
- **Validating every Stripe request against Stripe's full OpenAPI document** (`14 §7.1`). That spec is very large and form-encoded. Hand-written schemas for the eight or so endpoints the shop calls give the same protection. Keep the full validation for Printful, where silently ignored fields are the real risk.
- **`carts.address_json` and `quotes.address_json`** hold the same data. Keep the address on the quote only.

### R2-B-F17 — minor — A provider outage beyond the retry window has no hold
**Where:** `06 §7` (first row), `07 §2.6`.

**Problem:** After the retry window the design only alerts. No hold means no deadline, so Q1's "shipped or refunded without Klaus" has no path if Printful stays down, or a create stays `Unknown`.

**Change:** After the window, open an `attention` hold whose deadline refunds only if I4 allows. After a refund, the provider lookup goes on (I6).

### R2-B-F18 — question — Packing slip contact
**Where:** `06 §3`, ADR-0031.

**Question:** `customization.packing_slip.email` and `phone` are, per the spec, the *store's* customer-service contact, not the customer's. The design says "never an e-mail or phone". If the field is left empty, does Printful print the store's default contact from its dashboard, which might be Klaus's personal address? Putting the shop's own orders address there would give customers a way to reach the shop about a damaged parcel without sending any customer data. To check with one test-store draft.

## 3. Round-1 findings not (or wrongly) addressed

| Round-1 id | State | What remains |
|---|---|---|
| R1 F27 | Partly | The proposed threshold values are still in ADR-0020 and are quoted in both round-1 review files, all public. Unless the values deployed in kube-setup **differ** from those proposals, moving the numbers to private configuration hides nothing. The Google Cloud project name is still in ADR-0013, ADR-0016, `.env.example` and the research notes, and `docs/handover.md` still names a host path. |
| R1 F23.6 | Adopted, but can't run | The weekly real Stripe test-mode run has no target after go-live (F4). |
| R1 F24 | Adopted, with a side effect | The preview gate also blocks Printful (F2). |
| R1 F25 | Adopted, with a side effect | A database per mode loses the catalog setup at go-live (F3). |
| R1 F17 / R2 F7 | Adopted, but can't be implemented | The status link in e-mails and "find my order" conflict with the stored hash and the e-mail key (F6). |
| R1 F2 | Partly | The `complete` result of the expire call and the cart after payment (F10). |
| R1 F28 | Partly | Deleting the Stripe Customer doesn't remove name and address from the Checkout Session, PaymentIntent and Charge. The privacy text should say Stripe keeps those, so "deleted at the same time" isn't read as complete. Backups (Litestream for 30 days, Velero) keep purged data for their retention period; say so too. |
| R1 §2.7 (returns and reshipments) | Not addressed | `06 §7` says "reship or refund" for a returned parcel, but the admin has no reship action (`08 §3`). Klaus would reship in Printful's dashboard, and the reverse sweep (`07 §5`) then raises an alarm for an unknown Printful order. Add an admin "reship", which creates a provider order with a marker `external_id` (for example `<order id>-r1`) and records the shipment as `is_reshipment`. Or teach the sweep to accept a reship Klaus links to the order. |
| R1 §2.8 (inconsistencies) | Partly | ADR-0010's decision still auto-refunds on a billing hold (§4). ADR-0018 still names `order_transitions` (the schema has `order_events`). ADR-0021 still says "one picture per order (ADR-0008)", and its status line mentions only ADR-0027. ADR-0024 still says "no Printful order (not even a draft)" and "shadow calls in real time", and has no note. `research/api-capture-findings.md` "Design changes" still says the shop reads `shipping_cost.amount_total`, validates with the estimation task, and that orders reference the file (all reversed since). `07 §3` `print_files.render_key` omits the orientation that `04 §5.2` includes. Q1 (`01 §4`) and the invariant-test oracle (`12 §1`, "never confirmed and fully refunded without an admin override") are both contradicted by a legitimate path: Printful cancels a confirmed order and I4 refunds. Allow "confirmed, then provider-cancelled" in the oracle, and mention disputes in Q1. |

Everything else marked "adopted" in the triage I found in the documents, consistently. That covers:
- R1 F1, F3–F6, F8–F16, F18, F19, F21, F22, F23 (items 1–5 and 7–11), F26, F29;
- R2 F1–F4, F6, F8, F9 (one knob, and a test that tax is never counted as revenue), F10–F13.

## 4. Challenges to Accepted ADRs

- **ADR-0010 (order failures and refunds).** The decision text still says "automatic full refund after 72 h on a Printful billing hold". The design (`06 §7`, I4) now alerts instead, which is right. On a billing hold Printful hasn't charged yet but will once billing is fixed. If Klaus updates the card after a refund, Printful charges and ships an order the customer already got back. The note added on 2026-11-25 covers only cancellations. Klaus should record that ADR-0034 supersedes this part, so the change is his decision and not a silent edit.
- **ADR-0020 (fail-safes).** The mechanism stands. Challenged: the proposal values are public in the record, so they protect nothing unless the deployed values differ (see §3, R1 F27). Proposal: a note that the deployed values deliberately differ from the published ones. No new ADR is needed.
- **ADR-0024 (mock services).** The decision stands. Its consequences ("no Printful order, not even a draft") and decision ("shadow calls in real time") are superseded by ADR-0029 and `14 §7`. Add a note.

On the **Proposed** ADRs (open to challenge):
- **ADR-0034:** accept, with F1, F7, F8 and F17 folded in.
- **ADR-0029:** accept the mode switch, but decide F3 and F4 first.
- **ADR-0030:** accept, adding the test endpoint's lifecycle (F4).
- **ADR-0035:** accept, adding how `printsAllowed` is expressed before art has a feed (F5).
- **ADR-0036:** accept as is.

## 5. Things done well

- Payment, fulfilment and dispute as separate fields, with holds holding every reason and a deadline. This removes most of round 1's special edges, and "a paid session always wins" closes the late-payment hole cleanly.
- `confirm_requested_at` written before the call, attempts keyed per row, and "a new attempt only after the previous one is proven cancelled". Once F7 and F8 are fixed, this is a sound confirm protocol.
- Webhook handlers that use only `id`, `type` and `data.object.id`, backed by a fixture in the 2017 shape. This makes the endpoint's API version a non-issue.
- The pre-payment cost check from cached prices instead of the estimation task. It is cheap, keeps Q6, and keeps the post-payment guard as the backstop.
- Data minimisation done precisely: no e-mail or phone to Printful, the recipients named, a consent rule for later.
- The source abstraction kept small (`listWorks`, `fetchOriginal`), re-renders gated on the original's SHA-256, display images rendered by the shop, CSP kept at `'self'`.
- Admin e2e through a minted real cookie, with no test login route.
- An honest reverse sweep that raises alarms and doesn't rebuild rows.
- The startup checks of key prefix, store identity and scopes per mode.
