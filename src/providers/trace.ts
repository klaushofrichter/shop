/**
 * The Printful adapter's request trace for the go-live recording (docs/design/14 §7.3):
 * while `PRINTFUL_TRACE_UNTIL` is in the future, every call is appended to
 * `DATA_DIR/trace/printful-<date>.jsonl`: method, path, status, request and
 * response bodies. Never the token (headers aren't recorded). The trace holds
 * Klaus's own order data and goes only to the private repository.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { iso, type Clock } from '../clock';

export function tracingFetch(base: typeof fetch, dataDir: string, clock: Clock, untilMs: number): typeof fetch {
  const dir = path.join(dataDir, 'trace');
  return async (input, init) => {
    const res = await base(input, init);
    if (clock.now() >= untilMs) return res;
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const body = await res.clone().text();
      mkdirSync(dir, { recursive: true });
      const at = iso(clock);
      appendFileSync(
        path.join(dir, `printful-${at.slice(0, 10)}.jsonl`),
        JSON.stringify({ at, method: init?.method ?? 'GET', path: url.pathname + url.search, status: res.status, request: typeof init?.body === 'string' ? init.body : null, response: body }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      // A trace must never break a call.
    }
    return res;
  };
}
