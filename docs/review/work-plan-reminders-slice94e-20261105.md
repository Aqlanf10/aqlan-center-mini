# M2 slice 94e — instalment reminders on the canonical runtime (2026-11-05)

Owner decision G4-8 (6648682456). The contract is section 14 of the [Group 4 design](financial-group4-contract-design-20261104.md), written before the code. The route is `POST /api/plans/reminders`. It records that the clinic reminded a patient of a due instalment, for one plan (optionally one instalment) or for up to 500 plans. It stamps `last_reminder_at` and writes the `plan.installment_reminder` audit. It sends nothing and changes no money.

## Grant and scope

| | Legacy | Canonical |
|---|---|---|
| Admission | the money labels and the doctor label | `appointments.create` (the map's grant) |
| Records | every plan | the plans of the actor's patient scope |

The finance grants, the plan edit grant and the label are refused.

## The writer

The writer is unchanged: the plan row locks in id order, the instalment lock, and the timestamps and audit in one transaction. It is split into `recordPlanInstallmentRemindersOn(client, input, admit)`. The legacy function keeps its transaction and its lock text.

After the plan row locks, each plan's patient is read and the scope decided:
- `all` admits every plan;
- `own` needs a positive ownership witness `FOR SHARE NOWAIT`; a lock conflict refuses the whole request with 409 and writes nothing.

A plan outside the scope is skipped and not counted, exactly like a missing one. For a single plan this gives the legacy 404 "the plan or the instalment does not exist".

## Tests

| Gate | Result |
|---|---|
| PG `plan-reminders-canonical` | 3/3 |
| Failure-first | Without the scope admission, the scope test and the race test failed. Restored, they pass. |
| Legacy PG `reconciled-reminders` and the five plan canonical suites (94a to 94d-2) | 7 files, 38/38 |
| Audits | 10/10 |
| tsc | Pass |
| lint | No errors (the 8 warnings in `lib/db.ts` were there before) |
| HTTP journeys (`reconciled-reminders-http`, `audit-coverage-http`) | In the batch gate on the built head |

The 3 PG tests cover:
- a single plan, a single instalment, a missing instalment (not counted) and the bulk form with a missing id, with the timestamps and audits by the actor;
- the finance grants, the plan edit grant and the label refused; the `own` doctor gets 0 for an outside plan, the same as for a missing one, and in the bulk form only its own patient's plan is stamped and counted; revocation;
- a race in which the patient leaves the doctor's scope while the reminder waits for the plan row: nothing is stamped or audited.

## Note

Single-plan refusals on the canonical path keep the legacy 404 for missing or outside plans. The bulk form, as in legacy, never says which ids were skipped.
