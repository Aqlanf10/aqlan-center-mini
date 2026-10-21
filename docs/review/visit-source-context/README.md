# Visit financial sources — bounded read-only composition

## Review status and baseline

Draft-only, awaiting independent review and hosted browser CI. No Production access, migrations, repair jobs, receipt edits, pricing/signing changes or new invoice writes are introduced. All DB fixtures are synthetic and use owned disposable PostgreSQL 18.4. No patient data or private report is included.

The separate branch `fix/visit-source-context` composes:

- Original Production baseline: `3f7b02b5a6cd31764543f466e3e58a1285f9efc5`.
- #380 documentary/report repairs at `b48f22326bf2672191b36332b620c65bc8a7b75a`.
- Main security #375: `018a94127cbc475031ca00034f31f35ce4b92515`.
- #371 canonical identity/historical-document implementation: `af709ae57c5efbb52d70998dac751f3c07df0d7c`.
- Composition checkpoint: `f7718b747fc6a7e29bcbf4dde57edcb9dc825c84`.
- Reviewed #380 test-only contract repair `7567062df64bc62136adf2fa2ea18ec16440441e`, cherry-picked here as `9860093ac6375e20e08f5a32aa93ad10aa9462d0`.

#380 remains frozen at `7567062df64bc62136adf2fa2ea18ec16440441e`. This composition is not independent of pending #371/#380 and must not be merged as an unreviewed replacement for those lanes. #379 was compared during the initial investigation; it supplies no additional source edge required here.

## Concrete defect and evidence

A signed visit can have no `visits.invoice_id`, yet contain a `visit_procedures` row whose exact ID is the persisted source of an active same-patient invoice item. The previous report/clinical documentary pointer alone cannot represent this. Conversely, another same-day visit for the same patient need not have any source. Patient/date/amount matching would invent a relationship.

The synthetic PostgreSQL tests demonstrate both states together, mixed invoiced/unresolved work, one explicit historical agreement across two visits without copying money, cancelled/foreign/mismatched references, same-currency replacement line identities, explicit no-charge versus missing/contradictory decisions, unsigned work, endodontic ambiguity and duplicate procedure/session/item paths. The new report column uses the same source summary as the clinical reader. Direct invoice/receipt columns and existing debt calculations retain their meanings.

## Exact source boundaries

| Path | Read result |
| --- | --- |
| Visit direct invoice ID | Owned documentary reference only; cancelled is historical; foreign/missing row is review. It never proves every work item is covered. |
| Visit → procedure → invoice item source ID | Verify patient, service, quantity, recorded unit price/line value, doctor, and any plan-item ID. Active same-patient exact evidence can establish coverage. |
| Original invoice item → correction line → replacement item | Follow only explicit correction IDs and matching parent invoice IDs/patient. Cancelled originals remain historical; active matching same-currency replacement can establish coverage. |
| Visit → procedure plan-item ID | Also verify current service/tooth/surfaces/provider identity, patient/plan/case ownership. Reuse canonical `PLAN_ITEM_PREBILLED_SQL` and legacy predicates. |
| Visit → completed treatment session/item visit ID | Exact item edge, same ownership checks. Deduplicate an item already represented by a procedure, and duplicate item/session paths. |
| Item → historical agreement/document | Reuse #371 `historicalDocumentReferences` unchanged, plus immutable coverage snapshot/site validation. No document total is allocated to a visit. |
| Adjustment → recorded no-charge decision | Only signed work, explicit outside-contract class, reason, actor, decision timestamp, and no contradictory invoice ID. Missing price/invoice or a legacy class is not a decision. |

`lib/visit-financial-context.ts` separates documentary reference, per-work coverage, recorded decision, and mixed/unresolved summary. The DB reader runs under the existing read-only snapshot helper and performs no schema bootstrap or writes. Document monetary values are internal inputs to the existing canonical document validator only; the new projection has no amounts, receipt status or monetary aggregation.

`lib/reports.ts` loads source contexts only for selected visit rows and labels verification as current, not as-of the historical report end date. Existing report admission is unchanged. The clinical GET has the same patient and assistant-day gates as clinical GET, rechecks patient ownership in the snapshot, and applies an explicit output allowlist. Existing `canViewMoney` roles include cashier; that does not grant a new clinical-route admission to cashier/accountant. Existing restricted-role route gates still apply. Nonfinancial roles receive no new source IDs, money or finance links. Signing, callbacks and request semantics are untouched.

## Deliberately unresolved edges

- Approved principals persist `terms.itemIds`, but membership alone is not canonical proof that their current backing source remains valid. They remain documentary/review references here. Future integration should reuse the existing approved source validator in the same snapshot, not compare plan totals or patient balances.
- An installment schedule alone does not identify or validate principal coverage.
- Orthodontic billing classes and billed decision invoice IDs are recorded evidence, not independently verified package coverage. Existing case bridges need the canonical package validator before certification.
- Endodontic episode/case identity does not establish a universal RCT item ID; the crown item is a different work item. Endodontic-only work remains unresolved.
- Historical sites not accepted by the immutable coverage/site validator remain unresolved; no tooth/case/service fallback is added.
- Currency-changing corrections and changed line identities remain unresolved. This reader does not reinterpret procedure amounts in another currency.
- Unsigned drafts, zero prices, waived flags without an explicit decision, narrative-only work, missing/deleted source rows and ambiguous historical records remain unresolved. A legacy class is never treated as free work.
- Receipt allocation/paid status, agreement balances, automatic repair, and account/checkout mutation semantics are outside this layer. Source references do not establish payment.

## Validation

- Owned PostgreSQL 18.4, Node 22: source, visits-report and canonical historical-document suites: 4 files, 56 tests passed.
- Focused projection/route, signing contract and route-policy unit checks: 4 files, 35 tests passed.
- Typecheck and lint: passed.
- Full unit suite: 611 files, 10,691 tests passed (283.94 seconds).
- Hosted browser/HTTP assertions added to existing real role-handoff and invoice/clinical-continuity journeys. Existing synthetic ortho browser fixture explicitly handles the new read. No local Chromium run; hosted proof remains required.

The first full unit run found the missing new GET entry in the exhaustive HTTP matrix (610 other files passed); the route was registered with exactly the existing clinical GET roles and the complete rerun passed. Typecheck caught two test-only optional-row accesses, which were corrected.

Initial added fixture failures were SQL schema/guard mistakes (duplicate source uniqueness, missing correction acknowledgement, plan required columns and int/bigint parameter typing); fixtures were corrected, without disabling any database guard. The historical-document guard also rejected an attempted individual-line void; the final void witness uses the existing standalone agreement void writer without bypassing the guard. A normal existing report loader emits a pg concurrent-query deprecation warning; the new source reader itself awaits each query sequentially.
