/**
 * The art adapter (docs/design/04 §4.3). Today art publishes no feed, so this
 * reads the manifest embedded in art's home page:
 *   <script type="application/json" id="manifest">[ rooms … ]</script>
 * Rooms of type "pictures" hold works; a work's original is served at
 * /assets/<room>/<file>?v=<v> (ADR-0025) and its permalink is /?id=<uid>.
 *
 * Only the fields the shop needs are read; prices, sale status, descriptions and
 * the About block of art's manifest are ignored (ADR-0035). A work whose fields
 * don't fit is skipped and reported, so schema drift is visible rather than
 * silently wrong.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { SourceConfig } from '../catalog-config';
import { SourceError, type ContentSource, type Work, type WorkKind, type WorkList } from './types';

const MANIFEST = /<script type="application\/json" id="manifest">([\s\S]*?)<\/script>/;
const UID = /^[a-z0-9]{4,32}$/;
const ROOM = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(jpe?g|png)$/i;
const VERSION = /^[A-Za-z0-9]{1,64}$/;

/** art's "Colors" room holds the paintings; the others are photographs (until art says so itself). */
const PAINTING_ROOMS = new Set(['colors']);

type FetchFn = typeof fetch;

export interface ArtAdapterOptions {
  /** Where to read from: art's in-cluster address on the cluster, else its public one. */
  readFrom: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export function parseArtManifest(html: string, source: Pick<SourceConfig, 'id' | 'publicUrl' | 'creator'>): WorkList {
  const m = MANIFEST.exec(html);
  if (!m) throw new SourceError('art: no manifest in the home page');
  let rooms: unknown;
  try {
    rooms = JSON.parse(m[1]);
  } catch {
    throw new SourceError('art: the manifest is not JSON');
  }
  if (!Array.isArray(rooms)) throw new SourceError('art: the manifest is not a list of rooms');

  const base = source.publicUrl.replace(/\/+$/, '');
  const works: Work[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const room of rooms as Array<Record<string, unknown>>) {
    if (room?.type !== 'pictures') continue;
    const roomId = room.id;
    if (typeof roomId !== 'string' || !ROOM.test(roomId)) {
      problems.push(`room ${JSON.stringify(roomId)}: id doesn't fit`);
      continue;
    }
    if (!Array.isArray(room.works)) {
      problems.push(`room ${roomId}: works is not a list`);
      continue;
    }
    for (const w of room.works as Array<Record<string, unknown>>) {
      const uid = w?.uid;
      const at = `room ${roomId}, work ${typeof uid === 'string' ? uid : '?'}`;
      if (typeof uid !== 'string' || !UID.test(uid)) { problems.push(`${at}: uid doesn't fit`); continue; }
      if (seen.has(uid)) { problems.push(`${at}: duplicate uid`); continue; }
      if (typeof w.title !== 'string' || !w.title.trim() || w.title.length > 200) { problems.push(`${at}: title missing or too long`); continue; }
      if (typeof w.file !== 'string' || !FILE.test(w.file)) { problems.push(`${at}: file doesn't fit`); continue; }
      if (typeof w.v !== 'string' || !VERSION.test(w.v)) { problems.push(`${at}: v doesn't fit`); continue; }
      seen.add(uid);
      const kind: WorkKind = PAINTING_ROOMS.has(roomId) ? 'painting' : 'photograph';
      const year = typeof w.date === 'string' && /^\d{4}/.test(w.date) ? w.date.slice(0, 4) : undefined;
      const creator = typeof w.artist === 'string' && w.artist.trim() ? w.artist.trim() : source.creator;
      works.push({
        sourceId: source.id,
        workId: uid,
        title: w.title.trim(),
        creator,
        year,
        kind,
        canonicalUrl: `${base}/?id=${encodeURIComponent(uid)}`,
        original: {
          url: `${base}/assets/${roomId}/${encodeURIComponent(w.file)}?v=${w.v}`,
          version: w.v,
        },
      });
    }
  }
  if (works.length === 0) throw new SourceError(`art: no usable works (${problems.length} problems)`);
  return { works, problems };
}

export class ArtManifestSource implements ContentSource {
  readonly id: string;
  private readonly fetch: FetchFn;
  private readonly timeoutMs: number;
  private etag: string | undefined;
  private last: WorkList | undefined;

  constructor(private readonly config: SourceConfig, private readonly opts: ArtAdapterOptions) {
    this.id = config.id;
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async listWorks(): Promise<WorkList> {
    const headers: Record<string, string> = { accept: 'text/html' };
    if (this.etag && this.last) headers['if-none-match'] = this.etag;
    const res = await this.get(`${this.opts.readFrom.replace(/\/+$/, '')}/`, headers);
    if (res.status === 304 && this.last) return this.last;
    if (!res.ok) throw new SourceError(`art: home page answered ${res.status}`);
    const list = parseArtManifest(await res.text(), this.config);
    this.etag = res.headers.get('etag') ?? undefined;
    this.last = list;
    return list;
  }

  async fetchOriginal(work: Pick<Work, 'original'>) {
    // Stored URLs are public; on the cluster, read through art's in-cluster address.
    const pub = new URL(work.original.url);
    const from = new URL(this.opts.readFrom);
    if (pub.origin !== new URL(this.config.publicUrl).origin) throw new SourceError('art: original outside the source');
    const url = new URL(pub.pathname + pub.search, from);
    const res = await this.get(url.toString(), { accept: 'image/jpeg, image/png' });
    if (!res.ok || !res.body) throw new SourceError(`art: original answered ${res.status}`);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const len = Number(res.headers.get('content-length'));
    return {
      body: Readable.fromWeb(res.body as unknown as WebReadableStream),
      contentType,
      contentLength: Number.isFinite(len) && len > 0 ? len : undefined,
    };
  }

  private async get(url: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch (e) {
      throw new SourceError(`art: ${(e as Error).name} reading ${new URL(url).pathname}`);
    }
  }
}
