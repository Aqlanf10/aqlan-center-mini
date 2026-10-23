# Split-allocation reversal coverage (test-only)

- **Base:** #439 head `9881d33c21c4812ae3e18219a8112438d6192a78` (`feat/finance-synthetic-verification-20261023`). It was verified before starting, and this branch only adds files.
- **Not modified:** #429, #438, #439, #440 and #441.
- **Product code changed:** none.
- **Data:** synthetic users, patients, plans, services, doctors and shift only.
- **Closes:** the gap «reversing one allocation of a split agreement collection» in #440's matrix (gap 6).

## Fixture (per currency, real writers)

1. An approved agreement of 10 × 500.00 = 5,000.00. It is approved with an idempotency key, and 1,800.00 is collected before the upgrade.
2. A recorded upgrade to 10 × 800.00, via `saveAgreementAmendment`, adds a 3,000.00 agreement-delta invoice.
3. One split tender of **4,000.00** goes through the real `POST /api/payments` (`planId`). The existing writer splits it into:
   - **original allocation:** 3,200.00 on the principal invoice;
   - **delta allocation:** 800.00 on the delta invoice.

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
| Correction onto the settled sibling (original) invoice | ReceiptCorrection, explicit target | | ✅ | refused, zero writes ✅; **but a generic 500** (see "Defect") |

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
| Commission, `earned` | ≤ after-split and ≥ pre-split |

The "void both" case pins commission exactly: earned returns to its pre-split value.

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

## Defect found (reported, not fixed)

**What happens:**
- Correcting the **delta** allocation with an explicit target equal to the **original** (fully settled) invoice is refused by the approved-source guard `assertApprovedReceiptLimit`, «المبلغ يتجاوز متبقي المصدر أو الحساب».
- Nothing is written; this is asserted.
- However, `app/api/payments/[id]/correct/route.ts` catches every error as **500 «تعذّر تصحيح السند. أعد المحاولة.»**.
  - The refusal is therefore not explicit.
  - The text invites a pointless retry.
- The payments route already maps the same `DebtRepaymentError` to an explicit response.

**Reproducer:** the `it.fails` case `KNOWN DEFECT (reproducer)` in the new file. It is kept green in CI only because it is *expected* to fail. Once the route is fixed it will start passing, `it.fails` will report it, and it must then become a plain `it`.

**Evidence:** `defect-reproducer.log`.
- As a plain test on `9881d33c` it is red: «expected 500 to be 409».
- With the proposed one-branch fix applied temporarily, it goes green (6/6), and the zero-write case still passes.
- The fix was then reverted. This branch carries **no product change**.

**Proposed narrow fix (needs a go-ahead):** in the correction route's catch, map `DebtRepaymentError` exactly as the payments route already does:
- `unauthorized` ⇒ 403;
- otherwise ⇒ 409 with `error.message`.

There is no change to guards, arithmetic or the writer.

## Sensitivity

`mutation-sensitivity.log`: a temporary mutation in which a void reverses one minor unit less fails 7 SAR cases. It was reverted.

## Local results (Node 22, PostgreSQL 18.6)

- New file: 30 passed, plus 3 expected-fail reproducers (one per currency), in about 31 s.
- Together with `agreement-delta-amendment`: 49 passed, plus 3 expected-fail.
- `tsc` and `eslint` are clean.

## Remaining gaps (stated separately)

- **Policy observed, not invented:**
  - Correcting a **YER** allocation into a foreign-currency replacement is accepted. Base-currency invoices accept recorded FX, so this is not in the refusal list.
  - A direct keyed invoice receipt on the delta invoice is accepted by the existing guarded writer. That is not a reversal, so it is not covered here.
- **Commission is bounded, not exact, per partial reversal.** The engine's per-allocation split of earned commission is not re-derived here; it is pinned exactly only by the void-both case.
- **Not covered here:**
  - a split across **more than one** amendment (three or more allocations);
  - a split where the original remainder is zero (delta-only tender);
  - reversal through a re-collection of the voided allocation.
- **No browser journey:** ReceiptCorrection on a split allocation has no browser journey.
