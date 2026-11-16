# M2 slice 90b — ordinary receipts and refunds on the canonical runtime (2026-11-05)

Owner decision G4-4 (6648682456): collecting needs `finance.payments.collect`. An action grant never implies a read, and nothing is granted automatically.

## The route

`POST /api/payments` with a canonical session:

| Request | Grant | Notes |
|---|---|---|
| Ordinary receipt (`kind: payment`) | `finance.payments.collect` | Never a refund, never a read. |
| Refund of a receipt (`kind: refund`) | `finance.payments.refund` | The catalogue requires `finance.payments.view` alongside it. Never a new receipt. |

- **Not admitted by:** administrative labels, the view grants (payments, invoices, ledger) and the legacy role checks. The legacy role checks still apply unchanged to legacy sessions.
- **Validation:** the same field validation and messages as legacy (`parseReceiptFields`, shared by both envelopes). Writer refusals map to the same legacy statuses and Arabic messages (`receiptReasonResponse`, shared).
- **Held for slice 90c, refused with 409 on the canonical runtime:**
  - a receipt on an agreement-funded plan (it becomes an instalment with its invoice, or an approved-agreement split): `plan_collection_not_canonical`;
  - the reversed-instalment recovery intent: `recovery_not_canonical`.

  Neither is served by the ordinary writer.

## The writer

`commandCanonicalReceipt` (`lib/canonical-receipt-writes.ts`) runs one admitted operation:
- **Action:** `finance.payments.collect` or `finance.payments.refund`. `finance.payments.refund` is a new runtime action; it adds no new capability.
- **Writer path:** the legacy writer `runPaymentTransaction` runs on the operation's transaction through `recordSettingsOwnedPaymentOn` (receipt) and `recordPaymentOn` (refund).
- **Unchanged from the legacy writer:**
  - lock order: patient, then origin, then shift, then targets;
  - request key and fingerprint;
  - the settings-owned exchange rate (a refund uses the saved rate for the same key, actor and patient, otherwise the configured rate, exactly as the legacy route does);
  - the similar-receipt review;
  - the receipt or refund audit inside the transaction.
- **Replay:** a replay writes `payment.idempotent_replay` in the same transaction. Legacy writes it after commit, best-effort.
- **Rollback:** any writer refusal is raised (`CanonicalReceiptOutcome`), so the whole operation rolls back.

## The scope

The scope is decided inside the writer by the `admit` hook:
- **When:** after the waits for the patient, origin and shift locks, and before any target check, replay or refusal can reveal anything.
- **`own` actor:** needs a positive ownership witness, taken `FOR SHARE NOWAIT` and held until commit. A held witness returns 409 `patient_scope_conflict`.
- **Outside the scope:** reads as missing (404).
- **Early check:** an unlocked look before the writer refuses the stable outside case first, so the plan check or the refunded receipt cannot reveal anything. The authoritative decision stays the after-lock `admit`.

## Tests

| Gate | Result |
|---|---|
| PG `receipt-writes-canonical` | 9/9 |
| Race test failure-first | Without the admission hook, the outside receipt was written (the test failed). Restored, it passes. |
| Legacy PG touching the writer and the route | 25 files, 315/315 |
| Manual-cash suites, each on its own fresh disposable database | 44/44 and 18/18 |
| Route unit tests | 5 files, 92/92 |
| Audits | 10/10 (map: `kind` branches, patient scope, status `existing` until 90c) |
| tsc | Pass |
| lint | 0 errors |

The 9 PG tests cover:
- a receipt, its audit, replay with the replay audit, and a key conflict;
- the protected owner collecting and refunding;
- the grant matrix: collect versus refund versus view grants, label and no grant, with nothing written;
- a refund within the remaining, and an excess that rolls back;
- an agreement-funded plan refused (409);
- no shift: rolled back;
- `own` scope inside versus outside (404);
- a patient that leaves the scope while the writer waits for the shift (404, nothing written);
- revocation.

No Production, no merge, no activation.
