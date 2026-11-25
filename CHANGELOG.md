# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Alerts to Klaus go out once per event: the reminder before a hold refunds automatically comes once per hold (it came every minute), and a reconciliation alarm once a day unless its content changes.
- E-mails: an order confirmation, a notice for each parcel with its tracking link, a note if an order is delayed or refunded, and "find my order" now sends its link. Klaus gets alerts for holds, failures and new orders.
- Launch prices set: postcards $4, prints $25–45, framed prints $59–79, mugs $18, t-shirts $26.
- Hourly reconciliation repairs what a lost message or a restart left behind and raises an alarm for anything it can't explain; personal data is removed 180 days after an order is complete.
- Admin: an Orders page and an order page with everything about one order, the open holds on the dashboard, and buttons to approve, refund, confirm anyway, retry or cancel (each asks "I'm sure").
- Refunds: an order that can't be fulfilled is refunded automatically once nothing is left at Printful; a refund cancels what Printful hasn't started; fraud warnings refund before production; disputes never refund automatically.
- The order page follows the order through Printful: in production, shipped (each parcel with its carrier, tracking link and expected delivery), delivered.
- Paid orders go to Printful automatically: a draft, a cost check, then confirmation (a test shop stops at the draft). Problems put the order on hold for Klaus instead of guessing.
- Every picture from art is offered with every product that prints sharply enough; the admin can switch a picture or product off. Prices are set per product.
- A whole purchase is tested in a browser on every change, against stand-ins for Printful, Stripe and the gallery.
- Paying with Stripe: Pay opens Stripe's checkout; the order page (`/order/<id>`, reached by the link in the success page) shows the order and its status; "Find my order" e-mails the link (e-mails arrive with a later step).
- The cart takes a US shipping address (with a ZIP check against the state) and shows a quote: the items, the shipping methods Printful offers, and the total before tax.
- Picture pages (`/p/<work>`) with the products on offer, a cart, and `/api/offers` for the gallery's link. Before go-live a preview key closes the shop, and test shops say so on every page.
- Admin at `/admin`: Google sign-in for the allowed address only, a dashboard, the works from the galleries with enable and disable, and per work the products offered, prices and crops, with a preview of each print file and Printful's mockup of the product.
- Picture images and print files are served from the shop itself (`/img/*`, `/files/*`), named by their content, rate-limited.
- `/health/worker`: 200 while the background job runner is alive, 503 otherwise, for the uptime monitor.
- The shop refuses to start with a configuration that doesn't fit its mode (`SHOP_MODE` mock, test or live) and names the problem.
- First service skeleton: `/health` with the release version, a placeholder home page linking to the gallery, a 404 page, strict Content Security Policy, compressed text.
- Repository baseline: PR checks (unit tests, dependency audit, four-browser e2e with axe, Lighthouse, CodeQL), image build on `main`, deploy workflow for `production`, Dependabot.
