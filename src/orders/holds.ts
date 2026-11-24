/**
 * Holds (docs/design/07 §2.5): every reason with its deadline and action.
 * The hold's action is `refund` only if every reason's action is `refund`;
 * its deadline is the earliest of its reasons'.
 */
import { iso, type Clock } from '../clock';
import type { Db } from '../db';

export type HoldKind = 'approval' | 'attention' | 'provider' | 'fraud';

const H = 60 * 60_000;
export const REASONS: Record<string, { kind: HoldKind; deadlineMs: number; action: 'refund' | 'alert' }> = {
  amount: { kind: 'approval', deadlineMs: 72 * H, action: 'refund' },
  quantity: { kind: 'approval', deadlineMs: 72 * H, action: 'refund' },
  repeat: { kind: 'approval', deadlineMs: 72 * H, action: 'refund' },
  breaker: { kind: 'approval', deadlineMs: 72 * H, action: 'refund' },
  risk: { kind: 'approval', deadlineMs: 72 * H, action: 'refund' },
  cost_guard: { kind: 'attention', deadlineMs: 24 * H, action: 'refund' },
  provider_unavailable: { kind: 'attention', deadlineMs: 72 * H, action: 'refund' },
  fulfilment_blocked: { kind: 'attention', deadlineMs: 24 * H, action: 'alert' },
  amount_mismatch: { kind: 'attention', deadlineMs: 24 * H, action: 'alert' },
  provider_hold: { kind: 'provider', deadlineMs: 24 * H, action: 'alert' },
  early_fraud_warning: { kind: 'fraud', deadlineMs: 0, action: 'refund' },
  dispute: { kind: 'fraud', deadlineMs: 24 * H, action: 'alert' },
  refund_failed: { kind: 'attention', deadlineMs: 24 * H, action: 'alert' },
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
  db.prepare("INSERT INTO order_events (order_id, part, to_value, cause, note, at) VALUES (?, 'hold', ?, ?, ?, ?)").run(orderId, kind, cause, reasons.join(','), now);
  return Number(res.lastInsertRowid);
}
