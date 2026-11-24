# ADR-0038: SES bounce and complaint notices forwarded by e-mail

- Status: Accepted
- Date: 2026-11-26
- Decided by: Klaus, 2026-11-26, on round-2 decision 10 as revised after review C: "decision 10: ok"

## Context

A mistyped e-mail address means the customer hears nothing. SES reports bounces and complaints through SNS (an HTTPS subscription or an SQS queue) or by e-mail forwarding to the sending address. Review B (F13) found the design had no intake; the triage proposed an SQS queue; review C found e-mail forwarding simpler at this volume.

## Options considered

1. An SNS HTTPS endpoint with signature verification: a public endpoint, exempt from the preview gate.
2. An SQS queue polled by a job: no public endpoint, but a queue, an IAM permission and a job.
3. **SES e-mail feedback forwarding** to the shop's sending address, which reaches Klaus's mailbox.

## Decision

Option 3. Klaus reads the notice and fixes the address; no code in the shop.

## Consequences

- Nothing to build, host or secure. Bounces are seen by Klaus, not recorded on the order.
- If bounces become frequent, option 2 is added then (a new ADR).
