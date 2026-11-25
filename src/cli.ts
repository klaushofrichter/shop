/**
 * Commands run inside the pod (`kubectl exec … -- node dist/src/cli.js <command>`).
 *
 *   export-recording [--since <ISO date>]
 *     The go-live recording (docs/design/14 §7.3) as JSON lines on stdout: the stored
 *     Printful webhook deliveries (raw body and signature headers, kept 30 days) and the
 *     adapter's request trace. For the private repository only; nothing from Stripe.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { openDatabases } from './db';

function exportRecording(args: string[]): void {
  const i = args.indexOf('--since');
  const since = i >= 0 ? new Date(args[i + 1]).toISOString() : '1970-01-01T00:00:00.000Z';
  const config = loadConfig();
  const dbs = openDatabases(config.dataDir, config.mode);
  try {
    const rows = dbs.orders
      .prepare("SELECT event_id, type, object_id, payload_json, received_at, processed_at, outcome FROM inbound_events WHERE provider = 'printful' AND received_at >= ? ORDER BY received_at")
      .all(since) as Array<Record<string, unknown>>;
    for (const r of rows) process.stdout.write(JSON.stringify({ kind: 'printful_webhook', ...r }) + '\n');
    const dir = path.join(config.dataDir, 'trace');
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((n) => /^printful-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
        for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
          const t = JSON.parse(line) as { at: string };
          if (t.at >= since) process.stdout.write(JSON.stringify({ kind: 'printful_call', ...t }) + '\n');
        }
      }
    }
  } finally {
    dbs.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'export-recording':
    exportRecording(rest);
    break;
  default:
    process.stderr.write('commands: export-recording [--since <ISO date>]\n');
    process.exit(2);
}
