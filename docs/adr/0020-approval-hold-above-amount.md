# ADR-0020: Fail-safes against large or unusual orders

- Status: Accepted
- Date: 2026-11-24 (proposed as "Hold orders above an amount for Klaus's approval"; reshaped the same day)
- Decided by: Klaus, 2026-11-24: "We can have a fail save and protection against large orders. My estimate is just an estimate for real customers, not misuse"

## Context

Normal volume is under 10 orders a week, and normal orders must need no work from Klaus (R9). But every confirmed Printful order charges Klaus's Printful account at once, while a stolen-card payment can be reversed weeks later as a chargeback (sale lost, Printful cost lost, a dispute fee on top). A burst of orders, by misuse or by a bug, could run up a large Printful bill before anyone looks. Stripe Radar screens payments but doesn't know what is normal for this shop. PhotoPortfolio holds orders above an amount; Pressline plans a "Review Mode".

## Options considered

1. No gate: Radar only. Cheapest, but nothing bounds the damage of misuse or a bug.
2. Hold every paid order above an amount for approval (the first proposal).
3. **Layered fail-safes**: hard limits nobody can exceed, a hold for unusual single orders, and a circuit breaker for unusual volume. Normal orders pass untouched.

## Decision

Option 3. All values are configuration; defaults below are proposals for Klaus to change.

1. **Hard limits at checkout** (the order can't be placed; the page offers the contact address for larger orders):
   - quantity per item ≤ 10 (postcards ≤ 25);
   - items per order ≤ 20;
   - order total ≤ **$500**.
2. **Approval hold** for a paid order when any of these is true: total ≥ **$250**; the same email or card fingerprint already has a paid order in the last 24 h; Stripe Radar reports an elevated risk level. The order waits in `awaiting_approval` (paid, not sent to Printful). Klaus approves or refunds in the admin. **Fail-safe default: if nobody approves within 72 h, it is refunded in full automatically** and the customer is told. A held order never costs Klaus a Printful charge.
3. **Circuit breaker** on volume: more than **10 paid orders in 24 h**, or more than **$600 of Printful cost in 24 h**, trips the breaker. While tripped, newly paid orders are held (as in 2) instead of submitted, quoting keeps working, and Klaus gets an alert. He resets it in the admin; held orders then proceed (or, untouched, refund after 72 h).
4. Existing controls stay: per-IP rate limits on quote and checkout, Stripe Radar, the cost guard (ADR-0018).
5. Outside the shop, recommended to Klaus: keep the Printful wallet's auto-recharge amount modest, so Printful's own billing is a last cap.

## Consequences

- Normal orders (under $250, first order from that customer today, low risk, normal volume) never stop: R9 holds for them.
- Large or unusual orders wait for Klaus, at most 72 h, and fail safe to a refund. Klaus gets an alert for each.
- New state `awaiting_approval`; new admin actions Approve, Reset breaker; Radar's risk level is read from the PaymentIntent's charge (needs Charges read, already granted).
- The thresholds trade a little friction for real customers against bounded damage from misuse; Klaus can tune them from his experience.
