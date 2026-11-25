# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

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
