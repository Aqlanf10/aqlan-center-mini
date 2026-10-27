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

New multi-family raw-canonical refusal fixtures and existing actual financial reader suites passed. The shared cleanup remains exercised through the real invoice wrapper by its six failure-injection tests; no unit mock is represented as real authentication evidence. No grants, migration registration or deployment.

## Separate HR ownership repair

`getTaskForSession` and `linkReadableForSession` now accept only an actual DbClient for composition. Standalone calls own one explicit transaction and delegate on that same client; inherited calls neither begin nor commit a nested transaction. No pool is cast to a client, no visibility predicate is widened, and the existing user/patient permission checks retain their held transaction context. New synthetic PG tests cover doctor visibility, revoked visibility redacting labels and historical values, and caller-owned rollback/XID preservation. These three real PostgreSQL tests passed alongside the existing HR visibility/replay suites.


## Terminal verification — source checkpoint e6550a2b69684c29b85b8c47dad3eb6e199efdfc

- Financial reader families and shared boundary: 141 PostgreSQL tests across six suites passed.
- HR ownership/existing task behavior and reviewed inventory-maintenance refusal fixture: 50 PostgreSQL tests across four suites passed.
- Amended clinical witness, plan summary parity and patient-statement composition: 25 PostgreSQL tests across three suites passed.
- Focused lifetime/cleanup/session units: 30 passed.
- Full unit suite: 780 files / 13,124 tests passed, exit 0.
- Full TypeScript: passed using the established Node22 4096MB heap configuration. The first default-2048MB attempt exhausted its heap (exit134), retained as infrastructure evidence, not a source diagnostic or pass.
- Focused lint and diff checks passed; independent source review cleared both financial and HR slices.

Evidence under `recovery-evidence-20261027`: `financial-readonly-shared-pg.log`, `hr-task-reader-owned-pg.log`, `financial-readonly-composition-pg.log`, `financial-hr-readonly-unit.log`, `financial-hr-readonly-full-types-4096.log`, `financial-hr-readonly-lint.log`, `e655-full-unit.log`.

These results do not resolve the separate canonical inventory supplier adapter/restore-provenance acceptance blocker. They do not authorize schema activation, real grants or Production deployment.
