import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock';
import { memoryDatabases } from '../src/db';
import { enqueue, JobRunner, lastHeartbeat, PermanentJobError, RetryLater, type JobRow } from '../src/jobs';

function setup() {
  const { orders: db } = memoryDatabases();
  const clock = new FakeClock(Date.UTC(2026, 10, 26, 12));
  const logs: Record<string, unknown>[] = [];
  const runner = new JobRunner(db, clock, (l) => logs.push(l));
  const job = (id = 1) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow;
  return { db, clock, runner, job, logs };
}

describe('enqueue', () => {
  it('keeps at most one open job per kind and key', () => {
    const { db, clock } = setup();
    expect(enqueue(db, clock, 'k', 'order-1')).toBe(true);
    expect(enqueue(db, clock, 'k', 'order-1')).toBe(false);
    expect(enqueue(db, clock, 'k', 'order-2')).toBe(true);
    expect(enqueue(db, clock, 'other', 'order-1')).toBe(true);
  });
});

describe('JobRunner', () => {
  it('runs due jobs with their payload, marks them done and writes a heartbeat', async () => {
    const { db, clock, runner, job } = setup();
    const seen: unknown[] = [];
    runner.register('k', { run: async (ctx) => void seen.push(ctx.payload) });
    enqueue(db, clock, 'k', 'a', { n: 1 });
    enqueue(db, clock, 'k', 'later', { n: 2 }, 60_000);
    expect(await runner.tick()).toBe(1);
    expect(seen).toEqual([{ n: 1 }]);
    expect(job(1).state).toBe('done');
    expect(lastHeartbeat(db)).toBe(new Date(clock.now()).toISOString());
    // A done job no longer blocks a new one with the same key.
    expect(enqueue(db, clock, 'k', 'a')).toBe(true);
    clock.advance(60_000);
    expect(await runner.tick()).toBe(2);
  });

  it('retries with backoff, then fails after the limit', async () => {
    const { db, clock, runner, job, logs } = setup();
    runner.register('k', { maxAttempts: 2, backoffMs: () => 1000, run: async () => { throw new Error('down'); } });
    enqueue(db, clock, 'k', 'a');
    await runner.tick();
    expect(job()).toMatchObject({ state: 'queued', attempts: 1, last_error: 'Error: down' });
    expect(await runner.tick()).toBe(0); // not due yet
    clock.advance(1000);
    await runner.tick();
    expect(job()).toMatchObject({ state: 'failed', attempts: 2 });
    expect(logs.at(-1)).toMatchObject({ level: 'error', msg: 'job failed' });
  });

  it('fails at once on a permanent error or an unknown kind', async () => {
    const { db, clock, runner, job } = setup();
    runner.register('k', { run: async () => { throw new PermanentJobError('bad address'); } });
    enqueue(db, clock, 'k', 'a');
    enqueue(db, clock, 'nobody', 'b');
    await runner.tick();
    expect(job(1)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(job(2)).toMatchObject({ state: 'failed', last_error: 'PermanentJobError: no handler for job kind nobody' });
  });

  it('RetryLater gives the attempt back', async () => {
    const { db, clock, runner, job } = setup();
    runner.register('k', { run: async () => { throw new RetryLater(5000); } });
    enqueue(db, clock, 'k', 'a');
    await runner.tick();
    expect(job()).toMatchObject({ state: 'queued', attempts: 0 });
  });

  it('picks up a job whose lease expired (a crash mid-job)', async () => {
    const { db, clock, runner, job } = setup();
    enqueue(db, clock, 'k', 'a');
    db.prepare(`UPDATE jobs SET state = 'running', attempts = 1, lease_until = ? WHERE id = 1`).run(new Date(clock.now() + 1000).toISOString());
    let runs = 0;
    runner.register('k', { run: async () => void runs++ });
    expect(await runner.tick()).toBe(0);
    clock.advance(2000);
    expect(await runner.tick()).toBe(1);
    expect(runs).toBe(1);
    expect(job()).toMatchObject({ state: 'done', attempts: 2 });
  });
});
