import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// docs/design/11 §1: a print-file render stays below 384 MiB resident, so it fits a 512 MiB pod
// beside the web server. Measured in a child process (scripts/measure-render.ts) with an original
// at the 50-megapixel input limit, for the largest paper, framed, mug and t-shirt products. The CI
// runner uses glibc, so two malloc arenas stand in for the image's musl allocator, which doesn't
// keep per-thread arenas; the real figure is measured on the cluster with real originals (step 9).
describe('render memory (11 §1)', () => {
  it('peaks below 384 MiB for a 50-megapixel original', { timeout: 180_000 }, () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/measure-render.ts', '50'], { encoding: 'utf8', timeout: 170_000, env: { ...process.env, MALLOC_ARENA_MAX: '2' } });
    const r = JSON.parse(out.trim().split('\n').at(-1)!) as { peakMiB: number };
    expect(r.peakMiB).toBeLessThan(384);
  });
});
