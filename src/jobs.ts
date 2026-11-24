/**
 * The in-process job runner (docs/design/07 §4).
 *
 * - One runner leases the oldest due job (lease 5 min), runs it, then marks it
 *   done, re-queues it with backoff, or fails it after its kind's limit.
 * - An expired lease (a crash mid-job) makes the job due again; every handler
 *   must be idempotent.
 * - At most one open job per (kind, key): enqueueing a duplicate is a no-op.
 * - Every tick writes a heartbeat, which `/health/worker` reads (11 §4).
 */
import { iso, type Clock } from './clock';
import { getSetting, setSetting, transaction, type Db } from './db';

export const HEARTBEAT_KEY = 'runner_tick_at';
const LEASE_MS = 5 * 60_000;

export interface JobContext {
  id: number;
  kind: string;
  key: string;
  payload: unknown;
  attempt: number;
  clock: Clock;
}

export interface JobKind {
  run(ctx: JobContext): Promise<void>;
  /** Attempts before the job is failed (default 8). */
  maxAttempts?: number;
  /** Delay before attempt n+1, given n failed attempts (default: exponential, 30 s … 1 h). */
  backoffMs?(attempts: number): number;
  /** Periodic jobs: once a run ends (done or failed), the same job is queued again this much later. */
  repeatEveryMs?: number;
}

/** Thrown by a handler when retrying can't help. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Thrown by a handler that wants to run again later without counting a failure. */
export class RetryLater extends Error {
  constructor(readonly delayMs: number, message = 'retry later') {
    super(message);
    this.name = 'RetryLater';
  }
}

export interface JobRow {
  id: number;
  kind: string;
  key: string;
  payload_json: string | null;
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  run_after: string;
  lease_until: string | null;
  last_error: string | null;
}

const defaultBackoff = (attempts: number) => Math.min(30_000 * 2 ** (attempts - 1), 3_600_000);

/**
 * Add a job unless one with the same kind and key is already open.
 * Returns true if a job was added. Call it inside the transaction that made
 * the job necessary, so the two can't be separated by a crash.
 */
export function enqueue(db: Db, clock: Clock, kind: string, key: string, payload?: unknown, delayMs = 0): boolean {
  const now = iso(clock);
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO jobs (kind, key, payload_json, state, run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    )
    .run(kind, key, payload === undefined ? null : JSON.stringify(payload), iso(clock, delayMs), now, now);
  return Number(res.changes) > 0;
}

export class JobRunner {
  private kinds = new Map<string, JobKind>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private stopped = true;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log: (line: Record<string, unknown>) => void = (l) => console.log(JSON.stringify(l)),
  ) {}

  register(kind: string, handler: JobKind): this {
    this.kinds.set(kind, handler);
    return this;
  }

  /** Write the heartbeat and run every due job, one at a time. Returns how many ran. */
  async tick(limit = 50): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let ran = 0;
    try {
      setSetting(this.db, HEARTBEAT_KEY, iso(this.clock), iso(this.clock));
      while (ran < limit) {
        const job = this.lease();
        if (!job) break;
        await this.runOne(job);
        ran++;
        setSetting(this.db, HEARTBEAT_KEY, iso(this.clock), iso(this.clock));
      }
    } finally {
      this.busy = false;
    }
    return ran;
  }

  /** Tick every `intervalMs` until stopped. */
  start(intervalMs = 5_000): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        this.log({ level: 'error', msg: 'job runner tick failed', error: (e as Error).message });
      }
      if (!this.stopped) this.timer = setTimeout(loop, intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private lease(): JobRow | undefined {
    const now = iso(this.clock);
    return transaction(this.db, () => {
      const due = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE (state = 'queued' AND run_after <= ?) OR (state = 'running' AND lease_until < ?)
           ORDER BY run_after, id LIMIT 1`,
        )
        .get(now, now) as { id: number } | undefined;
      if (!due) return undefined;
      return this.db
        .prepare(
          `UPDATE jobs SET state = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(iso(this.clock, LEASE_MS), now, due.id) as unknown as JobRow;
    });
  }

  private async runOne(job: JobRow): Promise<void> {
    const handler = this.kinds.get(job.kind);
    const ctx: JobContext = {
      id: job.id,
      kind: job.kind,
      key: job.key,
      payload: job.payload_json === null ? undefined : JSON.parse(job.payload_json),
      attempt: job.attempts,
      clock: this.clock,
    };
    try {
      if (!handler) throw new PermanentJobError(`no handler for job kind ${job.kind}`);
      await handler.run(ctx);
      this.finish(job.id, 'done', null);
      this.repeat(job, handler);
    } catch (e) {
      const err = e as Error;
      const message = `${err.name}: ${err.message}`.slice(0, 500);
      if (err instanceof RetryLater) {
        // Not a failure: give the attempt back.
        this.requeue(job.id, err.delayMs, message, true);
        return;
      }
      const max = handler?.maxAttempts ?? 8;
      if (err instanceof PermanentJobError || job.attempts >= max) {
        this.finish(job.id, 'failed', message);
        this.log({ level: 'error', msg: 'job failed', job: job.id, kind: job.kind, attempts: job.attempts, error: message });
        this.repeat(job, handler);
      } else {
        const delay = (handler?.backoffMs ?? defaultBackoff)(job.attempts);
        this.requeue(job.id, delay, message, false);
        this.log({ level: 'warn', msg: 'job retry', job: job.id, kind: job.kind, attempts: job.attempts, error: message });
      }
    }
  }

  private repeat(job: JobRow, handler: JobKind | undefined): void {
    if (handler?.repeatEveryMs) {
      enqueue(this.db, this.clock, job.kind, job.key, job.payload_json === null ? undefined : JSON.parse(job.payload_json), handler.repeatEveryMs);
    }
  }

  private finish(id: number, state: 'done' | 'failed', error: string | null): void {
    this.db
      .prepare(`UPDATE jobs SET state = ?, lease_until = NULL, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ?`)
      .run(state, error, iso(this.clock), id);
  }

  private requeue(id: number, delayMs: number, error: string, giveBackAttempt: boolean): void {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'queued', lease_until = NULL, run_after = ?, last_error = ?, updated_at = ?,
           attempts = attempts - ? WHERE id = ?`,
      )
      .run(iso(this.clock, delayMs), error, iso(this.clock), giveBackAttempt ? 1 : 0, id);
  }
}

/** The last heartbeat, as written by `tick()`. */
export function lastHeartbeat(db: Db): string | undefined {
  return getSetting<string>(db, HEARTBEAT_KEY);
}
