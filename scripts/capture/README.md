# API captures

`capture-apis.mjs` records how the real Printful and Stripe APIs behave, so the mock
services (docs/design/14-mock-services.md) can be built and checked against them.

Allowed by Klaus on 2026-11-24: the Stripe **test** key, and careful Printful **draft**
orders, "but never actually order something". The script enforces it:

- Stripe: refuses any key that isn't `rk_test_`/`sk_test_`.
- Printful: reads only `PRINTFUL_TOKEN_TEST`, the **test store** (ADR-0029); the live store's token is never used.
- Printful: an allow-list of method + path; nothing that confirms an order is on it,
  and any path containing "confirm" is refused. Drafts get `external_id` `capture-…`;
  only drafts the script created may be edited or deleted; all are deleted at the end.
- `node scripts/capture/capture-apis.mjs --self-test` checks these guards without network.

Run on the cluster node (the keys are in its `.env`):

```bash
NODE_USE_ENV_PROXY=1 node scripts/capture/capture-apis.mjs --env <path to the shop .env on the node> --out <shop-private checkout>/captures/$(date +%F)
# options: --only printful,stripe,estimation,files (comma-separated), --no-drafts,
#          --stripe-version 2026-11-18.endive (default: the version stripe-node pins)
```

Output: one JSON file per scenario (requests, statuses, selected headers, bodies) and
`SUMMARY.txt`. The Authorization header is never recorded and anything that looks like a
key is replaced by `<redacted-key>`.

**Where the output goes** (ADR-0028): raw captures belong only in the private repository
`shop-private`. `--out` is required and the script refuses any directory inside this public
repository; `captures/` is also in `.gitignore`. Only synthetic fixtures, made from the
captures, are committed here.
