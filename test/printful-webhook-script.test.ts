import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMockPrintful, MOCK_STORE, type MockPrintful } from '../mocks/printful/server';
import { EVENTS, envValue, main, setEnvValues } from '../scripts/printful-webhook';
import { FakeClock } from '../src/clock';

// docs/design/06 §5: the registration script that Cluster runs on the node.

let mock: MockPrintful;
let server: Server;
const dirs: string[] = [];
beforeAll(async () => {
  mock = createMockPrintful({ clock: new FakeClock(Date.UTC(2026, 10, 25, 12)) });
  server = mock.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  process.env.PRINTFUL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  delete process.env.PRINTFUL_BASE_URL;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function envFile(extra = ''): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'shop-pfwh-'));
  dirs.push(dir);
  const f = path.join(dir, '.env');
  writeFileSync(f, `# names\nPRINTFUL_TOKEN_TEST=mock_printful_test123\nPRINTFUL_TEST_WEBHOOK_SECRET=\n${extra}OTHER=keep me\n`, { mode: 0o600 });
  return f;
}
const run = async (args: string[], answer = 'y') => {
  const lines: string[] = [];
  const code = await main(args, (s) => lines.push(s), async () => answer);
  return { code, out: lines.join('\n') };
};

describe('scripts/printful-webhook.ts (06 §5)', () => {
  it('registers the webhook, writes both keys into .env without printing them, keeps the rest', async () => {
    const f = envFile();
    const { code, out } = await run(['--mode', 'test', '--store', String(MOCK_STORE.id), '--env-file', f, '--url', 'http://shop.test/webhooks/printful']);
    expect(code).toBe(0);
    const text = readFileSync(f, 'utf8');
    const secret = envValue(text, 'PRINTFUL_TEST_WEBHOOK_SECRET')!;
    const pub = envValue(text, 'PRINTFUL_TEST_WEBHOOK_PUBLIC_KEY')!;
    expect(secret).toMatch(/^[0-9a-f]{128}$/);
    expect(pub).toMatch(/^pk_/);
    expect(text).toContain('OTHER=keep me');
    expect(text.match(/^PRINTFUL_TEST_WEBHOOK_SECRET=/gm)).toHaveLength(1);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(pub);
    expect(out).not.toContain('mock_printful_test123');
    // The mock knows only the spec's event types: the two extra ones are dropped, the rest registered.
    expect(out).toContain('Printful refused shipment_delivered and order_refunded');
    const cfg = (await (await fetch(`${process.env.PRINTFUL_BASE_URL}/v2/webhooks`, { headers: { authorization: "Bearer mock_printful_test123" } })).json()) as { data: { default_url: string; events: Array<{ type: string }> } };
    expect(cfg.data.default_url).toBe('http://shop.test/webhooks/printful');
    expect(cfg.data.events.map((e) => e.type)).toEqual(EVENTS);
  });

  it('refuses a token of another store, and changes nothing on a dry run or a "no"', async () => {
    const f = envFile();
    await expect(run(['--mode', 'test', '--store', '999', '--env-file', f])).rejects.toThrow(/expected 999/);
    const before = readFileSync(f, 'utf8');
    expect((await run(['--mode', 'test', '--store', String(MOCK_STORE.id), '--env-file', f, '--url', 'http://x/w', '--dry-run'])).out).toContain('dry run');
    expect((await run(['--mode', 'test', '--store', String(MOCK_STORE.id), '--env-file', f, '--url', 'http://x/w'], 'n')).code).toBe(1);
    expect(readFileSync(f, 'utf8')).toBe(before);
  });

  it('setEnvValues replaces the last line of a key, drops duplicates and appends new keys', () => {
    expect(setEnvValues('A=1\nB=2\nA=3\n', { A: 'x', C: 'y' })).toBe('B=2\nA=x\nC=y\n');
  });
});
