# M2 slice 94b — plan status, the creation entry and the collection on a plan (2026-11-05)

Owner decisions G4-4 and G4-8 (6648682456). The contract is section 10 of the [Group 4 design](financial-group4-contract-design-20261104.md), written before the code.

| Route | Canonical behaviour |
|---|---|
| `PATCH /api/plans/[id]` (status) | `clinical.plans.edit`. One admitted operation on the legacy writer `setPlanStatusOn`, unchanged: plan row lock, the reason rule for cancelling and reviving, and the audit in the same transaction. The legacy wrapper runs the same function in its own transaction. |
| `POST /api/plans` (creation entry) | `clinical.plans.edit` inside the scope, then the legacy refusal 409 `PLAN_CREATION_ENTRY_REQUIRED`. It runs in an operation that always rolls back, so nothing is written. The audit-coverage pin of this refusal-only handler was re-reviewed and re-pinned with the reason. |
| `POST /api/plans/[id]` (collect) | `finance.payments.collect` (G4-4). The map's former `clinical.plans.edit` is corrected: this route moves money. It uses the slice 90c writers: the approved agreement's collection (a branded canonical actor where the legacy writer revalidated its session), else the next instalment with its invoice. Response bodies and refusals are the legacy route's: the parsing and the instalment reasons are now shared helpers, and the legacy order (key, then plan, then fields) is kept. |

## Scope

- An early unlocked look first. Outside the scope, a plan reads like a missing plan (`الخطة غير موجودة.`) and a patient like a missing patient.
- **Status:** the scope is decided right after the plan row lock and before the status is read or changed. An `own` actor needs an ownership witness `FOR SHARE NOWAIT`, held until commit; a lock conflict is 409. The witness comes before the update because cancelling the plan can itself end the clinician's scope.
- **Collection:** each writer's `admit`, after its own locks (slice 90c).

## What decides nothing

- Role labels.
- View grants.
- `clinical.plans.edit` for a collection.
- `finance.payments.collect` for a status change.

## Tests

| Gate | Result |
|---|---|
| PG `plan-writes-canonical` | 7/7 |
| Status race failure-first | Without the admission, the outside change went through (the test failed). Restored, it passes. |
| Legacy PG (plan status, instalment, agreement, collection, recovery and related suites) | 29 files, 337/337. The first run found one failure: `invoice-explicit-selection` watches the legacy lock statement's exact text, which the first draft had changed. The statement is kept byte for byte now, and the patient is read under the held lock. |
| Related unit | 11 files, 325/325, including the re-pinned audit coverage |
| Audits | 10/10 |
| tsc | Pass |
| lint | Clean |

The 7 PG tests cover:
- **Status:**
  - change with its audit;
  - the reason rule;
  - an unchanged status writes nothing;
  - view grants, the collect grant and the label refused;
  - outside equals missing;
  - revocation;
  - the race in which the patient leaves the scope while the change waits for the plan row.
- **Creation entry:** 409 inside the scope; outside or missing = 404; view grants refused; no row written.
- **Collection:**
  - the instalment with its invoice and audit, replay, inactive plan;
  - the approved agreement's collection;
  - `clinical.plans.edit`, view grants and the label refused;
  - outside = missing;
  - revocation.

No Production, no merge, no activation.
