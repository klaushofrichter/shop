/**
 * Content-addressed files under DATA_DIR: `files/` (print files), `img/`
 * (display images), `mockups/`, and `tmp/` for downloads in progress. A file is
 * written to tmp and renamed into place, so a crash never leaves half a file
 * under its final name.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type Area = 'files' | 'img' | 'mockups';

export class FileStore {
  constructor(readonly dataDir: string) {}

  dir(area: Area | 'tmp'): string {
    const d = path.join(this.dataDir, area);
    mkdirSync(d, { recursive: true });
    return d;
  }

  pathOf(area: Area, name: string): string {
    return path.join(this.dir(area), name);
  }

  /** Store bytes under their SHA-256; returns the hash. */
  put(area: Area, ext: string, data: Buffer): string {
    const sha = sha256(data);
    const tmp = path.join(this.dir('tmp'), `${sha}.${randomBytes(4).toString('hex')}`);
    writeFileSync(tmp, data);
    renameSync(tmp, this.pathOf(area, `${sha}.${ext}`));
    return sha;
  }

  /**
   * Download a stream to a temporary file, hashing as it goes, refusing more
   * than `maxBytes`. The caller deletes the file (`discard`).
   */
  async download(body: Readable, maxBytes: number): Promise<{ file: string; sha256: string; bytes: number }> {
    const file = path.join(this.dir('tmp'), `dl-${randomBytes(8).toString('hex')}`);
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) return done(new Error(`download larger than ${maxBytes} bytes`));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(file));
    } catch (e) {
      this.discard(file);
      throw e;
    }
    return { file, sha256: hash.digest('hex'), bytes };
  }

  discard(file: string): void {
    rmSync(file, { force: true });
  }
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
