# FIN-INT legacy balances: corrections never invent credit or orphan receipts

Base: `5206ada2` (Draft PR #408). No migration, no schema change, no backfill. No real patient data was read.

## Finding (reproduced on a disposable PostgreSQL 18 database before any change)

The manual legacy-balance correction (`POST`/`DELETE /api/opening-balances`) did not consider receipts already collected against the balance:

| Step | Result on the unchanged base |
|---|---|
| Opening 100,000 YER, 60,000 collected against it | Remaining 40,000 |
| Admin corrects the opening to 40,000 | Accepted. The account silently became a 20,000 credit; no refund document exists for it. |
| Admin deletes the opening | Accepted. The 60,000 receipt still targets `opening_currency = YER`, a balance that no longer exists. |

The historical-document flow already refused the first case ("المتبقي المصحّح لا يغطي التحصيل المثبت"). The manual route did not.

## Change

- `setPatientOpeningBalance` (correction path, not reception's add-only path) and `clearPatientOpeningBalance` take the writer's own locks first. These are the patient `FOR NO KEY UPDATE` and the opening row `FOR UPDATE`. Then they apply one rule:
  - **below_settled**: the corrected principal must cover the net receipts settled against the balance. Refunds are netted with the historical receipt base amounts, using `settlePaymentMinor`.
  - **receipts_reference_opening**: a balance that any receipt references is not deleted, even when payment and refund net to zero. A net-zero balance is not pristine. The admin corrects the amount instead.
- Refusals return 409 with an Arabic `message` and a `code`, and write no history or audit.
- **Dry run.** `GET /api/opening-balances?preview=1&patientId=&currency=&amount=` (or `&clear=1`) applies the same rule from a `REPEATABLE READ READ ONLY` snapshot and writes nothing. It is limited to admin/accountant, like the list. The patient ledger's correction form shows: current principal, settled receipts and count, remaining now → after, and the refusal before saving. The save rechecks under its lock.

## Tests

- `__tests__/postgres/opening-correction-guard.test.ts` covers:
  - below-settled refusal with an unchanged row and history;
  - the exact-settled boundary;
  - refund netting;
  - net-zero deletion refusal;
  - pristine deletion;
  - the unchanged reception add path.
- `opening-balance-mutation-concurrency.test.ts`: a payment that commits while a deletion waits on the opening row now makes the deletion refuse, instead of orphaning the receipt. The lock-ordering assertion is unchanged.
- `legacy-treatment-two-level-void.test.ts`: the "missing opening with collections" historical fixture is built with SQL. The writer now refuses to create that state; old data may still contain it.
- Route unit tests cover the 409 mapping, dry-run validation, roles, and no error leak. The reader unit test covers the allowlist and fail-closed behaviour.

## Not connected / remaining

- Lowering a balance that has an active debt-repayment schedule is still allowed when it covers receipts. The schedule's due-now is bounded by the remaining principal, but the schedule is not revised automatically.
- No automatic refund document is created for a real over-collection. The admin must record an explicit refund.
