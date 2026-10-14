# Invoice converted quote proposal — review required

Status: proposal only. No pricing, permission, API, schema, catalogue or FX changes are included in the monthly-schedule follow-up.

## Confirmed mismatch

The parent reports Production catalogue evidence for fixed orthodontics: YER 2200, displayed converted SAR 5 / USD 1, native SAR/USD blank. The user was **reception**, while the earlier live browser check used **manager**. These are different permission contexts.

`GET /api/services` uses `catalogPricesByCurrency` (`lib/service-pricing.ts`): a native currency value, including explicit zero, takes priority; otherwise it converts YER using configured `finance.rate.SAR` / `finance.rate.USD`, rounded to the nearest whole foreign major unit. Missing/invalid rates produce no quote. `invoiceCatalogPrice` deliberately selects only the native price, rejecting a converted display quote when the native field is null. `PatientLedger` uses that selector, explaining the invoice's unpriced SAR state. This is not evidence that a stored native SAR price disappeared.

Synthetic receptionist coverage reproduces the distinction with YER 2200 and explicitly seeded rates SAR 440 / USD 2200. Those rates are test fixtures, **not inferred live rates**. They yield converted SAR 5 / USD 1, with native fields null. The actual configured Production rates were not read.

## Narrow proposed change

1. Native configured currency prices always win. Preserve explicit zero, inactive/unconfigured-service refusal and current stale-catalogue protection.
2. For a missing native foreign price, a server-created quote may offer the existing shared configured conversion. Label it **converted**, never native. No available rate means no quote; retain explicit manual pricing under its separately approved policy.
3. Return an immutable quote snapshot containing service identity/version or exact relevant values, YER source price and minor-unit factor, target currency, configured rate value and setting version/source key, existing rounding policy/version, resulting minor units, and quote hash. Bind the command to patient, explicit visit when provided, actor/authority, service, quantity and currency through the existing command fingerprint.
4. Preview and create recompute and validate the quote on the server against the same authoritative catalogue/rate snapshot, inside the existing transaction/lock order. Do not accept a client-supplied rate or `priceIn` as authority. A changed rate/catalogue/quote requires a fresh preview and explicit acknowledgement (409); replay of an already committed identical idempotency key returns the original receipt without repricing.
5. Persist the accepted source/rate/rounding/result snapshot with the immutable agreement and audit. Later rate changes never rewrite an issued agreement, correction lineage or payment. Creating an agreement never creates a cash receipt. Schema additions, if required for durable snapshots, must first inspect the current migration registry.
6. Reuse the same quote source for invoice selection, preview and save. Keep manual changes explicitly reasoned and server-authorized. Do not mutate the service catalogue as a side effect.

## Permission decision requiring review

The existing policy in `lib/invoice-pricing.ts` explicitly treats foreign prices without native configuration as **unpriced**. A receptionist can enter an agreed price through that path; a native configured price increase remains admin-only, and discounts are constrained by `billing.max_discount_percent` with reasons. Treating converted SAR 5 as a native-style comparison baseline could make receptionist SAR 1500 an unauthorized increase. Therefore the pricing patch must explicitly decide whether a converted quote is an optional offer under existing unpriced agreement authority or a new comparison baseline. Do not silently widen permissions or reclassify it.

Audit finding: the ordinary invoice UI displays a price-reason input for an unpriced service, but `checkInvoiceAuthority` currently permits its `unpriced` override with a null reason; its shared `decideProcedurePrice` also permits that. Native increases/decreases and invoice discounts enforce their existing reasons. This follow-up does not change this pre-existing policy. Recommend a separate, reviewed invoice-specific reason requirement for an explicitly priced unconfigured catalogue service, shared by preview and save, with audit assertions and legacy caller/fixture review. Do not globally alter visit/plan pricing or free-text-line policy as an incidental change.

## Acceptance before pricing implementation

- Reception and manager tested separately; current doctor/cashier/accountant boundaries retained.
- Native priority in YER/SAR/USD, explicit zero, missing/invalid rate, inactive/unconfigured service.
- Converted source and rate snapshot visible; no invented rates; no catalogue mutation.
- Tampered/stale quote rejection, concurrent rate/catalogue update, exact-command lost-response replay, old agreements unaffected.
- Reason-required manual quotes and discount limits tested in both preview and save under the approved policy; no additional role capabilities granted.
- Real browser screenshots from the built app and synthetic database only.
