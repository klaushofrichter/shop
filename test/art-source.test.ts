import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseSources } from '../src/catalog-config';
import { ArtManifestSource, parseArtManifest } from '../src/sources/art';
import { SourceError } from '../src/sources/types';

const ART = parseSources({
  sources: [
    { id: 'art', default: true, adapter: 'art-manifest', publicUrl: 'https://art.example.com', clusterUrl: 'http://art.internal', creator: 'A. Painter', printsAllowedDefault: false },
  ],
})[0];
const recorded = readFileSync('test/fixtures/art/home.html', 'utf8');

describe('art manifest: contract with the recorded page', () => {
  const { works, problems } = parseArtManifest(recorded, ART);

  it('reads every work without problems', () => {
    expect(problems).toEqual([]);
    expect(works).toHaveLength(25);
    expect(works.filter((w) => w.kind === 'painting')).toHaveLength(3);
    expect(new Set(works.map((w) => w.workId)).size).toBe(25);
  });

  it('builds the original and permalink URLs art serves (ADR-0025)', () => {
    const w = works.find((x) => x.workId === 'leyb1brb')!;
    expect(w).toMatchObject({ title: 'Undertow', kind: 'painting', year: '2024', creator: 'Klaus Hofrichter' });
    expect(w.canonicalUrl).toBe('https://art.example.com/?id=leyb1brb');
    expect(w.original.url).toBe('https://art.example.com/assets/colors/IMG_8403.jpg?v=7cdad2aebf');
    expect(w.original.version).toBe('7cdad2aebf');
  });

  it('keeps only the allow-listed fields (no prices, sale status or descriptions)', () => {
    for (const w of works) {
      expect(Object.keys(w).sort()).toEqual(
        ['canonicalUrl', 'creator', 'kind', 'original', 'sourceId', 'title', 'workId', 'year'].filter((k) => k in w).sort(),
      );
      expect(JSON.stringify(w)).not.toMatch(/price|status|currency|description/);
    }
  });
});

describe('art manifest: drift and errors', () => {
  const page = (rooms: unknown) => `<script type="application/json" id="manifest">${JSON.stringify(rooms)}</script>`;
  const good = { uid: 'abcd1234', title: 'T', file: 'a.jpg', v: 'ff' };

  it('skips and reports works that do not fit', () => {
    const r = parseArtManifest(
      page([{ id: 'food', type: 'pictures', works: [good, { ...good, uid: 'zzzz9999', file: '../x.jpg' }, { ...good }] }, { id: 'about', type: 'about' }]),
      ART,
    );
    expect(r.works.map((w) => w.workId)).toEqual(['abcd1234']);
    expect(r.problems).toEqual(['room food, work zzzz9999: file doesn\'t fit', 'room food, work abcd1234: duplicate uid']);
    expect(r.works[0]).toMatchObject({ kind: 'photograph', creator: 'A. Painter' });
  });

  it('fails without a manifest or without usable works', () => {
    expect(() => parseArtManifest('<html></html>', ART)).toThrow(SourceError);
    expect(() => parseArtManifest(page([{ id: 'x', type: 'pictures', works: [{ uid: '!' }] }]), ART)).toThrow(/no usable works/);
  });
});

describe('ArtManifestSource', () => {
  it('reads in-cluster, uses the ETag, and maps originals to the in-cluster address', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      if (url.endsWith('/')) {
        return init.headers['if-none-match'] === '"e1"'
          ? new Response(null, { status: 304 })
          : new Response(recorded, { headers: { etag: '"e1"' } });
      }
      return new Response(Readable.toWeb(Readable.from([Buffer.from('jpeg')])) as ReadableStream, { headers: { 'content-type': 'image/jpeg', 'content-length': '4' } });
    }) as unknown as typeof fetch;
    const src = new ArtManifestSource(ART, { readFrom: 'http://art.internal', fetch: fakeFetch });
    const first = await src.listWorks();
    const second = await src.listWorks();
    expect(second).toBe(first);
    expect(calls.map((c) => c.url)).toEqual(['http://art.internal/', 'http://art.internal/']);
    expect(calls[1].headers['if-none-match']).toBe('"e1"');

    const o = await src.fetchOriginal({ original: { url: 'https://art.example.com/assets/colors/a.jpg?v=1', version: '1' } });
    expect(calls.at(-1)!.url).toBe('http://art.internal/assets/colors/a.jpg?v=1');
    expect(o).toMatchObject({ contentType: 'image/jpeg', contentLength: 4 });
    await expect(src.fetchOriginal({ original: { url: 'https://evil.example.net/a.jpg', version: '1' } })).rejects.toThrow(/outside the source/);
  });

  it('turns network errors and bad statuses into SourceError', async () => {
    const down = new ArtManifestSource(ART, { readFrom: 'http://art.internal', fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await expect(down.listWorks()).rejects.toThrow(SourceError);
    const broken = new ArtManifestSource(ART, { readFrom: 'http://art.internal', fetch: (async () => new Response('x', { status: 502 })) as unknown as typeof fetch });
    await expect(broken.listWorks()).rejects.toThrow(/answered 502/);
  });
});
