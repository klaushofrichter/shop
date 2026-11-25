/**
 * `/health/worker` (docs/design/11 §4, review C F4): healthy while the job
 * runner ticks, reconciliation finishes and alert e-mails are accepted. No
 * provider is called, so it doesn't flap with Printful. The uptime monitor
 * checks it, and its own notification is the second alert channel.
 *
 * The caller switches on the checks its configuration has: reconciliation
 * needs Stripe and Printful, alerts need SES and an address.
 */
import type { Clock } from './clock';
import { getSetting, type Db } from './db';
import { HEARTBEAT_KEY } from './jobs';

export const RECONCILE_FINISHED_KEY = 'reconcile_finished_at';
export const ALERT_ACCEPTED_KEY = 'alert_accepted_at';
export const ALERT_FAILED_KEY = 'alert_failed_at';

export interface WorkerHealthOptions {
  checkReconciliation: boolean;
  checkAlerts: boolean;
  /** When the process started: a fresh start isn't failing yet. */
  startedAtMs: number;
}

export interface WorkerHealth {
  ok: boolean;
  failing: string[];
}

const TICK_MAX_MS = 5 * 60_000;
const RECONCILE_MAX_MS = 2 * 60 * 60_000;

export function workerHealth(db: Db, clock: Clock, opts: WorkerHealthOptions): WorkerHealth {
  const now = clock.now();
  const age = (key: string) => {
    const at = getSetting<string>(db, key);
    return at ? now - Date.parse(at) : undefined;
  };
  const failing: string[] = [];

  const tick = age(HEARTBEAT_KEY);
  if (tick === undefined ? now - opts.startedAtMs > TICK_MAX_MS : tick > TICK_MAX_MS) failing.push('runner');

  if (opts.checkReconciliation) {
    const rec = age(RECONCILE_FINISHED_KEY);
    if (rec === undefined ? now - opts.startedAtMs > RECONCILE_MAX_MS : rec > RECONCILE_MAX_MS) failing.push('reconciliation');
  }

  if (opts.checkAlerts) {
    const accepted = getSetting<string>(db, ALERT_ACCEPTED_KEY);
    const failed = getSetting<string>(db, ALERT_FAILED_KEY);
    if (failed && (!accepted || Date.parse(failed) > Date.parse(accepted))) failing.push('alerts');
  }

  return { ok: failing.length === 0, failing };
}
