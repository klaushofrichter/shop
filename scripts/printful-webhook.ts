/**
 * Register the shop's Printful webhook for one store (docs/design/06 §5).
 * Run on the node from the shop clone, by Cluster:
 *
 *   npx tsx scripts/printful-webhook.ts --mode test --store <PRINTFUL_STORE_TEST> --env-file <path/to/.env> [--yes] [--dry-run]
 *
 * - reads the store's token from the .env (PRINTFUL_TOKEN_TEST or PRINTFUL_TOKEN), never prints it;
 * - checks that the token belongs to exactly the expected store;
 * - prints the current configuration (URL, expiry, event types; no keys);
 * - asks before replacing it (`--yes` skips the question; `--dry-run` stops before);
 * - `POST /v2/webhooks` with the shop's URL, no expiry and the events of 06 §5;
 * - writes the returned secret_key and public_key into the .env as
 *   PRINTFUL_<MODE>_WEBHOOK_SECRET and PRINTFUL_<MODE>_WEBHOOK_PUBLIC_KEY (mode 600),
 *   without printing them. Then: create-secrets.sh and a restart.
 *
 * `shipment_delivered` and `order_refunded` are Printful events the v2 spec does
 * not list. They are asked for first; if Printful refuses them, the script
 * registers the rest and says so (any shipment event re-reads the parcels, and
 * the reconciliation completes shipped orders).
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

export const SHOP_URL = 'https://shop.klaushofrichter.net/webhooks/printful';
export const EVENTS = [
  'order_created', 'order_updated', 'order_failed', 'order_canceled',
  'order_put_hold', 'order_put_hold_approval', 'order_remove_hold',
  'shipment_sent', 'shipment_put_hold', 'shipment_put_hold_approval', 'shipment_remove_hold',
  'shipment_out_of_stock', 'shipment_canceled', 'shipment_returned',
  'approval_sheet_status_changed',
];
export const EXTRA_EVENTS = ['shipment_delivered', 'order_refunded'];

type Json = Record<string, unknown>;
interface Args { mode: 'test' | 'live'; store: string; envFile: string; yes: boolean; dryRun: boolean; baseUrl: string; url: string }

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = { yes: false, dryRun: false, baseUrl: process.env.PRINTFUL_BASE_URL || 'https://api.printful.com', url: SHOP_URL };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (!x) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === '--mode') a.mode = v() as Args['mode'];
    else if (k === '--store') a.store = v();
    else if (k === '--env-file') a.envFile = v();
    else if (k === '--yes') a.yes = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--url') a.url = v();
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.mode !== 'test' && a.mode !== 'live') throw new Error('--mode test|live is required');
  if (!a.store || !/^\d+$/.test(a.store)) throw new Error('--store <the expected store id> is required');
  if (!a.envFile) throw new Error('--env-file is required');
  if (!/^https:\/\//.test(a.url!) && !process.env.PRINTFUL_BASE_URL) throw new Error('the webhook URL must be https');
  return a as Args;
}

/** One key's value from a .env file, read as text (no shell expansion). */
export function envValue(text: string, key: string): string | undefined {
  const line = text.split('\n').filter((l) => l.startsWith(`${key}=`)).pop();
  const v = line?.slice(key.length + 1).trim();
  return v || undefined;
}

/** Set keys in .env text: replaces the last line of each key (dropping earlier ones), or appends. */
export function setEnvValues(text: string, values: Record<string, string>): string {
  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const idx = lines.map((l, i) => (l.startsWith(`${key}=`) ? i : -1)).filter((i) => i >= 0);
    if (idx.length) {
      const last = idx[idx.length - 1];
      lines[last] = `${key}=${value}`;
      lines = lines.filter((_, i) => !idx.slice(0, -1).includes(i));
    } else lines.push(`${key}=${value}`);
  }
  return lines.join('\n') + '\n';
}

async function call(args: Args, token: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${args.baseUrl.replace(/\/+$/, '')}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, json };
}
const payload = (j: Json) => ((j.data ?? j.result ?? {}) as Json);
const reason = (j: Json) => {
  const e = j.error as { message?: string } | undefined;
  return e?.message ?? (typeof j.data === 'string' ? j.data : JSON.stringify(j).slice(0, 300));
};

export async function main(argv: string[], out: (s: string) => void = console.log, ask?: (q: string) => Promise<string>): Promise<number> {
  const args = parseArgs(argv);
  const MODE = args.mode.toUpperCase();
  const envText = readFileSync(args.envFile, 'utf8');
  const token = envValue(envText, args.mode === 'test' ? 'PRINTFUL_TOKEN_TEST' : 'PRINTFUL_TOKEN');
  if (!token) throw new Error(`no ${args.mode === 'test' ? 'PRINTFUL_TOKEN_TEST' : 'PRINTFUL_TOKEN'} in ${args.envFile}`);

  const stores = await call(args, token, 'GET', '/v2/stores');
  if (stores.status !== 200) throw new Error(`GET /v2/stores answered ${stores.status}: ${reason(stores.json)}`);
  const ids = ((stores.json.data ?? []) as Array<{ id: number; name: string }>).map((s) => String(s.id));
  if (ids.length !== 1 || ids[0] !== args.store) throw new Error(`the token's store is ${ids.join(', ') || 'none'}, expected ${args.store}`);
  out(`store ${args.store} (${args.mode}) confirmed`);

  const current = await call(args, token, 'GET', '/v2/webhooks');
  if (current.status !== 200) throw new Error(`GET /v2/webhooks answered ${current.status}: ${reason(current.json)}`);
  const c = payload(current.json);
  const types = ((c.events ?? []) as Array<{ type: string }>).map((e) => e.type);
  out(`current: url ${String(c.default_url ?? 'none')}, expires ${String(c.expires_at ?? 'never')}, ${types.length} events${types.length ? `: ${types.join(' ')}` : ''}`);
  out(`new:     url ${args.url}, expires never, ${EVENTS.length + EXTRA_EVENTS.length} events`);

  if (args.dryRun) {
    out('dry run: nothing changed');
    return 0;
  }
  if (!args.yes) {
    const answer = ask ? await ask('Replace the configuration? [y/N] ') : await prompt('Replace the configuration? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) {
      out('not replaced');
      return 1;
    }
  }

  let wanted = [...EVENTS, ...EXTRA_EVENTS];
  let created = await call(args, token, 'POST', '/v2/webhooks', { default_url: args.url, expires_at: null, events: wanted.map((type) => ({ type })) });
  if (created.status === 400 && EXTRA_EVENTS.some((t) => reason(created.json).includes(t))) {
    out(`Printful refused ${EXTRA_EVENTS.join(' and ')} (${reason(created.json)}); registering the others`);
    wanted = [...EVENTS];
    created = await call(args, token, 'POST', '/v2/webhooks', { default_url: args.url, expires_at: null, events: wanted.map((type) => ({ type })) });
  }
  if (created.status !== 200) throw new Error(`POST /v2/webhooks answered ${created.status}: ${reason(created.json)}`);
  const n = payload(created.json);
  const secret = typeof n.secret_key === 'string' ? n.secret_key : '';
  const publicKey = typeof n.public_key === 'string' ? n.public_key : '';
  if (!/^([0-9a-f]{2})+$/i.test(secret) || !publicKey) throw new Error('the answer has no usable secret_key and public_key; the configuration may be replaced, run again');

  const keys = { [`PRINTFUL_${MODE}_WEBHOOK_SECRET`]: secret, [`PRINTFUL_${MODE}_WEBHOOK_PUBLIC_KEY`]: publicKey };
  const tmp = path.join(path.dirname(args.envFile), `.${path.basename(args.envFile)}.tmp-${process.pid}`);
  writeFileSync(tmp, setEnvValues(readFileSync(args.envFile, 'utf8'), keys), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, args.envFile);
  out(`registered ${wanted.length} events; written to ${args.envFile}: ${Object.keys(keys).join(', ')} (values not shown)`);
  out(`next: scripts/create-secrets.sh --${args.mode} --env-file ${args.envFile}, then restart the shop`);
  return 0;
}

async function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
