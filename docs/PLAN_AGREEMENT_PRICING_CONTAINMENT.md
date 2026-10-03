# V2 plan agreement amount: no-write containment

This local slice prevents a submitted agreement amount from being silently replaced by the existing V2 engine. It does not implement negotiated fixed-price item bundles, a new pricing engine, new schema, or historical corrections.

## Request contract

- `mode: "v2"` accepts optional `pricingMode: "items" | "agreed"`. Omitted mode keeps supported legacy callers. Unknown values are rejected with `agreement_pricing_unsupported` rather than silently selecting a basis
- `total`, when present and nonblank, is an explicit agreement amount in major units of the request currency, parsed by existing `parseAmount`. It must be positive. Declared `agreed` mode requires this amount; omitted/null/blank totals remain absent for legacy item-priced callers
- The amount must equal what unchanged `createPlanV2` would save: the normalized item total when items exist, otherwise the normalized installment total. Compare exact integer minor units after existing currency parsing/rounding, with no tolerance
- Disagreement returns HTTP 400 `agreement_pricing_unsupported` before `createPlanV2` or the creation audit is invoked. Invalid explicit amounts return HTTP 400 `invalid_agreement_total`
- `pricingMode: "items"` requires actual items. Neither a mode marker nor omitting it bypasses comparison of a supplied total
- The marker is a creation-time assertion, not a persisted fixed-price guarantee. A matching amount with items retains existing `total_from_items = true` semantics, including subsequent item/consent recalculation

## Compatibility and price authority

Known official callers remain supported: QuickPlan sends item-only per-procedure plans; QuickAgreement sends no items and a total with full derived installments; template plans use the unchanged template branch. Legacy financial/clinical routes remain unchanged.

Legacy external callers that used `total` as only a schedule subtotal while also sending differently priced items now receive a typed rejection. A provided invalid/nonpositive total also receives a typed rejection instead of being silently ignored. No unknown external callers have been verified. Preserving a different meaning requires an explicitly reviewed versioned contract, not guessing intent.

This is **not** a blanket schedule-completeness rule. An item-priced custom schedule may be partial, with no total or a total matching the item principal. Empty-item requests cannot currently preserve an explicit principal differing from their schedule and are refused rather than resized. Legacy empty-item schedules without a separate total continue using the existing schedule-derived principal.

Existing `checkInvoiceAuthority` still runs before the new guard. This guard neither discounts clinical items nor grants authority to change their prices. Equal submitted totals do not waive line-price reasons, discount caps, or uplift restrictions. No canonical totals, commission weights, historical collection attribution, or session billing rules change.

The advanced PatientPlans form submits its pricing discriminator and performs the same check before starting a request. Refusal preserves selected clinical items, teeth, prices, agreement amount, and installment draft. The form does not automatically delete rows, rewrite prices, change mode, or replace the schedule.

## Verification boundary

Focused tests exercise the pure comparison, actual POST with mocked database/session boundaries and real price-authority logic, and actual advanced-form handlers with synthetic React hooks. The route tests assert both creation writers and the audit writer are not called on mismatch. They are not evidence of real PostgreSQL rollback or a browser/HTTP round trip.

The current creation route has no keyed command replay. This slice does not add or claim create idempotency. Any later idempotency layer must replay a committed command before new pricing validation and recheck this containment for fresh commands.

Source/test authoring is local only. Publication and Production changes remain on hold; real database, built-HTTP/browser, full-suite, and independent-review gates are separate requirements.
