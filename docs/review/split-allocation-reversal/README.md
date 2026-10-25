# Split-allocation reversal coverage (test-only)

- **Base:** #439 head `9881d33c21c4812ae3e18219a8112438d6192a78` (`feat/finance-synthetic-verification-20261023`). It was verified before starting, and this branch only adds files.
- **Not modified:** #429, #438, #439, #440 and #441.
- **Product code changed:** one narrow, approved fix in `982ffcc2` (see «Defect found and fixed»). Everything else is tests and documentation.
- **Data:** synthetic users, patients, plans, services, doctors and shift only.
- **Closes:** the gap «reversing one allocation of a split agreement collection» in #440's matrix (gap 6).

## Fixture (per currency, real writers)

The fixture uses the same **minor-unit** values in every currency (`lib/money.ts` `MINOR_UNITS`: YER 1, SAR 100, USD 100). So the displayed amounts differ:
- SAR and USD: 5,000.00 / 1,800.00 / 3,000.00 / 4,000.00 / 3,200.00 / 800.00, as written below;
- **YER: 500,000 / 180,000 / 300,000 / 400,000 / 320,000 / 80,000.**

1. An approved agreement of 10 × 500.00 = 5,000.00 (minor 500,000). It is approved with an idempotency key, and 1,800.00 (minor 180,000) is collected before the upgrade.
2. A recorded upgrade to 10 × 800.00, via `saveAgreementAmendment`, adds a 3,000.00 (minor 300,000) agreement-delta invoice.
3. One split tender of **4,000.00** (minor 400,000) goes through the real `POST /api/payments` (`planId`). The existing writer splits it into:
   - **original allocation:** 3,200.00 (minor 320,000) on the principal invoice;
   - **delta allocation:** 800.00 (minor 80,000) on the delta invoice.

   Both are recorded in `agreement_delta_collection_receipts`.
4. The plan item carries a 20% collected-cash commission doctor.

The split writer accepts the agreement's **native currency only**. So each currency, YER, SAR and USD, is a separate agreement, not a cross-currency split.

## Scope matrix

Legend: ✅ = covered by `__tests__/postgres/split-allocation-reversal.test.ts`, in each of YER, SAR and USD.

| Operation | UI / door | Original allocation | Delta allocation | Classification |
|---|---|---|---|---|
| Full void | ReceiptCorrection «إبطال» → `POST /api/payments/[id]/correct` `mode=void` | ✅ | ✅ | supported |
| Partial correction to 60% (original target) | ReceiptCorrection «تصحيح» → `mode=correct`, `target=original` | ✅ | ✅ | supported |
| Partial refund of 40% | API only, manager: `POST /api/payments` `kind=refund` | ✅ | ✅ | supported |
| Void both allocations in turn | ReceiptCorrection | ✅ | ✅ | supported; every projection returns to its pre-split value |
| Same-key concurrent refund | API | | ✅ | one 201 and one 200 with the same receipt |
| Two different-key concurrent voids | ReceiptCorrection | ✅ | | one 201 and one 409; exactly one reversal |
| Refund beyond the allocation, though within the split total | API | | ✅ | **unsupported**: explicit 409, zero writes |
| Refund in another currency | API | | ✅ | **unsupported**: 409, zero writes |
| Correction redirected to the plan | ReceiptCorrection | | ✅ | **unsupported**: 409, zero writes |
| Correction into another currency, foreign (SAR/USD) agreement | ReceiptCorrection | ✅ | | **unsupported**: 409, zero writes |
| Second void, or refund after a full void | ReceiptCorrection / API | | ✅ | **unsupported**: 409, zero writes |
| Correction onto the settled sibling (original) invoice | ReceiptCorrection, explicit target | | ✅ | **unsupported**: explicit 400 `invalid` with the guard's reason, zero writes, no audit row (fixed in `982ffcc2`) |

### Per supported case (18 = 2 allocations × 3 operations × 3 currencies)

Each case asserts exact before/after projections read through the product's own readers.

| Projection | Change after the reversal |
|---|---|
| Open-shift drawer, native currency | −X |
| `computeDebtRows` patient due | +X |
| Reversed allocation's invoice remaining (`readInvoiceSettlementPosition`) | +X |
| **Sibling allocation's invoice remaining** | unchanged |
| `approvedAgreementPosition` | paid −X and remaining +X |
| Journal: the split's cash account | −X; reversal entries net to zero |
| Commission, `accrued` | unchanged |
| Commission, `earned` | −percent × X exactly (the doctor's configured collected-cash policy) |

The "void both" case also returns earned to its exact pre-split value.

Rows that are never rewritten:
- every invoice of the patient;
- `plan_installments`;
- `agreement_delta_amendments`, the amendment history;
- the `agreement_delta_collection_receipts` row;
- **both** original allocation receipts, byte-identical;
- the sibling has no reversal row.

Retries:
- **Reversal retry under the same key:** 200 replay, with zero changed tables (whole-database content hash).
- **Same key with a changed payload:** 409 with an Arabic message, zero writes. The changed field is the reason for a void and the amount for a correction or refund.
- **Original split key retried late, after the reversal:** 200 with the **same complete `paymentIds`**, zero writes, drawer unchanged.
- **Original split key with a changed amount:** 409, zero writes.

## Defect found and fixed (approved on #442)

**What happened:**
- Correcting the **delta** allocation with an explicit target equal to the **original** (fully settled) invoice is refused by the approved-source guard `assertApprovedReceiptLimit`, which throws a typed `DebtRepaymentError("invalid", «المبلغ يتجاوز متبقي المصدر أو الحساب.»)`.
- Nothing is written.
- `app/api/payments/[id]/correct/route.ts` mapped **every** exception to a generic **500 «تعذّر تصحيح السند. أعد المحاولة.»**, so the refusal was not explicit and invited a pointless retry.

**Fix** (`982ffcc2`, a separate commit, the only product change on this branch):
- The correction route maps `DebtRepaymentError` exactly as `/api/payments` already does:
  - `unauthorized` ⇒ 403;
  - `invalid` ⇒ 400;
  - other typed codes ⇒ 409;
  - each with the guard's safe Arabic `message` and `code`.
- Unknown exceptions stay a generic 500 with no raw details.
- **Unchanged:** session and role gates, refusal-reason messages, the writer, guards, and rollback and audit behaviour.

**Regression evidence** (`fix-red-before.log`, `browser-red-before.log`):

| Test | On the unfixed route | With the fix |
|---|---|---|
| PostgreSQL, ×3 currencies: `a correction onto the settled sibling invoice is an explicit 400 invalid refusal with zero writes`. Asserts 400, `code: "invalid"`, the exact guard message, zero changed tables, no audit row, unchanged projections | red: «expected 500 to be 400» | green |
| Unit, `__tests__/receipt-correction-route-errors.test.ts`: one case per typed code (403/400/409/409/409) | red, 5 cases | green |
| Same unit file, controls: generic 500 without raw details; unchanged refusal-reason message; unchanged 401/403 gates before the writer | green | green |
| Browser, `__tests__/security-http/split-allocation-correction-ui.test.ts` (built app, real routes, synthetic split created through the app's own endpoints). The ReceiptCorrection form moving the delta receipt onto the sibling invoice must show the explicit reason, not «أعد المحاولة», with nothing written | red: «expected 500 to be 400» | green |
| Same browser file (YER; one minor unit per riyal): a supported partial correction of the 80,000 YER delta receipt to 48,000 YER records exactly one 80,000 reversal and one 48,000 replacement on the delta invoice, nets −32,000 YER in this patient's cash, and leaves the sibling 320,000 receipt unreversed. These are patient-scoped browser snapshots; the whole-table and audit checks are in the PostgreSQL grid. | green | green |

## Audit evidence

Each grid case marks the audit log before the replay and change checks, and asserts:
- **append-only:** every row up to the mark is byte-identical;
- **every addition accounted for:**
  - a **refund** replay adds exactly one `payment.idempotent_replay` row naming that refund, the payments route's documented trace;
  - correction replays, the late split retry and every rejection add none.

Unsupported refusals and the sibling refusal add no audit row.

## Exact commission

The doctor's configured policy is read from `doctor_commission_history`: percent, basis `collected_cash`, lab and material deductions off. A precondition checks that every line of both invoices is this doctor's. Then:
- split: Δearned = percent × 4,000.00;
- accrual = percent × the revised agreement total;
- every reversal: Δearned = −percent × X exactly, and accrual is unchanged.

These replace the earlier bounds.

## Sensitivity

`mutation-sensitivity.log`: a temporary mutation in which a void reverses one minor unit less fails 7 SAR cases. It was reverted.

## Local results (Node 22, PostgreSQL 18.6)

- `split-allocation-reversal`: 30/30. This is 18 grid cases, 3 void-both, 3 concurrency, 3 unsupported and 3 sibling regressions.
- `receipt-correction-route-errors` unit suite: 8/8.
- Neighbouring correction-route PostgreSQL suites pass:
  - `receipt-correction`, `payment-settings-fx-replay`, `refund-base-conservation`, `reclassified-refund-base-budget` and `invoice-correction-item-handoff`: 113 tests;
  - `payment-acknowledgment-evidence`: 44 tests, run with its CI disposable-database setting.
- Built-app browser test `split-allocation-correction-ui`: 2/2.
- `tsc` and `eslint` are clean.

## Remaining gaps (stated separately)

- **Policy observed, not invented:**
  - Correcting a **YER** allocation into a foreign-currency replacement is accepted. Base-currency invoices accept recorded FX, so this is not in the refusal list.
  - A direct keyed invoice receipt on the delta invoice is accepted by the existing guarded writer. That is not a reversal, so it is not covered here.
- **Not covered here:**
  - a split across **more than one** amendment (three or more allocations);
  - a split where the original remainder is zero (delta-only tender);
  - reversal through a re-collection of the voided allocation.
- **Browser scope:** the browser journey covers YER only, and the refusal and partial-correction paths only. The PostgreSQL grid covers all three currencies and all operations.
