# ADR-0028: Sensitive test data in a private repository without CI

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25: "we can remove test data that includes possibly sensitive information. We may need a different place, perhaps a second private repository, for such data, but without any CI for costs reasons."

## Context

`klaushofrichter/shop` is public. Review 1 (F26, F27) found that the capture branches, though free of keys, contain test-mode payable Stripe URLs and client secrets, the Stripe account's display name and an account-id fragment, the Printful store id and object ids; and that the public documents carry operational detail (host paths, account and object ids, an incident note, the exact fail-safe thresholds). Review 2 (F8) asked for stronger redaction.

## Decision

- A second, **private** repository (proposed name `klaushofrichter/shop-private`) holds raw API captures, operational notes and anything else that must not be public. **GitHub Actions disabled** there (cost); nothing in it runs CI.
- The public capture branches are deleted once their content is in the private repository.
- The public repository holds only **synthetic** fixtures, produced from the private captures by an allow-list scrubber (per endpoint: the fields kept verbatim; everything else replaced by typed placeholders; ids rewritten consistently), and checked in CI (e-mail only at `example.com`, addresses from a fixed list, no client secrets, no provider pay URLs, no real-looking ids or keys).
- Operational details (host paths, account and object ids, incident notes) move from the public documents to the private repository; the fail-safe threshold values live in deployment configuration, not in public docs.

## Consequences

- The capture script writes to a checkout of the private repository; the scrubber is a separate step whose output is what enters the public repository.
- Creating the repository and its settings is done by Klaus or Cluster (cloud sessions can't change repository settings).
- Raw captures are never made from the live Stripe account.
