# Legacy session caller audit — frozen ddab57c, 2026-10-27

Scope: direct `revalidateSessionInTransaction`, supplied-client `findUserByUsername`/`requireSession`, plus debt/template, patient-access and HR authorizer indirection. Source review is not whole-application concurrency acceptance.

## Actual regressions repaired together

All retained their original REPEATABLE READ READ ONLY financial snapshot contract:

- `agreement-amendment-db.ts:118`: `readAgreementAmendment` authorized before BEGIN.
- `invoice-add-service-db.ts:112`: shared reader authorized/read readiness before BEGIN; affects read and preview APIs.
- `invoice-archive-db.ts:106`: shared read/list wrapper authorized before BEGIN.
- `legacy-treatment-document-db.ts:86`: `previewHistoricalDocument` indirectly authorized via `assertDebtSession` before BEGIN.
- `invoice-revision-db.ts`: already repaired; now delegates identical ownership/cleanup to the shared helper to avoid divergent fixes.

Shared `withLegacyStaffReadOnlySnapshot` owns preflight, initialization, one checked-out client, shared session lifecycle fence before BEGIN, exact RR READ ONLY, SELECT-only fresh account/schema validation, domain role policy, financial reads, expiry, commit/rollback, explicit unlock and poisoned-client discard. No arbitrary pool/client fallback or selectable isolation. Domain errors/role policies remain explicit: amendment/revision/add-service admin; archive canViewMoney plus cashier/accountant viewPatientLedger; historical exactly admin/reception (not a broader money-role predicate). Add-service readiness moved inside the authorized snapshot. Mutation functions are unchanged.

Preflight→ensureSchema is still an unfenced initialization gap. Installation needs maintenance quiescence/draining plus the exclusive lifecycle fence; this is not online mixed-authority rollout. A read projection is not mutation admission or an enduring capability. The supplied session must originate from server authentication; only genuine derivations carry private original-signature evidence.

## Checked callers without this before-BEGIN/READ ONLY defect

- `agreement-reconciliation-db`: reader intentionally uses writable RR before authorization, writers ordinary BEGIN. Do not silently change its locking contract.
- `debt-installments-db`, `debt-installment-collection`, `approved-agreements`, legacy treatment/document writers: authorizers within owning BEGIN or documented in-transaction composition. Their other readonly debt position readers do not invoke locked authorization.
- `invoice-template-db`/`invoice-linkage-db`: caller-owned invoice writer transactions; no preview invocation of locked authorizer found.
- `lab-work-intent-db`, `lab-prescription-write`, db lab cost/status updates: in-transaction writers. Lab capability route explicitly BEGIN before revalidation and rolls back.
- `patient-numbering-db`, `patient-responsibility-settings`, initial responsibility writers, `planned-visit-rebooking`, inventory purchase: owning BEGIN/withTransaction before revalidation.
- `ortho-assessment-store` and treatment-strategy store: explicit writable transactions for readers and writers (row locks required), not READ ONLY. Followup coverage command/status writers BEGIN; followup readonly view does not pass its snapshot client to locked authentication.
- HR contracts/attendance/task mutations and temporal/payroll adapters: owning transaction supplies actual client; temporal reads intentionally writable RR for SHARE locks.
- Inventory supplier transport: withTransaction, including writable RR financial reader. Legacy authority/rollout holds are separate and not changed here.
- No-client username lookups own their own transaction. Supplied-client central lookup deliberately remains strict and is never weakened to accommodate a pool.

## Separate concrete HR ownership defect

`hr.ts:getTaskForSession` defaults `runner` to getPool (line665), then passes it to `linkReadableForSession` (686,722). The latter casts general QueryRunner to DbClient (756) before `canAccessPatient`, so a doctor patient-link lookup can attempt transaction-only authentication on a pool and fail closed as unreadable. Root approved a separate caller-ownership repair after this checkpoint; not covered or fixed by the financial helper.

## Evidence scope

New multi-family raw-canonical refusal fixtures and existing actual financial reader suites are queued behind the frozen full-PG run. The shared cleanup remains exercised through the real invoice wrapper by its six failure-injection tests; no unit mock is represented as real authentication evidence. No grants, migration registration or deployment.

## Separate HR ownership repair

`getTaskForSession` and `linkReadableForSession` now accept only an actual DbClient for composition. Standalone calls own one explicit transaction and delegate on that same client; inherited calls neither begin nor commit a nested transaction. No pool is cast to a client, no visibility predicate is widened, and the existing user/patient permission checks retain their held transaction context. New synthetic PG tests cover doctor visibility, revoked visibility redacting labels and historical values, and caller-owned rollback/XID preservation. These tests are pending execution at the initial checkpoint.
