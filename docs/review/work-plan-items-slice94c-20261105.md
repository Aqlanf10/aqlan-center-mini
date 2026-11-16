# M2 slice 94c — plan items and consent on the canonical runtime (2026-11-05)

Owner decisions G4-1 and G4-8 (6648682456). The contract is section 11 of the [Group 4 design](financial-group4-contract-design-20261104.md), written before the code.

| Route | Canonical behaviour |
|---|---|
| `POST /api/plans/[id]/items` | `clinical.plans.edit`. A base-currency plan takes the catalogue price. An agreement-currency plan requires an explicit price, decided by the price grants (G4-1): `finance.discounts.apply` within the ceiling with a reason, `finance.discounts.override` beyond it, `finance.price-increases.apply` above the catalogue. `plan.item_add` and `plan.price_override` are audited **in the same transaction**; legacy wrote them after its commit. |
| `PATCH /api/plans/[id]/items` | `clinical.plans.edit`. The session layout only, with the legacy financial-lineage guard and audit. |
| `DELETE /api/plans/[id]/items` | `clinical.plans.edit`. Before consent only, with the legacy guards and audit. |
| `POST /api/plans/[id]/consent` | `clinical.plans.edit`. The consent and its optional schedule run in one admitted operation. The schedule runs under a savepoint: a schedule refusal undoes only the schedule and keeps the consent, with the legacy 409. The count and interval are validated before anything is written; legacy refused a malformed schedule only after committing the consent. |

## Shared writer shape

The five legacy writers became `…On(client, input, admit)` bodies:
- `addPlanItem`
- `updatePlanItem`
- `removePlanItem`
- `recordPlanConsent`
- `schedulePlanInstallments`

One runner (`ownedPlanTransaction`) commits only an `ok` result and rolls back anything else, exactly as each writer did inline. The legacy wrappers keep their signatures and behaviour.

`lockPlan` takes an optional `admit`, run right after the patient and plan row locks:
- an `own` actor needs a positive ownership witness `FOR SHARE NOWAIT`, held until commit;
- a lock conflict is 409;
- outside the scope reads like a missing plan.

An early unlocked look comes first.

## What decides nothing

- Role labels.
- The legacy `canEditPlans` switch.
- View grants.
- The price grants without `clinical.plans.edit`.

## Tests

| Gate | Result |
|---|---|
| PG `plan-items-canonical` | 7/7 |
| Race failure-first | Without the admission in `lockPlan`, the outside add went through (the test failed). Restored, it passes. |
| Legacy and related PG (every suite touching the five writers, plus 94b) | 47 files, 621/621 |
| Related unit (including audit coverage) | 4 files, 63/63 |
| Audits | 10/10 |
| tsc | Pass |
| lint | Clean |

The 7 PG tests cover:
- the catalogue price with the audit in the transaction;
- the agreement-currency price by each grant, refused without one;
- update and delete with the delete-after-consent guard;
- view grants, a price grant alone and the label refused;
- outside equals missing;
- revocation;
- the race;
- consent with its schedule;
- a schedule refusal keeping the consent and undoing only the schedule.

The malformed-schedule refusal is route-level: no command runs, so nothing is written.

No Production, no merge, no activation.
