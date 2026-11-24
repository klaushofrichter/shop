/**
 * Content sources (docs/design/04 §4, ADR-0035). Only an adapter knows its
 * source's format; the rest of the shop sees `Work`, allow-listed.
 */
import type { Readable } from 'node:stream';

export type WorkKind = 'painting' | 'photograph' | 'other';

export interface Work {
  sourceId: string;
  workId: string;
  title: string;
  creator?: string;
  year?: string;
  kind: WorkKind;
  /** The work's page at the source. */
  canonicalUrl: string;
  original: { url: string; widthPx?: number; heightPx?: number; version: string };
  /** The source's own per-work consent, once it publishes one; else undefined. */
  printsAllowedBySource?: boolean;
}

export interface WorkList {
  works: Work[];
  /** Entries the adapter skipped, and why (schema drift shows here). */
  problems: string[];
}

export interface ContentSource {
  readonly id: string;
  listWorks(): Promise<WorkList>;
  /** The original, as a stream with its declared type. */
  fetchOriginal(work: Pick<Work, 'original'>): Promise<{ body: Readable; contentType: string; contentLength?: number }>;
}

/** The source answered wrongly or not at all; worth retrying later. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}
