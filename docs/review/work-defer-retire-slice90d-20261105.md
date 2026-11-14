# M2 slice 90d — payment deferral and collection-attempt proof on the canonical runtime (2026-11-05)

Owner decision G4-4 (6648682456): money decisions need `finance.payments.collect`, inside the patient scope, with the existing writer controls. An action grant never implies a read.

Both acts below are money decisions with no money movement. Neither is admitted by `visits.manage`, a view grant or a label.

| Act | Grant | Effect |
|---|---|---|
| Defer a visit's payment (`PATCH /api/visits/[id]` with `defer`) | `finance.payments.collect` | No receipt and no invoice; the balance stays on the patient. |
| Prove a collection attempt (`POST /api/payments/attempts/retire`) | `finance.payments.collect` | Answers either "committed" (replay the attempt) or "retired" (it can never land). |

## Deferral

- **Writer:** the legacy writer `deferVisitPaymentWith` runs on the operation's transaction.
- **Locks:** the visit row is locked `FOR UPDATE` first.
- **Scope:** decided on the locked row (`admit`), before its signature or deferral state is read:
  - the `all` scope;
  - the visit's own clinician;
  - its patient, through an ownership witness taken `FOR SHARE NOWAIT` and held until commit (a held witness gives 409).
- **Outside the scope:** reads as missing (404).
- **Refusals:** an unsigned visit returns 409, as in legacy.
- **Audit:** `visit.payment_deferred`, with the written reason, in the same transaction. A second deferral answers `already` and writes nothing.

With this, every branch of `PATCH /api/visits/[id]` is canonical.

## Attempt retirement

- **Writer:** the legacy retirement `retireCollectionAttemptOn` runs on the operation's READ COMMITTED transaction.
- **Unchanged from legacy:**
  - the attempt checks;
  - the per-key database lock against an in-flight send of the same key;
  - the rule that only the attempt's owner may retire it (checked against the operation's own identity);
  - the "same proven answer" on repeat;
  - the `payment.attempt_retire` audit.
- **Scope:** the patient is admitted before it is read. Outside the scope gives exactly the same answer as a missing patient (400, same message), so a retirement never reveals another patient.

The legacy wrapper now runs the same function inside its own transaction; its behaviour is unchanged.

## Tests

| Gate | Result |
|---|---|
| PG `defer-retire-canonical` | 6/6 |
| Deferral race test failure-first | Without the admission, the outside deferral was written (the test failed). Restored, it passes. |
| Legacy PG regression for 90c and 90d | 61 files, 794/794 |
| Related unit | 12/12 |
| Audits | 10/10 (map: `PATCH /api/visits/[id]` and the retirement are `canonical-done`) |
| tsc | Pass |
| lint | Clean |

The 6 PG tests cover:
- **Deferral:**
  - with its audited reason;
  - an `already` answer on repeat;
  - an unsigned visit (409);
  - `visits.manage` and view grants refused;
  - an `own` collector, with an outside visit and a missing visit reading alike (404);
  - revocation;
  - the race in which the patient leaves the scope during the visit lock.
- **Retirement:**
  - retired with its audit;
  - a repeated answer;
  - a committed key answering "committed";
  - another actor's attempt (409);
  - view grants refused;
  - outside answering identically to missing;
  - an `own` collector retiring its own patient's attempt.

No Production, no merge, no activation.
