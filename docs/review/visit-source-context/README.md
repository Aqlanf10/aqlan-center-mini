# Visit financial sources — bounded read-only composition

## Review status and baseline

Draft-only, awaiting independent review and hosted browser CI. No Production access, migrations, repair jobs, receipt edits, pricing/signing changes or new invoice writes are introduced. All DB fixtures are synthetic and use owned disposable PostgreSQL 18.4. No patient data or private report is included.

The separate branch `fix/visit-source-context` composes:

- Original Production baseline: `3f7b02b5a6cd31764543f466e3e58a1285f9efc5`.
- #380 documentary/report repairs at `b48f22326bf2672191b36332b620c65bc8a7b75a`.
- Main security #375: `018a94127cbc475031ca00034f31f35ce4b92515`.
- #371 canonical identity/historical-document implementation: `af709ae57c5efbb52d70998dac751f3c07df0d7c`.
- Composition checkpoint: `f7718b747fc6a7e29bcbf4dde57edcb9dc825c84`.
- Review follow-up includes ONLY #382 delta `af709ae57c5efbb52d70998dac751f3c07df0d7c..2b52888a06a9ea23a014a8913d4a3147a64f0c56`; all five files are byte-identical to that reviewed increment. No whole branch was copied.
- Reviewed #380 test-only contract repair `7567062df64bc62136adf2fa2ea18ec16440441e`, cherry-picked here as `9860093ac6375e20e08f5a32aa93ad10aa9462d0`.

The original #380 source seal is `7567062df64bc62136adf2fa2ea18ec16440441e`. Its reviewed fixture-only successor `2e13e72adec89e2f0b3bd561ab01b5b90171005c` is also included here as the exact three-file increment: shared TEMP visit schema, annual fixture and expense-comparison fixture. It changes no application source. This composition is not independent of pending #371/#380 and must not be merged as an unreviewed replacement for those lanes. #379 was compared during the initial investigation; it supplies no additional source edge required here.

## Concrete defect and evidence

A signed visit can have no `visits.invoice_id`, yet contain a `visit_procedures` row whose exact ID is the persisted source of an active same-patient invoice item. The previous report/clinical documentary pointer alone cannot represent this. Conversely, another same-day visit for the same patient need not have any source. Patient/date/amount matching would invent a relationship.

The synthetic PostgreSQL tests demonstrate both states together, mixed invoiced/unresolved work, one explicit historical agreement across two visits without copying money, cancelled/foreign/mismatched references, same-currency replacement line identities, explicit no-charge versus missing/contradictory decisions, unsigned work, endodontic ambiguity and duplicate procedure/session/item paths. The new report column uses the same source summary as the clinical reader. Direct invoice/receipt columns and existing debt calculations retain their meanings.

## Exact source boundaries

| Path | Read result |
| --- | --- |
| Visit direct invoice ID | Owned documentary reference only; cancelled is historical; foreign/missing row is review. It never proves every work item is covered. |
| Visit → procedure → invoice item source ID | Verify patient, denomination, service, quantity, recorded unit price/line value, doctor, and any plan-item ID. Denomination is the persisted visit billing currency for standalone work, or the explicit same-patient linked plan currency; there is no patient/default-currency fallback. Active same-patient exact evidence can establish coverage. |
| Original invoice item → correction line → replacement item | Follow only explicit correction IDs and matching parent invoice IDs/patient, with correction metadata checked against both actual invoice denominations. Cancelled originals remain historical; active matching same-currency replacement can establish coverage. |
| Visit → procedure plan-item ID | Also require linked-session quantity 1 (the existing `setVisitProcedures` contract) and verify current service/tooth/surfaces/provider identity, patient/plan/case ownership. Reuse canonical `PLAN_ITEM_PREBILLED_SQL` and legacy predicates. |
| Visit → completed treatment session/item visit ID | Exact item edge, same ownership checks. Deduplicate an item already represented by a procedure, and duplicate item/session paths. |
| Item → historical agreement/document | Reuse #371 `historicalDocumentReferences` unchanged, plus immutable coverage snapshot/site validation. No document total is allocated to a visit. |
| Adjustment → recorded no-charge decision | Only signed work, explicit outside-contract class, reason, actor, decision timestamp, and no contradictory invoice ID. Missing price/invoice or a legacy class is not a decision. |

`lib/visit-financial-context.ts` separates documentary reference, per-work coverage, recorded decision, and mixed/unresolved summary. The DB reader runs under the existing read-only snapshot helper and performs no schema bootstrap or writes. Document monetary values are internal inputs to the existing canonical document validator only; the new projection has no amounts, receipt status or monetary aggregation.

`lib/reports.ts` loads source contexts only for selected visit rows and labels verification as current, not as-of the historical report end date. The evidence projection uses a repeatable-read snapshot, but the existing report context is loaded beforehand: the entire report is **not** claimed to be one atomic historical snapshot. Existing report admission is unchanged. The clinical GET has the same patient and assistant-day gates as clinical GET, rechecks patient ownership in the snapshot, and applies an explicit output allowlist. Existing `canViewMoney` roles include cashier; that does not grant a new clinical-route admission to cashier/accountant. Existing restricted-role route gates still apply. Nonfinancial roles receive no new source IDs, money or finance links. Signing, callbacks and request semantics are untouched.

## Deliberately unresolved edges

- Approved principals persist `terms.itemIds`, but membership alone is not canonical proof that their current backing source remains valid. They remain documentary/review references here. Future integration should reuse the existing approved source validator in the same snapshot, not compare plan totals or patient balances.
- An installment schedule alone does not identify or validate principal coverage.
- Orthodontic billing classes and billed decision invoice IDs are recorded evidence, not independently verified package coverage. Existing case bridges need the canonical package validator before certification.
- Endodontic episode/case identity does not establish a universal RCT item ID; the crown item is a different work item. Endodontic-only work remains unresolved.
- Historical sites not accepted by the immutable coverage/site validator remain unresolved; no tooth/case/service fallback is added.
- Currency-changing corrections and changed line identities remain unresolved. This reader does not reinterpret procedure amounts in another currency.
- Unsigned drafts, zero prices, waived flags without an explicit decision, narrative-only work, missing/deleted source rows and ambiguous historical records remain unresolved. A legacy class is never treated as free work.
- Receipt allocation/paid status, agreement balances, automatic repair, and account/checkout mutation semantics are outside this layer. Source references do not establish payment.

## Independent review witnesses and repairs

The frozen first source head `f19e4e7a630e9ad38d4ea6d4a820c742e3dd11e8` incorrectly returned verified coverage for a YER visit/exact SAR invoice with equal numeric amounts, for missing visit denomination, and for historical linked procedure quantity 2. These were actual failing PostgreSQL assertions before repair. The corrected cases are unresolved. Valid same-denomination evidence and an explicit SAR plan override on a YER visit remain verified; no pricing, signing, source row or eligibility is rewritten.

Currency-changing correction fixtures retain the required settlement-reclassification document, even with no receipts. They stay unresolved. An isolated temporary-table malformed read snapshot demonstrates the separate correction-metadata gap: equal metadata strings alone accepted an edge whose actual invoice currencies disagreed. The corrected traversal checks both actual invoices. Legacy nullable original-currency metadata follows the existing correction guard's COALESCE semantics, with both actual denominations still checked. No public table or immutable guard is disabled for this witness.

The old selected-visit loop issued **1,005 SELECT round trips for 201 empty visits** in the disposable DB. The shared batch reader now issues **10**, retaining all 201 visits. Batches are at most 200 requested visit IDs, not a row limit. Visit-local procedures, source lines, completed work, adjustments, endodontic records and direct documentary references are batched; item, invoice and historical-document results are cached only inside the same snapshot and keyed by patient/source. **201 visits sharing one agreement use 14 SELECT round trips**, with the same agreement reference on every visit. These are measured query counts, not Production latency measurements. The first follow-up still performed per-distinct-item queries: a new mixed witness (201 distinct items, 101 separate prepaid invoices and 100 separate historical documents) measured **1,017 round trips**, despite the shared-item cache improvement. The completed loader now performs **17 round trips** for that same witness. Item/principal/schedule/legacy facts, exact invoice references and complete canonical historical-document proof inputs are fetched in chunks of at most 200, then individually validated in memory with unchanged canonical predicates. Patient-qualified positive and negative cache entries live only for the current call/snapshot. Additional same-batch foreign-item and wrong-patient document assertions remain unresolved while the legitimate owner retains coverage. Canonical per-item/document validation is still required; these round-trip counts are not a claim of constant database work or Production latency.

## Validation

- Owned PostgreSQL 18.4, Node 22: all seven report suites plus the source suite: 8 files, 103 tests passed. The canonical historical-document suites also passed in the 4-file/65-test source validation run. The isolated #380 fixture composition separately passed all 7 report files/77 tests.
- Focused projection/route, signing and HTTP contracts, and #382 regression checks: 7 files, 203 tests passed.
- Typecheck passed; lint completed with zero errors and 208 repository-wide warnings.
- Final distinct-item bulk-loading full unit suite: 611 files, 10,692 tests passed (301.03 seconds).
- Hosted browser/HTTP assertions added to existing real role-handoff and invoice/clinical-continuity journeys. Existing synthetic ortho browser fixture explicitly handles the new read. #382 retains strict viewport/disclosure assertions. No local Chromium run; hosted proof remains required.

The first full unit run found the missing new GET entry in the exhaustive HTTP matrix (610 other files passed); the route was registered with exactly the existing clinical GET roles and the complete rerun passed. Typecheck caught two test-only optional-row accesses, which were corrected.

Initial added fixture failures were SQL schema/guard mistakes (duplicate source uniqueness, missing correction acknowledgement, plan required columns and int/bigint parameter typing); fixtures were corrected, without disabling any database guard. The historical-document guard also rejected an attempted individual-line void; the final void witness uses the existing standalone agreement void writer without bypassing the guard. A normal existing report loader emits a pg concurrent-query deprecation warning; the new source reader itself awaits each query sequentially.
