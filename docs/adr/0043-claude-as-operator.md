# ADR-0043: Claude as the shop's operator

- Status: Accepted
- Date: 2026-11-25
- Decided by: Klaus, 2026-11-25, answering the four open questions: "1: Claude should be able to read and diagnose the system, and also act. 2: at this time, certain changes like pricing can be depending on a new deployment. But eventually we want this dynamic - it is not needed for now 3: I have no strong opinion about the MCP server design. I think it can be part of the shop process, if that is easier. 4: The requirement is that I can talk to Claude, which can run locally on the node, just like the cluster agent. An API that is protected by a token is useful to use Claude in the Cloud, so that's good to have, but not mandatory as long as I can interact with Claude and do not need to do everything manually."

## Context

Klaus wants to run the shop by asking Claude:

- reads: "show recent orders", "how many orders are pending", "which SKU is most popular in the last seven days";
- actions: "unblock the cost circuit breaker", "change the price of the t-shirt M to $15";
- a dashboard (a Claude Dashboard artifact) that shows the state and possibly offers actions.

Today:

- The admin pages show most of this to a signed-in browser, and nothing else. There is no API, and Claude can't use the admin's Google sign-in.
- Prices live in `config/skus.json`: a price change is a commit and a deploy (ADR-0022, ADR-0041).
- Every admin action goes to `admin_audit`. Holds, refunds and the breaker have conditional, audited actions (08 §3).

## Options considered

1. **A read-only JSON API plus an MCP server** that Claude connects to: Claude answers questions; actions stay in the admin pages.
2. **(1) plus a small, explicit set of actions** through the same API: reset the breaker, approve or refund a hold, run reconciliation, change a price. Each action is the admin's existing action, with its conditional update and `admin_audit` row; the actor is the token's name.
3. **Direct database or shell access for Claude:** rejected. No audit, no invariants, and the database is the source of truth for money.

## Proposal

Option 2, built as milestone 12:

- **API.** `/api/ops/v1/*` on the shop, outside the preview gate.
  - Authenticated with a long random bearer token per client (`OPS_TOKEN_*` in the node's `.env`). Read and act are separate tokens.
  - Rate-limited. No customer e-mail or street address in responses unless asked for one order. Every call is logged.
- **Reads:** orders (filter by state, date, hold); counts by derived status; open holds with deadlines; sales by SKU and work over a period; the breaker's state (count, cost, limits, last reset); reconciliation runs and alarms; job queue and health; current prices and Printful costs.
- **Actions,** each the admin's own code path, audited:
  - reset the breaker; approve, confirm-anyway, retry or refund a held order; run reconciliation;
  - set a price per SKU.
  - Large refunds and price drops below the cost check ask for a confirmation token from a first call ("dry run, then confirm").
- **Prices at runtime:** a `price_overrides` table in `catalog.db` (SKU, price, who, when). `skus.json` stays the default; the cost check and cost guard keep refusing a loss. This amends ADR-0022 for prices only.
- **MCP server:** a small MCP server Klaus adds as a connector, wrapping the API. Tools: `list_orders`, `order`, `stats`, `holds`, `breaker`, `reset_breaker`, `set_price`, … Read and act tools are separate, so a read-only connection is possible.
- **Dashboard:** a Claude Dashboard artifact fed by the read API: orders today and this week, open holds, the breaker, sales by product, alerts. Actions stay in chat, where Claude asks before acting.

## Decision (Klaus's answers, 2026-11-25)

1. **Read, diagnose and act.** Claude gets the reads and the audited actions above.
2. **Prices change by deploy for now.** Claude prepares the change to `config/skus.json` as a pull request; it goes live with the next deployment. A runtime `price_overrides` table is deferred until Klaus wants dynamic prices; ADR-0022 stays as it is.
3. **The MCP server runs inside the shop process.** It is one more route or entry point, with no separate service.
4. **The primary path is Claude running locally on the node,** as the Cluster agent does. It reaches the shop over the cluster network or `kubectl`, not the internet. A token-protected API for Claude in the cloud is good to have, not required; if it is built, it sits behind the same separate read and act tokens.

So the first build is: a read and act tool set inside the shop, reachable by a Claude session on the node, every action through the admin's audited code path. Price changes are prepared as a pull request. The Claude Dashboard is fed by the same reads.

## Consequences

- One more authenticated surface: tokens, a rate limit and an audit for each.
- Prices still change by deploy; a runtime override is a later ADR.
- How the node's Claude reaches the shop (a local port, `kubectl port-forward`, or a stdio MCP command run in the pod) is settled with Cluster when the milestone starts.
