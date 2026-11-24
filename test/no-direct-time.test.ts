import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// docs/design/07 §4: all times come from the Clock, so tests control time.
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

describe('no direct time in src/', () => {
  it('uses the Clock instead of Date.now() and new Date()', () => {
    const offenders = files('src')
      .filter((f) => !f.endsWith(path.join('src', 'clock.ts')))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => /Date\.now\(\)|new Date\(\s*\)/.test(line) && !line.trim().startsWith('*')),
      )
      .map(({ f, i, line }) => `${f}:${i}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
