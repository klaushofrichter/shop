import { describe, expect, it } from 'vitest';
import { CatalogConfigError, loadSkus, loadSources, parseSkus, parseSources, printsAllowed } from '../src/catalog-config';

describe('config/skus.json', () => {
  it('loads the launch SKUs in mock and test mode', () => {
    const c = loadSkus('config/skus.json', 'test');
    expect(c.minDpiPaper).toBe(180);
    expect(c.byId.get('print-12x16')?.variants.any).toBe(1349);
    expect(c.skus.filter((s) => s.kind === 'apparel')).toHaveLength(4);
  });

  it('refuses placeholder prices in live mode', () => {
    expect(() => loadSkus('config/skus.json', 'live')).toThrow(/placeholder price in live mode/);
  });

  it('reports every problem of a bad SKU', () => {
    const bad = { minDpiPaper: 180, skus: [{ id: 'Bad Id', kind: 'poster', variants: {}, taxCode: 'x', priceCents: 0 }] };
    try {
      parseSkus(bad, 'mock');
      expect.unreachable();
    } catch (e) {
      const p = (e as CatalogConfigError).problems.join('\n');
      for (const m of ['id must be', 'kind must be', 'variants must', 'taxCode', 'priceCents', 'productId']) expect(p).toContain(m);
    }
  });
});

describe('config/sources.json', () => {
  it('loads art as the default source, nothing allowed yet', () => {
    const [art] = loadSources('config/sources.json');
    expect(art).toMatchObject({ id: 'art', default: true, printsAllowedDefault: false, printsAllowedWorks: [] });
  });

  it('needs exactly one default source', () => {
    const src = { sources: [{ id: 'a', adapter: 'x', publicUrl: 'https://a', printsAllowedDefault: false }] };
    expect(() => parseSources(src)).toThrow(/exactly one source must be the default/);
  });

  it('decides consent: source flag, then the allow-list, then the default (ADR-0035)', () => {
    const s = parseSources({
      sources: [{ id: 'art', default: true, adapter: 'x', publicUrl: 'https://a', printsAllowedDefault: false, printsAllowedWorks: ['w1'] }],
    })[0];
    expect(printsAllowed(s, 'w1')).toBe(true);
    expect(printsAllowed(s, 'w2')).toBe(false);
    expect(printsAllowed(s, 'w1', false)).toBe(false);
    expect(printsAllowed(s, 'w2', true)).toBe(true);
  });
});
