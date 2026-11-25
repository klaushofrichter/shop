# ADR-0042: The circuit breaker's cost limit, self-reset, manual reset

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25, on code-review finding F5: "ok, build it. ok to self-reset. I would like to be able to re-enable the full function manually any time."

## Context

06 §8 describes a circuit breaker with two limits, `BREAKER_ORDERS_24H` and `BREAKER_COST_CENTS_24H`. Only the order count was built, and the cost setting was required but read nowhere (code review 2026-11-25, F5). The design also said the breaker "trips (stored in `settings`)", while the code recomputes it for each paid order, so it un-trips by itself once old orders leave the 24-hour window.

## Options considered

1. Build the cost limit, or remove the setting.
2. A latched breaker that stays tripped until Klaus resets it, or one that resets itself.

## Decision

- **Build the cost limit.** Printful's cost of the orders paid since `max(now − 24 h, breaker_reset_at)` is counted, including the paying order. Each order's cost is its confirmed attempt's cost; without one, its quote's estimate. When the total exceeds `BREAKER_COST_CENTS_24H`, the order is held with reason `breaker`, as with the count.
- **The breaker resets itself.** It is recomputed for every paid order, nothing is stored, and each trip raises an alert.
- **Klaus can re-enable everything at any time** with the dashboard's "Reset the circuit breaker". It sets `breaker_reset_at`, so counting restarts at once, and it releases every hold whose only reason is `breaker`. Those orders go on to Printful.

## Consequences

- The cost limit protects against a run of expensive orders, which the count alone doesn't.
- 06 §8 is corrected: the breaker is not stored.
- No new setting; the ConfigMap keeps both limits.
