/**
 * The only source of time in the shop (docs/design/07 §4). Code never calls
 * `Date.now()` or `new Date()` directly (test/no-direct-time.test.ts), so tests,
 * the invariant runs and the mocks share one controllable clock.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to. */
export class FakeClock implements Clock {
  constructor(private ms: number = Date.UTC(2026, 0, 1)) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

/** ISO 8601 in UTC, the form stored in every `*_at` column. */
export function iso(clock: Clock, offsetMs = 0): string {
  return new Date(clock.now() + offsetMs).toISOString();
}

/** Durations in milliseconds. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
