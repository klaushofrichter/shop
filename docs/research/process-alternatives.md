# Process alternatives: build, hosted store, or marketplace

Research 2026-11-24, for the question "is a custom shop the right process at all?".
printful.com and shopify.com pages could not be opened from the research session,
so facts come from search summaries of vendor help pages: **[V]** vendor page
summary, **[U]** unverified (third-party or not confirmed). Card fees (about
2.9% + 30¢) apply to every option and are left out unless they differ.

## Requirements used for the comparison

From [01-requirements](../design/01-requirements.md): picture chosen on art carries
over (R1); several products per picture (R2); quote before payment (R4); previews
(R5); automated end to end with no routine work for Klaus (R9); adding a picture is
configuration (R10); < 10 orders a week (R11); his own look on his own domain.

## Comparison

| Option | Setup | Effort per new painting | Monthly | Per-order platform fee | Look / deep link | Automation | Data, lock-in |
|---|---|---|---|---|---|---|---|
| **Custom service (this design)** | High: build and run on k3s | ~2 min: enable in admin, pick crops; files and mockups are generated | $0 | none | Full, own domain, deep link with the picture | Full; tracking email is ours to send | Full ownership |
| Printful Quick Stores | Very low | ~15–30 min: 5 products in Printful's designer [U] | $0 [V] | none [V] | `*.printful.me`, no custom domain [V/U]; per-product links [U] | Full; Printful takes payment [V] | Printful owns checkout and customers; **US sellers and US buyers only** [V] |
| Shopify Starter + Printful app + Buy Button on art | Low–medium | ~15–30 min per painting in Printful, synced to Shopify [U] | $5 [V] | Starter may carry a higher fee [U] | Buy Button popup on art per product [V] | Full; Shopify emails tracking [V] | Shopify, exportable |
| Shopify Basic + Printful | Medium (theme) | as above | ~$29–39 [U] | 0% with Shopify Payments [U] | High via theme | Full | Shopify |
| Squarespace Core + Printful | Medium | as above | ~$23–39 [U] | 0% [U] | High | Full [U] | Squarespace |
| WooCommerce + Printful | Medium–high (WordPress to run) | as above | hosting | none | Full | Tracking only as an order note unless notifications are on [V] | Own, but WordPress to maintain |
| Etsy + Printful | Low | listing per product | $0 + $0.20/listing | ~6.5% + 3% + $0.25, Offsite Ads 12–15% [U] | Etsy's | Full | Etsy owns the customer |
| Big Cartel + Printful | Low | as Printful | ~$10–20 [V/U] | none [U] | Medium | Shipping rates set by hand [V] | Medium |
| Fourthwall | Low | upload | $0 | flat per item [V] | custom domain [V] | Full (their production, not Printful) | Platform |
| Redbubble / Society6 | Very low | upload | $0 / fees [U] | royalty ~10% [U] | none | Full | Total |
| Stripe Payment Links + Zapier/Make → Printful | Medium | one link per item + mapping | Zapier/Make plan | none | Stripe page | Fragile: line items and duplicate guards are DIY [V] | Yours + Zapier |

## What the integrations do and don't automate

- Platform integrations (Shopify, Wix, WooCommerce…) import paid orders into Printful and can **auto-confirm** them ("Automatically confirm orders to be fulfilled") [V]. The platform sends the tracking email using what Printful pushes back [V].
- For **API stores** like ours, nothing shows that Printful emails end customers [U]. Printful has a public tracking page customers can subscribe to [V]. So in the custom design, the shipping email (R8, optional) is ours to send from the `shipment_sent` webhook.
- Packing slips can carry Klaus's logo and a message, not Printful's branding [V] (v2 `customization.packing_slip`, confirmed in the v2 OpenAPI spec).

## Assessment

**The cheapest fully automated setup** is Shopify Starter ($5/month) with the Printful
app and a Buy Button per product on art. It needs no code, and Shopify sends the
shipping emails. Its costs: 15–30 minutes of product setup in Printful per painting
(5 products each), a Shopify-branded popup cart instead of the shop's own pages, a
monthly fee, and customer data in Shopify.

**Printful Quick Stores** is free but limited to US sellers and buyers, has no custom
domain and almost no branding.

**The custom service** fits the requirements best on three points the others miss:
- **R1/R10:** the painting chosen on art *is* the input; making a painting
  purchasable is a toggle in the admin, because print files and mockups are generated
  from the original. With every hosted option, each painting is a manual product setup
  in Printful's designer, about 25 paintings × 5 products today.
- **Own look and domain**, consistent with art, without a third-party cart popup.
- **No monthly fee and no lock-in**, on infrastructure (k3s, CI, backups, monitoring)
  that already exists and is run by the Cluster session.

Its costs are the build (estimated at a few thousand lines, mostly tests) and owning
its operation: secrets, backups, webhooks, the shipping email, and Printful API changes.

**Recommendation:** keep the custom service (ADR-0003). It is the only option where
neither an order nor a new painting needs Klaus's hands. Two fallbacks are worth
knowing: if the build stalls, Shopify Starter + Buy Button can be running in a day
with the same Printful account; and the reviewers should challenge whether the
custom build's extra value over Shopify Starter is worth its cost to Klaus.

## Sources

- Quick Stores cost, payouts, billing: https://help.printful.com/hc/en-us/articles/15045650586780, https://help.printful.com/hc/en-us/articles/15045592337180, https://help.printful.com/hc/en-us/articles/15045715768604, https://www.printful.com/quick-stores
- Printful auto-confirm and import settings: https://help.printful.com/hc/en-us/articles/360014066619
- Printful tracking to platforms: https://help.printful.com/hc/en-us/articles/360014006880; tracking page: https://help.printful.com/hc/en-us/articles/360021617060; packing slip: https://help.printful.com/hc/en-us/articles/360014065499; WooCommerce tracking: https://help.printful.com/hc/en-us/articles/360017048679; API (manual order) stores: https://help.printful.com/hc/en-us/articles/23581702148764
- Shopify Starter: https://help.shopify.com/en/manual/intro-to-shopify/pricing-plans/plans-features/shopify-starter-plan; Buy Button: https://help.shopify.com/en/manual/online-sales-channels/buy-button
- Etsy fees: https://help.etsy.com/hc/en-us/articles/115014483627
- Big Cartel + Printful: https://www.bigcartel.com/resources/help/article/printful
- Fourthwall: https://fourthwall.com/print-on-demand
- Stripe Payment Links + Zapier: https://help.zapier.com/hc/en-us/articles/10821467221133; Make: https://www.make.com/en/integrations/printful/stripe
