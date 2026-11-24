import type { SourceConfig } from '../catalog-config';
import type { Mode } from '../config';
import { ArtManifestSource } from './art';
import type { ContentSource } from './types';

/** One adapter per configured source. On the cluster, read through the in-cluster address. */
/** `mockSourceUrl` (mock mode only) replaces every source's address: the fake art of the e2e run. */
export function createSources(configs: SourceConfig[], mode: Mode, fetchFn?: typeof fetch, mockSourceUrl?: string): Map<string, ContentSource> {
  const out = new Map<string, ContentSource>();
  for (const c of configs) {
    const readFrom = mode === 'mock' && mockSourceUrl ? mockSourceUrl : mode !== 'mock' && c.clusterUrl ? c.clusterUrl : c.publicUrl;
    switch (c.adapter) {
      case 'art-manifest':
        out.set(c.id, new ArtManifestSource(c, { readFrom, fetch: fetchFn }));
        break;
      default:
        throw new Error(`source ${c.id}: unknown adapter ${c.adapter}`);
    }
  }
  return out;
}
