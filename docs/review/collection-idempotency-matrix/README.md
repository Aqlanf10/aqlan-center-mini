# Mandate §6 — collection entry points, idempotency and reversal effects (test-only)

- **Base:** `integration/finance-candidate-20261022` @ `db5e97c04e2d8c0927d26c27024796974dfc2e6a` (#429, frozen; this branch only adds files).
- **Production code changed:** none. Only synthetic PostgreSQL data is used.
- **New test:** `__tests__/postgres/collection-entrypoint-idempotency-matrix.test.ts`, 87 cases, all on PostgreSQL 18.
  - Every case drives the real route handlers. The session gate is the only stub.
- **Oracle:** existing policy only. The writers decide each outcome; the test compares states.
  - The one exception is the partial-reversal commission check. There, a twin patient who simply paid the smaller amount through the same door provides the expected value, and no percentage is written by hand.

## How "nothing written" is proven

`databaseState()` takes a content hash of **every table** in the isolated database:

```sql
count(*) || md5(string_agg(row::text ORDER BY row::text))
```

"No writes" means every table hash is identical, not merely that a row count is unchanged.

One row type is excluded from the hash: the ordinary payments route's documented best-effort `payment.idempotent_replay` audit line. It is checked separately, and every such line must name only the replayed receipt.

## Entry-point matrix

Legend:
- ✅ = new test in this PR.
- ● = existing test (file named).
- n/a = not applicable by the door's design.

### Idempotency per door

| # | Writer | HTTP door | UI entry | Key | Lost-response replay | Changed-payload conflict, no writes | Equal payment, new key: review then independent receipt | YER/SAR/USD | Existing evidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `recordSettingsOwnedPayment` (invoice target) | `POST /api/payments` | CollectPaymentModal: finance, patient ledger, arrival, today visit, summary | required (400) ✅ | ✅ sequential and concurrent | ✅ amount and method | ✅ | ✅ | ● `payments-idempotency`, `payment-concurrency`, `payment-audit-replay-repro`, `payment-settings-fx-replay*`, `similar-collection-advisory`, `collection-idempotency-required-http` |
| 2 | same writer (opening-balance target) | `POST /api/payments` `openingCurrency` | CollectPaymentModal, opening target | required ✅ | ✅ | ✅ | ✅ | ✅ | ● `opening-correction-guard`, `td05-owner-review` |
| 3 | `recordPlanInstallment` | `POST /api/payments` `planId` | CollectPaymentModal plan target | required ✅ | ✅ | ✅ | ✅ (new for this writer) | ✅ | ● `plan-installment-idempotency`, `collection-idempotency-required-http` |
| 4 | `recordPlanInstallment` | `POST /api/plans/[id]` | PatientPlans «تحصيل قسط» | required ✅ | ✅ | ✅ | ✅ (new for this writer) | ✅ | ● `plan-installment-idempotency`, `plan-installment-idempotency-ui` |
| 5 | `collectApprovedAgreement` | `POST /api/payments` `planId` | CollectPaymentModal plan target | required ✅ | ✅ | ✅ | ✅ | ✅ | ● `approved-agreement-principal`, `similar-collection-advisory` |
| 6 | `collectApprovedAgreement` | `POST /api/plans/[id]` | PatientPlans | required ✅ | ✅ | ✅ | ✅ | ✅ | ● same |
| 7 | `collectApprovedAgreement`, split across original and delta invoice | `POST /api/payments` `planId` | CollectPaymentModal after a recorded upgrade | required ✅ | ✅ (all receipt ids) | ✅ | ✅ | ✅ | ● `agreement-delta-amendment` |
| 8 | `collectDebtInstallment` (invoice debt) | `POST /api/patients/[id]/debt-repayments/[arrangementId]/collect` | DebtRepaymentPanel | required ✅ | ✅ | ✅ | ✅ | ✅ | ● `debt-installment-collection`, `debt-installment-sequential`, `similar-collection-advisory` |
| 9 | `collectDebtInstallment` (legacy opening-balance debt) | same | DebtRepaymentPanel | required ✅ | ✅ | ✅ | ✅ | ✅ | ● `debt-installment-collection` |
| 10 | `recordReversedInstallmentRecovery` (re-collection after reversal) | `POST /api/payments` `purpose=reversed-installment-recovery` | **none (API only)** | required ✅ | ✅ | ✅ | ✅ (new for this writer) | ✅ | ● `reversed-installment-recovery`, `reversed-installment-recovery-routes` |
| 11 | `correctPayment` void / correct | `POST /api/payments/[id]/correct` | ReceiptCorrection (sends a key) | **optional** | ✅ with key; keyless retry → 409 «already reversed», no writes ✅ | ✅ | n/a (internal reversal) | ✅ | ● `receipt-correction`, `payment-acknowledgment-evidence` |
| 12 | `recordPayment` refund | `POST /api/payments` `kind=refund` (manager) | **none (API only)** | required | ✅ | ✅ | n/a (refunds are never reviewed) | ✅ | ● `payment-concurrency`, `refund-base-conservation`, `refund-idempotency-precedence` |
| 13 | `recordPatientPaymentAction` → `recordPayment` | `POST /api/ai/confirmation` (assistant) | AI chat confirmation | **none** | ✗ see Gap 1 | ✗ | ✗ | not tested | none against a real DB (CI runs the assistant in demo mode) |

### Reversal effects per origin

For each origin receipt, ✅ on every reversal kind and in each currency: full void (ReceiptCorrection «إبطال»), partial correction (ReceiptCorrection «تصحيح»), and partial refund (API).

Each case checks:
- **Payments:** the original row stays byte-identical, and exactly one reversal is linked to it.
- **Cash:** the cash drawer falls by exactly the reversed amount X, and the patient's debt rises by X in the receipt's own currency.
- **Books:** the cash-side account moves by −X, and the reversal entries net to zero.
- **Documents:** invoices and installment schedules are never rewritten.
- **Projections:**
  - plan paid falls by X;
  - agreement remaining rises by X;
  - a debt schedule goes to review;
  - accrued commission is unchanged;
  - earned commission returns to its pre-collection value on a void, and matches the twin patient on a partial reversal.
- **Retries:**
  - a reversal retry replays it;
  - a changed reversal under the same key writes nothing;
  - the original collection's lost reply, arriving after the reversal, replays the original receipt and never re-collects.
- **Collecting again after a full void, under a new key (existing policy):**
  - invoice, opening and agreement receipts: accepted, and every projection returns to the collected state;
  - installment receipt: refused with `issued_installment_recovery_required` (recovery is door 10);
  - debt schedule: refused until the schedule is revised.

| Origin receipt | Commission exercised | Plan / agreement / debt projections |
|---|---|---|
| invoice receipt | ✅ (30% collected-cash doctor) | — |
| opening-balance receipt | n/a: an old balance has no performing doctor | — |
| installment receipt | ✅ | plan paid ✅ |
| approved agreement receipt | ✅ | plan paid ✅, agreement remaining ✅ |
| debt schedule receipt | ✅ | schedule review ✅ |

## Sensitivity (the tests can fail)

See `mutation-sensitivity.log`. Each mutation was temporary and reverted:

| Temporary change to product code | Result |
|---|---|
| `/api/plans/[id]` drops the key | 3/3 currencies fail: the retry is not a replay |
| A void reverses one minor unit less | 6 reversal cases fail |

## Honest gaps

1. **Assistant payment tool (`record_patient_payment`) — a genuine gap, reproduced and NOT fixed.**
   - **Reproduction:** `assistant-payment-tool-repro.json`, a local synthetic run of the real `executeAiTool` with signed confirmation tokens.
   - **What happens:** a retry of the same confirmation is refused (no duplicate). However, the user gets an error rather than their receipt, and a second confirmation of an identical payment records a **second identical receipt**. That receipt has no `idempotency_key` and goes through no similar-receipt review.
   - **Why CI never catches it:** CI's placeholder `DATABASE_URL` puts the assistant in demo mode, so no hosted run reaches the database.
   - **Proposed narrow fix (needs an owner decision, since it touches an AI feature):**
     - derive the key from the signed token (`ai-confirm:<jti>`) so a lost reply replays;
     - make the tool refuse when similar receipts exist and point the user to the payment screen, or carry the reviewed receipt ids in the signed preview.
     - No change was made in this test-only slice.
2. **Correction door key is optional.** There are no duplicate effects: the original is locked, and a keyless retry is refused as already reversed with no writes, as tested. The UI always sends a key (`lib/money-attempt.ts`).
3. **Doors 10 and 12 have no UI.** They are reachable by API only, by design today.
4. **Lost response is simulated as "committed, reply discarded".** An unknown COMMIT outcome is covered only for ordinary receipts (● `payment-audit-replay-repro`).
5. **Not re-tested here (existing coverage):**
   - cashier `collectPayments` restriction;
   - shift closed between attempts;
   - distinct-key over-collection races;
   - retired keys (0068);
   - backup and restore of keys.
6. **Reversing one allocation of a split agreement collection** is not in the reversal grid. Similarity after a split refund is covered by ● `agreement-delta-amendment`.
7. **`voidLegacyTreatment` is not a collection writer.** It writes no payments. Legacy balances are collected through doors 2 and 9.
8. **No new hosted browser journey.** The existing UI journeys remain: `payment-idempotency-ui-journey`, `plan-installment-idempotency-ui`, `similar-collection-warning-browser`, `debt-repayment-workspace-ui`.
