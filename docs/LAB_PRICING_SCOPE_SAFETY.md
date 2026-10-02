# Lab pricing scope and quote provenance

## Defect and bounded change

The order form previously showed a quantity breakdown only for more than one
unit and did not show the selected service's stored tooth scope. More importantly,
a quote from the previous lab/service/date could remain in both the form and the
submitted cost while a replacement lookup was pending, missing, or unsuccessful.
The response guard also ran before reading JSON, allowing an older response body
to overwrite a newer selection.

The form now:

- Shows the selected service's actual stored scope, its per-tooth or whole-work
  basis, and the quantity from the unchanged `labPricingQuantity` helper.
- Shows numeric unit price × actual quantity = automatic total, including one
  unit and an explicit zero price. A service name is never used to infer scope.
- Associates each resolved quote with the selected lab, service, and sent date;
  clears its presentation when switching; and rechecks request activity after
  JSON is read. Repeated A→B→A selection cannot reuse the previous A quote.
- Derives automatic input/submission values directly from that matching quote.
  Pending automatic submissions are blocked; an explicitly entered manual
  amount remains allowed. Missing/error quotes never carry an old automatic cost.
- Keeps a manual amount/currency together. A later successful selection resets
  an override that predates that selection, preserving the established form rule.
  Edits made while a request is pending take precedence over its late response.
- Preserves the existing optional-cost API behavior after a missing/error quote:
  an empty value sends neither `cost` nor `costCurrency`; the server's existing
  fallback remains authoritative. Lookup failures are distinct from “no rule.”

This changes no catalog row, saved quote, rate, database schema, server calculation,
permission, or historical order. It makes no claim that a current service's stored
scope is the owner's intended scope, or that any historical order was overcharged.

## Regression evidence

`__tests__/security-http/lab-pricing-scope-ui.test.ts` exercises the actual built
`/lab` page with a real test session. Its catalog, pricing, patient-search and order
endpoints are synthetic browser fixtures. Submitted payloads are inspected rather
than persisted; these cases create no lab orders or financial transactions.

Coverage includes stored scope despite a misleading service name; single tooth,
bridge, full arch, general and unknown scope; no teeth/single/multiple teeth;
zero-price display (the existing API still rejects an explicit zero submission);
missing/error/invalid quote; delayed/out-of-order replies; A→B→A;
JSON completing after a new selection; pending-submit handler/button guards;
manual edits while pending; currency-only manual override; lab/date changes; cancel/reopen; and successful-submit
reset. The pricing block is captured at desktop and 390px widths in the existing
`.settings-ui-artifacts/` directory for visual inspection. The dedicated
`lab-pricing-ui-screenshots` CI artifact uploads only the two explicitly named
synthetic PNGs, with hidden-file inclusion required for that directory. Missing
screenshots fail the artifact step; no broad hidden-file upload is allowed.
Optional `LAB_PRICING_UI_SCREENSHOT` overrides the path for local runs.

Run after the ordinary production build, against an isolated PostgreSQL test
server, using the repository's HTTP harness:

```sh
npm run test:security-http -- __tests__/security-http/lab-pricing-scope-ui.test.ts
```

The normal CI pipeline remains the full merge gate. This focused test is not a
claim that live Production has been exercised or deployed.
