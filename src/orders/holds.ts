/**
 * Holds (docs/design/07 §2.5): every reason with its deadline and action.
 * The hold's action is `refund` only if every reason's action is `refund`;
 * its deadline is the earliest of its reasons'.
 */
import { HOUR, iso, type Clock } from '../clock';
import type { Db } from '../db';

export type HoldKind = 'approval' | 'attention' | 'provider' | 'fraud';

/** One row of an order's history (07 §2.10), written in the transaction of the change it records. */
export interface OrderEvent {
  orderId: string;
  part: 'payment' | 'fulfilment' | 'dispute' | 'hold' | 'refund' | 'email' | 'note';
  from?: string | null;
  to?: string | null;
  cause: string;
  causeRef?: string | null;
  note?: string | null;
  attempt?: number | null;
  /** When the change shares a timestamp with other rows; otherwise now. */
  at?: string;
}

export function recordEvent(db: Db, clock: Clock, e: OrderEvent): void {
  db.prepare('INSERT INTO order_events (order_id, part, attempt, from_value, to_value, cause, cause_ref, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    e.orderId, e.part, e.attempt ?? null, e.from ?? null, e.to ?? null, e.cause, e.causeRef ?? null, e.note ?? null, e.at ?? iso(clock),
  );
}

export const REASONS: Record<string, { kind: HoldKind; deadlineMs: number; action: 'refund' | 'alert' }> = {
  amount: { kind: 'approval', deadlineMs: 72 * HOUR, action: 'refund' },
  quantity: { kind: 'approval', deadlineMs: 72 * HOUR, action: 'refund' },
  repeat: { kind: 'approval', deadlineMs: 72 * HOUR, action: 'refund' },
  breaker: { kind: 'approval', deadlineMs: 72 * HOUR, action: 'refund' },
  risk: { kind: 'approval', deadlineMs: 72 * HOUR, action: 'refund' },
  cost_guard: { kind: 'attention', deadlineMs: 24 * HOUR, action: 'refund' },
  provider_unavailable: { kind: 'attention', deadlineMs: 72 * HOUR, action: 'refund' },
  provider_order_missing: { kind: 'attention', deadlineMs: 72 * HOUR, action: 'refund' }, // the draft is gone at Printful (review F4)
  fulfilment_blocked: { kind: 'attention', deadlineMs: 24 * HOUR, action: 'alert' },
  amount_mismatch: { kind: 'attention', deadlineMs: 24 * HOUR, action: 'alert' },
  provider_hold: { kind: 'provider', deadlineMs: 24 * HOUR, action: 'alert' },
  early_fraud_warning: { kind: 'fraud', deadlineMs: 0, action: 'refund' },
  dispute: { kind: 'fraud', deadlineMs: 24 * HOUR, action: 'alert' },
  refund_failed: { kind: 'attention', deadlineMs: 24 * HOUR, action: 'alert' },
  // Submission (06 §4, §7):
  provider_refused: { kind: 'attention', deadlineMs: 0, action: 'refund' }, // Permanent at draft creation: refund the whole cart
  costs_failed: { kind: 'attention', deadlineMs: 24 * HOUR, action: 'refund' },
  provider_failed: { kind: 'attention', deadlineMs: 24 * HOUR, action: 'alert' }, // order_failed; the deadline tries a delete (7c)
  confirm_failed: { kind: 'attention', deadlineMs: 24 * HOUR, action: 'alert' }, // three confirms without a confirmed order
  provider_canceled: { kind: 'attention', deadlineMs: 0, action: 'refund' }, // Printful cancelled the newest attempt: refund if I4 holds
};

/** Open a hold with all its reasons (they must share a kind). Returns the hold id. */
export function openHold(db: Db, clock: Clock, orderId: string, reasons: string[], cause: string): number {
  const defs = reasons.map((r) => {
    const d = REASONS[r];
    if (!d) throw new Error(`unknown hold reason ${r}`);
    return d;
  });
  const kind = defs[0].kind;
  if (defs.some((d) => d.kind !== kind)) throw new Error('hold reasons of different kinds');
  const deadline = Math.min(...defs.map((d) => d.deadlineMs));
  const action = defs.every((d) => d.action === 'refund') ? 'refund' : 'alert';
  const now = iso(clock);
  const res = db
    .prepare('INSERT INTO holds (order_id, kind, reasons_json, since, deadline_at, deadline_action) VALUES (?, ?, ?, ?, ?, ?)')
    .run(orderId, kind, JSON.stringify(reasons), now, iso(clock, deadline), action);
  recordEvent(db, clock, { orderId, part: 'hold', to: kind, cause, note: reasons.join(','), at: now });
  return Number(res.lastInsertRowid);
}

export const reasonsOf = (h: { reasons_json: string }): string[] => JSON.parse(h.reasons_json) as string[];

/**
 * Resolve the open holds of an order: one hold, one kind, or all of them.
 * Returns how many it resolved; only the winner of the conditional update acts.
 */
export function resolveHolds(db: Db, clock: Clock, which: { orderId: string; holdId?: number; kind?: HoldKind }, resolution: string, by: string): number {
  const r = db
    .prepare(
      `UPDATE holds SET resolved_at = ?, resolved_by = ?, resolution = ?
       WHERE order_id = ? AND resolved_at IS NULL AND (? IS NULL OR id = ?) AND (? IS NULL OR kind = ?)`,
    )
    .run(iso(clock), by, resolution, which.orderId, which.holdId ?? null, which.holdId ?? null, which.kind ?? null, which.kind ?? null);
  const n = Number(r.changes);
  // Every resolution leaves a line in the order's history, whoever resolved it.
  if (n) recordEvent(db, clock, { orderId: which.orderId, part: 'hold', to: resolution, cause: by.includes('@') ? 'admin' : 'job', causeRef: by, note: `${n} resolved` });
  return n;
}

/** A conditional move of `dispute_state` with its history line (07 §2.2, §2.10). False when it was elsewhere. */
export function setDispute(db: Db, clock: Clock, orderId: string, from: string[], to: string, cause: string): boolean {
  const cur = db.prepare('SELECT dispute_state d FROM orders WHERE id = ?').get(orderId) as { d: string } | undefined;
  if (!cur || cur.d === to || !from.includes(cur.d)) return false;
  const r = db.prepare('UPDATE orders SET dispute_state = ?, updated_at = ? WHERE id = ? AND dispute_state = ?').run(to, iso(clock), orderId, cur.d);
  if (!Number(r.changes)) return false;
  recordEvent(db, clock, { orderId, part: 'dispute', from: cur.d, to, cause });
  return true;
}

/** Completion (07 §2.7): once, with a history line naming the rule that applied. */
export function completeOrder(db: Db, clock: Clock, orderId: string, cause: string, rule: string): boolean {
  const r = db.prepare('UPDATE orders SET completed_at = ? WHERE id = ? AND completed_at IS NULL').run(iso(clock), orderId);
  if (!Number(r.changes)) return false;
  recordEvent(db, clock, { orderId, part: 'note', to: 'complete', cause, note: rule });
  return true;
}
