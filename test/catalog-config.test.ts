import { describe, expect, it } from 'vitest';
import { CatalogConfigError, loadSkus, loadSources, parseSkus, parseSources, printsAllowed } from '../src/catalog-config';

describe('config/skus.json', () => {
  it('loads the launch SKUs in mock and test mode', () => {
    const c = loadSkus('config/skus.json', 'test');
    expect(c.minDpiPaper).toBe(180);
    expect(c.byId.get('print-12x16')?.variants.any).toBe(1349);
    expect(c.skus.filter((s) => s.kind === 'apparel')).toHaveLength(4);
  });

  it("carries Klaus's launch prices, accepted in live mode (ADR-0041)", () => {
    const c = loadSkus('config/skus.json', 'live');
    expect(c.skus.every((s) => !s.placeholderPrice)).toBe(true);
    expect(c.byId.get('print-8x10')?.priceCents).toBe(3200);
  });

  it('refuses a placeholder price in live mode', () => {
    const raw = { minDpiPaper: 180, skus: [{ id: 'p', name: 'P', kind: 'paper', provider: 'printful', productId: 1, variants: { any: 1 }, printAreaIn: [8, 10], dpi: 300, taxCode: 'txcd_99999999', priceCents: 100, placeholderPrice: true }] };
    expect(() => parseSkus(raw, 'live')).toThrow(/placeholder price in live mode/);
    expect(parseSkus(raw, 'test').skus).toHaveLength(1);
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
  it('loads art as the default source, every work allowed (ADR-0040)', () => {
    const [art] = loadSources('config/sources.json');
    expect(art).toMatchObject({ id: 'art', default: true, printsAllowedDefault: true, printsAllowedWorks: [] });
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
