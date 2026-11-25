import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// docs/design/11 §1: a print-file render stays below 384 MiB resident, so it fits a 512 MiB pod
// beside the web server. Measured in a child process (scripts/measure-render.ts) with an original
// at the 50-megapixel input limit (pure noise: the worst case for JPEG), for the largest paper,
// framed, mug and t-shirt products. About 200 MiB measured; the cluster figure with real originals
// is a step-9 item.
describe('render memory (11 §1)', () => {
  it('peaks below 384 MiB for a 50-megapixel original', { timeout: 180_000 }, () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/measure-render.ts', '50'], { encoding: 'utf8', timeout: 170_000 });
    const r = JSON.parse(out.trim().split('\n').at(-1)!) as { peakMiB: number };
    expect(r.peakMiB).toBeLessThan(384);
  });
});
