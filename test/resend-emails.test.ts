import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paidOrder, startHarness, type Harness } from './helpers/harness';

// cli.js resend-emails: customer e-mails that were tried and failed are queued again,
// e.g. after a configuration error at SES is fixed (2026-11-26).

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());

const db = () => h.shop.dbs.orders;
async function settle() {
  for (let i = 0; i < 20; i++) {
    await h.shop.runner.tick();
    h.clock.advance(6_000);
  }
}

describe('cli.js resend-emails', () => {
  it('queues a failed confirmation again, resets its attempts, and the shop sends it; prints no address', async () => {
    h.ses.control.rejectNext = true; // a permanent refusal: the e-mail fails at once
    const id = await paidOrder(h);
    await settle();
    expect(db().prepare("SELECT sent_at, attempts FROM emails WHERE order_id = ? AND kind = 'confirmation'").get(id)).toEqual({ sent_at: null, attempts: 1 });

    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'resend-emails'], {
      encoding: 'utf8',
      env: { ...process.env, SHOP_MODE: 'mock', DATA_DIR: h.shop.config.dataDir },
    });
    expect(JSON.parse(out)).toMatchObject({ queued: 1, byKind: { confirmation: 1 } });
    expect(out).not.toContain('@');

    // The cli queues with the real clock; bring the harness's clock up to it.
    h.clock.advance(Math.max(0, Date.now() - h.clock.now()) + 1_000);
    await settle();
    expect(db().prepare("SELECT sent_at IS NOT NULL sent FROM emails WHERE order_id = ? AND kind = 'confirmation'").get(id)).toEqual({ sent: 1 });
  });
});
