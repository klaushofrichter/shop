/**
 * Amazon SES v2 `SendEmail` over HTTPS with Signature Version 4 (ADR-0015):
 * one endpoint, so no SDK. The feedback-forwarding address takes bounces and
 * complaints (ADR-0038); it is never the From or Reply-To.
 */
import { createHash, createHmac } from 'node:crypto';
import { iso, type Clock } from '../clock';

export interface SesOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Mock mode only: the mock SES. */
  endpoint?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Signs the request's date; the shop's one clock (07 §4). */
  clock: Clock;
}

export interface Message {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  feedbackTo?: string;
}

export class SesError extends Error {
  constructor(readonly permanent: boolean, message: string, readonly status?: number) {
    super(message);
    this.name = 'SesError';
  }
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();

/** SigV4 for a request with the given headers (lower-case names), returning the Authorization value. */
export function signV4(o: {
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
}): string {
  const names = Object.keys(o.headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${o.headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signed = names.join(';');
  const canonical = [o.method, o.path, o.query ?? '', canonicalHeaders, signed, sha256(o.body)].join('\n');
  const date = o.amzDate.slice(0, 8);
  const scope = `${date}/${o.region}/${o.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), o.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}

export class SesClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: SesOptions) {
    this.base = (opts.endpoint ?? `https://email.${opts.region}.amazonaws.com`).replace(/\/+$/, '');
    this.fetch = opts.fetch ?? fetch;
  }

  /** Returns SES's message id. Permanent errors (a refused address, a bad request) are not worth retrying. */
  async send(m: Message): Promise<string> {
    const path = '/v2/email/outbound-emails';
    const body = JSON.stringify({
      FromEmailAddress: m.from,
      Destination: { ToAddresses: [m.to] },
      Content: {
        Simple: {
          Subject: { Data: m.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: m.text, Charset: 'UTF-8' }, Html: { Data: m.html, Charset: 'UTF-8' } },
        },
      },
      ...(m.feedbackTo ? { FeedbackForwardingEmailAddress: m.feedbackTo } : {}),
    });
    const url = new URL(this.base + path);
    const amzDate = iso(this.opts.clock).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const headers: Record<string, string> = { host: url.host, 'content-type': 'application/json', 'x-amz-date': amzDate };
    headers.authorization = signV4({
      method: 'POST', path, headers: { host: headers.host, 'content-type': headers['content-type'], 'x-amz-date': amzDate }, body,
      region: this.opts.region, service: 'ses', accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey, amzDate,
    });
    let res: Response;
    try {
      res = await this.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000), redirect: 'error' });
    } catch (e) {
      throw new SesError(false, `ses: no answer (${(e as Error).name})`);
    }
    const json = (await res.json().catch(() => ({}))) as { MessageId?: string; message?: string; Message?: string };
    if (res.ok && json.MessageId) return json.MessageId;
    const msg = `ses: ${json.message ?? json.Message ?? `HTTP ${res.status}`}`.slice(0, 300);
    // 429 and 5xx are worth another try; other 4xx (MessageRejected, a sandbox recipient, a bad address) are not.
    throw new SesError(res.status < 500 && res.status !== 429, msg, res.status);
  }
}
