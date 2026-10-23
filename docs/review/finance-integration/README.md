# Finance integration — slice 1 (Claude, finance owner)

Draft for Dot's independent review. Not merged, not deployed. Base: `main` 2667b71f.
Synthetic data only; no production connection, secrets, backups or credentials touched.
Production deployment remains paused (Railway incident) and is out of scope.

## Inventory of PRs #367–#397 (verified against git, 2026-10-22)

| PR | State | Relation to main | Decision in this slice |
|---|---|---|---|
| #367, #369, #370, #375, #377, #381, #384, #387 | merged | in main | — |
| #371, #372, #373, #374, #376, #378, #379, #382, #385 | open drafts | stacked on 4b4e12db; their content reached main through #384 (only 2–4 files differ per branch, from later main changes) | not re-applied; residual review left to their authors |
| #368 | open | security audit docs | out of finance scope |
| #380, #383, #386 | open | visit financial sources; #383 31 ahead / 25 behind main, conflicts | **next slice** (careful port, #380 monthly fixture only) |
| #388 | open | ⊂ #389 | composed via #389 |
| #389 | open | includes #388 and #394 (Vitest 4.1.12) | **composed** |
| #390 | open | agreement delta amendment, 0066 | **composed + repaired** (below) |
| #391 | open | test-only browser acceptance for #389 | not composed yet |
| #392 / #397 | open | six-direction unpaid currency candidate; activation blocked | later slice; not activated |
| #393 | open | similar-collection warning | **composed + reworked** (below) |
| #394 | open | Vitest mocker advisory | composed via #389 |
| #395 | open | schema index owning constraints | **composed** |
| #396 | open | handoff docs and unapplied patches | read; patches not applied |

## Execution matrix (this slice)

| Requirement | Existing code | Proven defect | Files | Fix | Acceptance test |
|---|---|---|---|---|---|
| Dated treatment-agreement change after payments (#390) | 0066 + amendment writer + split collection | On #390's own head, 0066 refused every `TRUNCATE`: **189 PG tests in 20 files failed** and the **factory reset failed for every clinic** (`cannot truncate a table referenced in a foreign key constraint`). Migration checklist steps 5–7 skipped (schema contract, disclosure, registry lists). | `migrations/0066…sql`, `lib/agreement-delta-schema.ts`, `lib/clinic-reset.ts`, `lib/db.ts`, `app/api/settings/reset/route.ts`, `schema/*.json`, PG tests | Empty-table-only TRUNCATE (same rule as 0065); reset refuses with `ProtectedAgreementHistoryError` (409, Arabic) before backup when history exists; contract and disclosure regenerated with the repo generators; lists pinned to 0066 | `agreement-delta-amendment.test.ts` (reset/TRUNCATE protection; owner examples 500,000→800,000 and 19×50,000→80,000), `clinic-reset`, `schema-ownership`, `schema-fingerprint`, full PG suite |
| Audit coverage for every write verb | `lib/audit-coverage.ts` | `PUT /api/plans/[id]/agreement-amendment` (read-only status lookup) failed the coverage test on #390 itself | `lib/audit-coverage.ts` | Documented exemption with reason | `__tests__/audit-coverage.test.ts` |
| Similar-collection advisory (#393) | Route-level precheck, optional body field, preview route | P1 same-key retry → 409 → client cleared a committed attempt; P1 distinct keys both recorded unwarned (**reproduced: 201/201 on #393**); optional protocol; recovery path skipped; money-guard failure | `lib/similar-collection.ts`, all collection writers, 3 routes, `lib/money-attempt.ts`, `components/useDurableMoneyAttempt.ts`, `MoneyAttemptNotice`, `CollectPaymentModal`, `PatientPlans`, `DebtRepaymentPanel`, `MoneyCommandRecovery` | Check runs inside each writer transaction under the open-shift lock, after exact-key replay and after every refusal, immediately before the first insert; header protocol (`x-collection-similarity-review`), mandatory at every HTTP collection entry point; 409 carries the receipts; client keeps the key, confirm resends the same request, cancel retires only when proven; refund SUM grouped per receipt and currency (guard unchanged) | `postgres/similar-collection-advisory.test.ts` (9, incl. deterministic races), `similar-collection-review.test.ts`, built-app HTTP/browser suites |

## Advisory review contract

- Same patient, same native amount and currency, last 24 hours; fully refunded receipts drop out, partial refunds stay; split agreement collections match by tender total.
- Asked only when a write would otherwise happen (open shift, all validations passed). A 409 proves nothing was written.
- Confirming sends the exact receipt IDs reported; a changed set is asked again. Same key always replays.
- Not a block and not a permission: no manager, no reason, no automatic cancellation, reversal or deduplication.
- Refunds, receipt corrections and internal callers are not advisory-reviewed.

## Not in this slice (open)

- Visit financial sources (#380/#383/#386), ortho/ceph financial linkage, all-specialty linkage, legacy-balance tools, six-direction currency (#392/#397), statements/PDF, archive/delete permissions, lab/supplier/inventory cycle.
- #391 browser acceptance not composed.
- No production verification is possible while deployment is paused.
