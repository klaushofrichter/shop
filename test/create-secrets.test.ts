import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// scripts/create-secrets.sh (docs/design/11 §1): named keys only, never a value on screen,
// the mode's keys only, --live only with SHOP_MODE=live. kubectl is a fake that records.

const SECRET = 'value-that-must-never-be-printed';
const env = (over: Record<string, string> = {}) =>
  Object.entries({
    PRINTFUL_TOKEN: `live-printful-${SECRET}`, PRINTFUL_TOKEN_TEST: `test-printful-${SECRET}`,
    STRIPE_TEST_TOKEN: `rk_test_${SECRET}`, STRIPE_LIVE_TOKEN: `rk_live_${SECRET}`,
    STRIPE_TEST_WEBHOOK_SECRET: `whsec_${SECRET}`,
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: SECRET, GOOGLE_REDIRECT_URI: 'https://shop.example.com/auth/google/callback',
    ALLOWED_EMAILS: 'a@example.com', COOKIE_SECRET: SECRET, STATUS_TOKEN_SECRET: SECRET, PREVIEW_KEY: SECRET,
    SHOP_SES_AWS_ACCESS_KEY_ID: 'AKIA-ses', SHOP_SES_AWS_SECRET_ACCESS_KEY: SECRET,
    SHOP_BACKUP_AWS_ACCESS_KEY_ID: 'AKIA-backup', SHOP_BACKUP_AWS_SECRET_ACCESS_KEY: SECRET,
    UNRELATED_KEY: 'must-not-be-copied',
    ...over,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';

function run(args: string[], envText = env(), extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'secrets-'));
  const envFile = path.join(dir, '.env');
  writeFileSync(envFile, envText);
  const bin = path.join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  // A fake kubectl: `create ... --from-env-file=F` copies F; `apply -f -` appends stdin to a log.
  writeFileSync(path.join(bin, 'kubectl'), `#!/usr/bin/env bash
for a in "$@"; do case "$a" in --from-env-file=*) cp "\${a#--from-env-file=}" "${dir}/created-$(basename "\${a#--from-env-file=}")";; esac; done
if [ "$*" = "apply -f -" ]; then cat >> "${dir}/applied.log"; else echo "yaml for $*"; fi
`);
  chmodSync(path.join(bin, 'kubectl'), 0o755);
  try {
    const out = execFileSync('bash', ['scripts/create-secrets.sh', ...args, '--env-file', envFile], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, dir };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr, dir };
  }
}

describe('create-secrets.sh', () => {
  it('test mode: the test keys under the app names, no value on screen, nothing unrelated', () => {
    const r = run(['--test']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(SECRET);
    expect(r.out).toContain('Stripe key prefix: rk_test_');
    expect(r.out).toContain('PRINTFUL_TOKEN <- PRINTFUL_TOKEN_TEST');
    expect(r.out).toContain('(skipped, not in .env yet) PRINTFUL_WEBHOOK_SECRET <- PRINTFUL_TEST_WEBHOOK_SECRET');
    const app = readFileSync(path.join(r.dir, 'created-shop-env'), 'utf8');
    expect(app).toContain(`PRINTFUL_TOKEN=test-printful-${SECRET}`);
    expect(app).toContain(`STRIPE_SECRET_KEY=rk_test_${SECRET}`);
    expect(app).not.toContain('live-printful');
    expect(app).not.toContain('UNRELATED');
    expect(app).not.toContain('SHOP_BACKUP');
    const backup = readFileSync(path.join(r.dir, 'created-shop-litestream'), 'utf8');
    expect(backup.split('\n').filter(Boolean).map((l) => l.split('=')[0])).toEqual(['LITESTREAM_ACCESS_KEY_ID', 'LITESTREAM_SECRET_ACCESS_KEY']);
  });

  it('--live is refused without SHOP_MODE=live', () => {
    const r = run(['--live']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/needs SHOP_MODE=live/);
  });

  it('live mode needs the live webhook keys; a missing key is named, never a value', () => {
    const r = run(['--live'], env(), { SHOP_MODE: 'live' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/missing in .*: STRIPE_LIVE_WEBHOOK_SECRET PRINTFUL_LIVE_WEBHOOK_SECRET PRINTFUL_LIVE_WEBHOOK_PUBLIC_KEY/);
    expect(r.out).not.toContain(SECRET);
  });

  it('a Stripe key of the wrong mode is refused', () => {
    const r = run(['--test'], env({ STRIPE_TEST_TOKEN: `rk_live_${SECRET}` }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not a restricted test key/);
    expect(r.out).not.toContain(SECRET);
  });

  it('--dry-run writes nothing to the cluster', () => {
    const r = run(['--test', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry run: nothing written');
    expect(() => readFileSync(path.join(r.dir, 'applied.log'))).toThrow();
  });
});
