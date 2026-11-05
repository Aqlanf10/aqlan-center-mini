# M2 slice 90c — plan collections and instalment recovery on the canonical runtime (2026-11-05)

Owner decision G4-4 (6648682456): collecting needs `finance.payments.collect`, inside the patient scope, with the existing writer controls.

With this slice, `POST /api/payments` is canonical for every request kind. Slice 90b covered the ordinary receipt and the refund; this slice adds the rest:

| Request | Canonical writer | Legacy writer and controls kept |
|---|---|---|
| Receipt on a plan with an approved agreement | `collectApprovedAgreementOn` | The agreement writer with its key and fingerprint, group replay, patient fence, account and shift locks, source checks, the split across amendment invoices, the similar-receipt review and `plan.approved_collection` audits. |
| Receipt on a classic instalment plan | `recordPlanInstallmentOn` | The next instalment with its own invoice and attribution lines, the replay before and after the shift lock, the recovery and financial-history refusals, and the `payment.create` audit. |
| Reversed-instalment recovery (`purpose`) | `recordReversedInstallmentRecoveryOn` | The recovery writer with its replay checks, origin, shift, opening-table, invoice and plan locks, the shared receipt writer and the `payment.recover_installment` audit. |

How the canonical path follows legacy:
- **Routing:** the two plan receipts are told apart exactly as the legacy route does (BILL-1), using the plan read on the operation's own transaction.
- **Exchange rate:** taken as the legacy route takes it — the saved rate on the same key for the same actor, patient and currency, otherwise the configured rate.
- **Refusal messages:** both envelopes share the same maps (`recoveryReasonResponse`, `installmentReasonResponse`, `receiptReasonResponse`).

## The actor

The approved-agreement writer revalidated a legacy session twice: before the writes and after the receipts. On the canonical runtime it receives the branded actor from slice 91 (`canonicalDebtActor`). That actor re-proves the live operation and the `finance.payments.collect` grant on the same transaction client at both points. JSON cannot forge it.

The approved-agreement writer's validation, fingerprint (including `session: { id, username }`) and body are unchanged. The legacy wrapper now runs the same `On` function in its own transaction, then hydrates the receipts after commit as before.

## The scope

Each writer decides the scope through an `admit` hook placed after its own waits and before its replay under the locks and every refusal:

| Writer | Hook runs after |
|---|---|
| Instalment | The shift lock |
| Approved agreement | The patient fence and the account/shift locks. The hook also checks that the agreement's patient is the request's patient (409 if not). |
| Recovery | Every lock |

Rules that apply to all three:
- An `own` actor needs a positive ownership witness, taken `FOR SHARE NOWAIT` and held until commit.
- An early unlocked look refuses the stable outside case before anything is read.
- Outside the scope reads as missing (404).
- Any refusal rolls back the whole operation.

## A pinned journey updated (disclosed)

The journey `canonical-shifts-journey` (slice 26) pinned `GET /api/payments` as refused for every canonical session. That was true when it was written. Since slice 90a, the route is a reviewed canonical read (`finance.payments.view` inside the patient scope, under G4-4).

The assertion now checks the reviewed contract and is stricter than the old one for this route:

| Account | Expected |
|---|---|
| Reader without the grant | 403 |
| `own` | 200 with only its patient's receipt |
| Protected owner | 200 with all receipts |

Every response must be `no-store`. The other legacy print, export and report paths keep their refusal pin unchanged.

## Tests

| Gate | Result |
|---|---|
| PG `plan-collections-canonical` | 8/8 |
| PG `receipt-writes-canonical` | 8/8 (the "held" test moved here as real coverage) |
| Instalment race test failure-first | Without its admission hook, the outside instalment and invoice were written (the test failed). Restored, it passes. |
| Related unit | 8 files, 133/133 |
| Audits | 10/10 (map: `POST /api/payments` `canonical-done`) |
| tsc | Pass |
| lint | Clean |
| Legacy PG regression | Recorded in the commit |

The 8 tests in `plan-collections-canonical` cover:

- **Instalment:**
  - an invoice and audit by the canonical actor, and replay;
  - an inactive plan refused;
  - view and refund grants refused;
  - an outside patient (404);
  - revocation;
  - the race in which the patient leaves the scope during the shift wait.
- **Approved agreement:**
  - the collection with its audit and position, and replay;
  - view and outside refused;
  - an excess refused with nothing written.
- **Recovery:**
  - on the original invoice with its audit, and replay;
  - an excess refused;
  - view and outside refused.

No Production, no merge, no activation.
