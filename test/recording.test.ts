import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paidOrder, startHarness, type Harness } from './helpers/harness';

// docs/design/14 §7.3: the go-live recording, Printful only: the adapter's request trace
// while PRINTFUL_TRACE_UNTIL lasts, and the export of stored webhook deliveries.

let h: Harness;
beforeEach(async () => {
  h = await startHarness({ PRINTFUL_TRACE_UNTIL: new Date(Date.UTC(2026, 10, 26, 16)).toISOString() }); // the harness clock starts at 15:00
});
afterEach(() => h.close());

async function settle() {
  for (let i = 0; i < 20; i++) {
    await h.shop.runner.tick();
    h.clock.advance(6_000);
  }
}
const traceLines = () => {
  const dir = path.join(h.shop.config.dataDir, 'trace');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>));
};

describe('the go-live recording (14 §7.3)', () => {
  it('traces Printful calls with bodies, never the token; stops at PRINTFUL_TRACE_UNTIL', async () => {
    await paidOrder(h);
    await settle();
    const lines = traceLines();
    const create = lines.find((l) => l.method === 'POST' && l.path === '/v2/orders')!;
    expect(create.status).toBe(200);
    expect(JSON.parse(create.request).recipient.name).toBe('Jane Doe');
    expect(JSON.parse(create.response).data.status).toBe('draft');
    expect(JSON.stringify(lines)).not.toContain('mock_printful_1');
    const n = lines.length;
    h.clock.advance(2 * 3_600_000); // past the end of the trace
    await paidOrder(h);
    await settle();
    expect(traceLines().length).toBe(n);
  });

  it('export-recording prints the stored Printful deliveries and the trace as JSON lines', async () => {
    await paidOrder(h);
    await settle();
    const pf = [...h.printful.orders.values()][0];
    await h.printful.advance(pf.id, 'inprocess');
    await settle();
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'export-recording'], {
      encoding: 'utf8',
      env: { ...process.env, SHOP_MODE: 'mock', DATA_DIR: h.shop.config.dataDir },
    });
    const rows = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
    const hook = rows.find((r) => r.kind === 'printful_webhook')!;
    expect(hook.type).toBe('order_updated');
    expect(JSON.parse(hook.payload_json).signature).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.some((r) => r.kind === 'printful_call' && r.path === '/v2/orders')).toBe(true);
    expect(out).not.toContain('stripe');
  });
});
