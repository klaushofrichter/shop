/**
 * The mock services as one process (docs/design/14 §2, §9): mock Printful,
 * mock Stripe and a fake art, each on its own port, for the CI e2e run and
 * local runs. Never deployed; the shop's startup guards refuse real hosts with
 * mock keys and mock hosts with real keys.
 *
 *   SHOP_URL=http://localhost:8080 npx tsx mocks/server.ts
 */
import { systemClock } from '../src/clock';
import { createFakeArt } from './art/server';
import { createMockPrintful } from './printful/server';
import { createMockStripe } from './stripe/server';
import { createMockSes } from './ses/server';

const SHOP_URL = (process.env.SHOP_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const port = (name: string, dflt: number) => Number(process.env[name] ?? dflt);

async function main() {
  const printful = createMockPrintful({
    clock: systemClock,
    webhook: {
      target: `${SHOP_URL}/webhooks/printful`,
      secretHex: process.env.MOCK_PRINTFUL_WEBHOOK_SECRET ?? 'e2e0'.repeat(16),
      publicKey: process.env.MOCK_PRINTFUL_WEBHOOK_PUBLIC_KEY ?? 'mock-pf-public-key-e2e',
    },
  });
  const stripe = createMockStripe({
    clock: systemClock,
    webhookSecret: process.env.MOCK_STRIPE_WEBHOOK_SECRET ?? 'mock-whsec-e2e',
    // The shop passes /__mock-pages/* through to this mock, so the page is same-origin (14 §9).
    checkoutBase: `${SHOP_URL}/__mock-pages/stripe/checkout`,
    webhookTarget: `${SHOP_URL}/webhooks/stripe`,
  });
  const art = await createFakeArt();
  const ses = createMockSes({ accessKeyId: process.env.MOCK_SES_KEY_ID ?? 'mock_ses_e2e', secretAccessKey: process.env.MOCK_SES_SECRET ?? 'mock-ses-secret-e2e' });
  printful.app.listen(port('MOCK_PRINTFUL_PORT', 9101));
  stripe.app.listen(port('MOCK_STRIPE_PORT', 9102));
  art.listen(port('MOCK_ART_PORT', 9103));
  ses.app.listen(port('MOCK_SES_PORT', 9104));
  console.log('mocks listening: printful 9101, stripe 9102, art 9103, ses 9104');
}

void main();
