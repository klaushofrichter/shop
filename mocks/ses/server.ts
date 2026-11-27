/**
 * Mock SES v2 (docs/design/14): `POST /v2/email/outbound-emails` with a SigV4
 * signature checked against the mock key, the messages kept for assertions
 * (`GET /__mock/emails`). Keys start with `mock_ses_`.
 */
import express from 'express';
import { signV4 } from '../../src/email/ses';

export interface SentEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  feedbackTo?: string;
}

export function createMockSes(opts: { accessKeyId: string; secretAccessKey: string; region?: string }) {
  const sent: SentEmail[] = [];
  const state = { rejectNext: false, denyNext: false, failNext: false };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.text({ type: '*/*', limit: '1mb' }));
  app.get('/__mock/emails', (_req, res) => res.json(sent));
  app.post('/__mock/reset', (_req, res) => {
    sent.length = 0;
    res.json({ ok: true });
  });
  app.post('/v2/email/outbound-emails', (req, res) => {
    const body = String(req.body ?? '');
    const auth = req.get('authorization') ?? '';
    const amzDate = req.get('x-amz-date') ?? '';
    const expected = signV4({
      method: 'POST', path: '/v2/email/outbound-emails', body, amzDate,
      headers: { host: req.get('host') ?? '', 'content-type': req.get('content-type') ?? '', 'x-amz-date': amzDate },
      region: opts.region ?? 'us-east-1', service: 'ses', accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey,
    });
    if (auth !== expected) return res.status(403).json({ message: 'The request signature we calculated does not match the signature you provided.' });
    if (state.failNext) {
      state.failNext = false;
      return res.status(500).json({ message: 'mock: internal failure' });
    }
    const b = JSON.parse(body) as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: { Simple: { Subject: { Data: string }; Body: { Text: { Data: string }; Html: { Data: string } } } };
      FeedbackForwardingEmailAddress?: string;
    };
    if (state.denyNext) {
      state.denyNext = false;
      return res.status(403).json({ message: "User is not authorized to perform 'ses:SendEmail' on resource" });
    }
    if (state.rejectNext) {
      state.rejectNext = false;
      return res.status(400).json({ message: 'Email address is not verified.' });
    }
    sent.push({
      from: b.FromEmailAddress, to: b.Destination.ToAddresses, subject: b.Content.Simple.Subject.Data,
      text: b.Content.Simple.Body.Text.Data, html: b.Content.Simple.Body.Html.Data, feedbackTo: b.FeedbackForwardingEmailAddress,
    });
    res.json({ MessageId: `mock-${sent.length}` });
  });
  return { app, sent, control: state };
}
