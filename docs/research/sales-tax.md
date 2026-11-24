# Sales tax: how others handle it, and what this shop must do

Research 2026-11-24. **Not legal or tax advice.** docs.stripe.com could not be opened
from the research session; Stripe facts come from search results pointing at Stripe's
pages, unverified details are marked **[U]**. Klaus's requirement: "We want to be
able to pay sales tax as legally required."

## 1. How comparable shops do it

| Setup | Who calculates | Who collects and remits | Note |
|---|---|---|---|
| Shopify (Shopify Tax) | Shopify | the seller registers and files | Threshold "liability insights" per state. https://help.shopify.com/en/manual/taxes/shopify-tax |
| Printful Quick Stores | Printful | **Printful** (seller of record) | No registration for the artist. https://help.printful.com/hc/en-us/articles/15045922586780 |
| Etsy and marketplaces | the marketplace | **the marketplace** (marketplace facilitator laws, all sales-tax states) | Some states still want a return from the seller. https://help.etsy.com/hc/articles/360000343968 |
| Custom shop + Stripe Checkout (Pressline, this design) | Stripe Tax (`automatic_tax`) | **the seller**, in states where he registered | Stripe calculates only where a registration is added. https://docs.stripe.com/tax/checkout |
| TaxJar / Avalara / Anrok / Quaderno | the service | the seller, or the service files for a subscription | Worth it with many states or high volume. |
| Most open-source POD shops | nobody | nobody | Uncollected tax becomes the owner's debt, with interest; no time bar if no return was filed. |

This shop is not a marketplace, so collecting and remitting is Klaus's obligation.

## 2. What the law generally requires

- **Home state** (physical nexus): if it taxes these goods, register **before the first sale** and collect on every sale shipped into that state. Five states have no statewide sales tax: Alaska (local taxes only), Delaware, Montana, New Hampshire, Oregon.
- **Other states** (economic nexus): usually $100,000 in sales or 200 transactions a year; many states dropped the transaction count (AK, CA, CO, IL, IN, IA, LA, ME, MA, NC, ND, SD, UT, WA, WY, KY from 2026-08); CA, NY, TX use $500,000 [U]. At < 10 orders a week (~500 a year, nationwide) the shop is far below every threshold: **in practice only the home state applies**, until volume grows.
- **Products**: prints, posters, postcards, framed art and mugs are taxable tangible goods almost everywhere. **Clothing** is exempt in some states (PA, NJ, MN, VT; MA up to $175 per item; RI up to $250; NY under $110 from the state rate) [U].
- **Shipping** charges are taxable in some states, not in others, or only when listed together with taxable goods; Stripe handles it when the shipping rate carries the shipping tax code.
- **Filing**: the state assigns monthly, quarterly or annual at registration; small sellers usually get quarterly or annual. A return is often due even when nothing was collected.

## 3. Stripe Tax

- Checkout: `automatic_tax.enabled = true`, prices `tax_behavior: exclusive`, a `tax_code` on each line item and on the shipping rate. Registrations under Dashboard → Tax → Registrations; without one Stripe calculates $0 for that state. Test mode has its own registrations.
- Tax codes: `txcd_99999999` (General – Tangible Goods) for prints, framed prints, postcards, mugs; `txcd_92010001` (shipping); clothing probably `txcd_30011000` [U] (confirm with `GET /v1/tax_codes`).
- Address source: Checkout uses the shipping address it collects, else the billing address [U]. This design passes the address on a Customer (ADR-0023) instead; that Stripe Tax uses it is on the verify list (docs/design/13 §4). Fallback: let Checkout collect the shipping address, restricted to the quoted country, and compare with the quote.
- Monitoring: the Dashboard tracks sales per state against thresholds and alerts [U detail].
- Price: 0.5% of the transaction (tax included) through Checkout, only in registered states. At ~$40 × 500 orders a year: about $100 a year.
- Filing: Stripe doesn't file itself; in the US it offers TaxJar filing inside Stripe Tax with a paid plan [U price]. Without it: Tax → Reports gives an itemised export and a summary by jurisdiction, enough to file one state by hand (~15 minutes a quarter).

## 4. Printful's side

Printful charges the merchant sales tax on its wholesale cost in most states unless a
**resale certificate** is on file (Dashboard → Billing → Tax information → Resale
certificates). Without it the goods are taxed twice (wholesale to Klaus, retail to the
customer). Many states accept the home-state certificate; Printful also accepts the MTC
multijurisdiction form and the Streamlined Sales Tax form F0003.
https://help.printful.com/hc/en-us/articles/360014009900

## 5. Minimal compliant setup

**Klaus (before go-live):**
1. Check whether the home state has a sales tax and whether it taxes each product (clothing!).
2. Register for a seller's permit with the home state (usually free).
3. Add that registration in Stripe Tax (live mode; and one in test mode for testing) and set the origin address.
4. Upload the resale certificate to Printful.
5. File on the assigned schedule: by hand from Stripe's report, or with the paid filing option.
6. Quarterly: glance at Stripe's threshold monitoring; register elsewhere only if it alerts.

**The software** (docs/design/05 §6):
- Checkout with `automatic_tax`, tax-exclusive prices, tax codes per SKU kind and on shipping.
- Quote page: "Sales tax, if any, is calculated on the payment page".
- Store per order: total tax, tax per line (from the session's line items), ship-to state and ZIP, session id.
- Admin export by period and state: items, shipping, tax collected, refunds; a cross-check of Stripe's report.

Sources: Stripe tax pricing https://stripe.com/tax/pricing, https://support.stripe.com/questions/understanding-stripe-tax-pricing; Stripe tax codes https://docs.stripe.com/tax/tax-codes; Stripe filing https://docs.stripe.com/tax/filing; TaxJar + Stripe https://www.taxjar.com/blog/how-taxjar-and-stripe-tax-work-together; economic nexus changes https://www.avalara.com/us/en/blog/2025/06/states-eliminating-economic-nexus-transaction-thresholds; Printful resale certificates https://support.printful.com/hc/en-us/articles/41396659533457; Streamlined Sales Tax https://www.streamlinedsalestax.org/for-states/exemptions.
