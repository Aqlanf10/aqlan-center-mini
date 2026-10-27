# Explicit routine orthodontic followup coverage

The local return-only composition is based on `7ed9e15b7be5fb010cfff92475b6a790ae7ef24d`. Root approved local migration 0079 registration after the repaired recovery design passed independent review and the 18-suite / 205-test synthetic PostgreSQL gate. Registration and migration-driven archive acceptance passed locally; no live schema or data change is authorized here. See `ORTHO_COVERAGE_REVIEW_WIP_NOT_READY.md` for current evidence and remaining gates.

## Defect and boundary

An ordinary invoice with a verified plan-item/case source does not currently establish that routine orthodontic adjustments are included. The signing classifier only recognizes a linked classic installment/approved-principal plan or verified historical coverage. The earlier classifier called the missing decision `OUTSIDE_CONTRACT`, and the financial-context reader cannot prove an included adjustment's source. This is not evidence of a second charge.

This repair records one explicit, audited, case-specific decision: **routine orthodontic adjustments included** or **explicitly excluded**. The owner selects a verified current invoice source belonging to the exact patient, orthodontic case, clinical case, plan and plan item. No inference from invoice presence/payment, no fabricated old installment plan, no principal/payment edits, and no inclusion of extra services.

## Proposed storage and writer

- Append-only revisions, scoped to one orthodontic case, with version, superseded revision, included/excluded choice, exact source identities, server-computed source fingerprint/snapshot, reason, current actor and timestamp.
- The caller submits the observed head and server source fingerprint. A stale head/source fails with reload, never last-write-wins. A stable command ID supports exact replay, not blind retry after an uncertain response.
- Authenticate the real session, revalidate the account under the writer transaction before domain locks, then lock the patient/case and source witnesses. Current main restricts this financial scope decision to an administrator. The separate owner/capability version must adapt this entry to agreement management plus exact patient/clinical read scope; it must not retain a canonical role bypass.
- Verify the existing canonical plan-item invoice linkage and absence of conflicting/historical sources. Cancellation, correction, changed linkage/terms, foreign ownership or an obsolete head cannot silently grant coverage.
- Revision and audit append commit together. No change to any earlier revision or signed visit snapshot.
- A new signed adjustment can reference the exact included revision used at signing. The reference is immutable and cannot be retrofitted to an already signed visit. Financial-context reads validate this recorded proof rather than borrowing today's head.

## Read and UI behavior

- Existing proved classic/historical coverage remains compatible when there is no explicit new decision.
- Missing or invalid evidence is `REVIEW_REQUIRED`, not a claim that the work is outside the agreement. An explicit exclusion remains `OUTSIDE_CONTRACT`.
- Preview and signing use the same resolver. Signing records the decision actually observed under locks. A change after signing does not rewrite the historical class or proof; current invalidation is separately displayed as needing review.
- The case's financial panel exposes the deliberate source/decision action. Before confirmation it identifies the exact invoice/plan/item and warns that only future routine adjustments are affected. Extras still require their normal explicit billing decisions.
- Checkout and visit financial review recognize a valid signed source proof and do not demand an unrelated no-charge waiver. Existing signed unresolved rows are not repaired automatically.

## Acceptance required

Synthetic tests: exact invoice source include/exclude; invoice-only unknown; wrong patient/case/plan/item; cancelled/corrected/changed source; stale head/source; concurrent editor serialization; revoked actor; audit-failure rollback; replay conflict; immutable old signed snapshot; preview/sign/financial-context/checkout parity; extra-service charges unchanged; UI stale-owner/unmount/uncertain-result handling. Independent review and explicit migration allocation precede any deployment. The user's synthetic Staging fixture may be used only after source/tests are ready and root authorizes acceptance actions. Production data is not to be changed by this task.


## Current acceptance status (2026-10-26)

The original draft evidence is superseded by the composed recovery review and test results in `ORTHO_COVERAGE_REVIEW_WIP_NOT_READY.md`. The current admin/doctor model is unchanged; unfinished unified-owner activation remains off. Existing signed adjustments with no recorded proof are intentionally not backfilled or relabeled as included. No additional adjustment charge does not settle outstanding agreement debt.
