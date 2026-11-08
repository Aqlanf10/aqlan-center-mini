# Contract integration validation

This report records bounded source-integration results relative to public base `0af83b43d1cf6e6306302b760184d1c8fb473d05`. Results below were obtained during integration or on individual patches, not a fresh validation of the final published tree. This is not a release or clinical certification.

## Implemented contracts

- Original migration 0090–0093 SQL and checksums, runtime/CLI validators, and generated current schema union. Only booking metadata, saved prescriber fields, and the issuance-command table differ in the regenerated contract; newer ortho tables remain. Historical booking lineage does not enable booking or AI application features.
- Issued-prescription history guards alongside current ortho guards for visit relinking/deletion, source-patient merge, and clinic reset. Current visit deletion identity/authority checks remain.
- Durable prescription command issuance/replay/recovery, current transactional session and patient authority, locked safety evaluation, canonical medication provenance and saved prescriber. Final expiry is checked after awaited prescription/audit/receipt writes, before commit; expiry rolls back all three. Other-doctor canonical-owner issuance remains unavailable, not inferred from admin role.
- Medication catalogue validation and audited, session-revalidated settings writes; command-aware editor/recovery, saved history, minimal reception print picker, and explicit reception print permission controls.
- Saved-only prescription printing, stored clinic/clinician identity, clinic-zone dates, pagination, fail-closed prescription print logging, and shared physical-paper watermark preview. Financial print fallback remains.
- Observed-version ortho plan-link CAS, locked authority, strict current own-patient permissions, explicit reconciliation and restored linking UI. This protocol is not a durable idempotency receipt: unknown outcomes require a fresh read and explicit review.
- SQL/full-archive restore migration provenance validated before connecting. Historical snapshots retain data while the target owns the current compatible registry. Unknown versions and incompatible checksums fail closed.
- Reviewed ceph loupe, pending-decision ownership and CI fixture repairs are included. No historical external-AI or automatic clinical writer was restored. Penicillin-allergy guidance no longer claims an automatically safe named-drug/dose alternative.

## Selected validation results

Counts overlap and are not a summed coverage total.

- Combined prescription regression run: 449 passing tests across 34 passing suites. Its separately added restore-loader suite initially lacked its implementation; after restoration, both restore provenance suites passed 33 tests.
- Durable issuance transaction suite: 18 passing tests, including expiry during awaited prescription, audit and receipt writes. Real local HTTP duplicate issuance and invalid JSON admission: 6 passing tests.
- Medication/provenance/catalogue: 185 passing tests across 10 suites; medication caution: 6 passing tests.
- Client restoration: 251 passing tests across 17 suites, followed by 59 passing tests in two strengthened identity suites. Users-page controls: 48 passing tests.
- Prescription print: 124 passing tests across 10 suites. Shared A4 restoration: 27 passing tests, with expanded watermark coverage preserving all 29 current routes.
- Ortho plan-link: 140 passing unit/UI tests and 8 passing real synthetic PostgreSQL tests.
- Real synthetic PostgreSQL 18.6: 18 schema-lineage/current-visit-authority tests; 17 issuance/history-lock/catalogue tests; 6 saved-history and historical SQL/full-archive restore tests. Tests observed actual lock waits and rollback, rather than mocking the relevant writers.
- Schema ownership: 121 unit tests; PostgreSQL characterization completed with zero unexpected differences, zero known differences, and 16 existing open convergence findings. Application schema equality remains false, as reported by the gate.
- Focused transitive runtime TypeScript check passed during integration. Client and users-page focused checks passed. Changed-file lint and whitespace checks passed with disclosed existing warnings.

## Limits and remaining gates

- Full aggregate TypeScript attempt was OS-killed with exit 137 at a 2304 MiB heap limit, without diagnostics. It is not a pass. Exact final-head aggregate type/build/CI gates remain required.
- Fourteen A4 browser/PDF cases were attempted but Chromium could not launch because socket creation was denied. No screenshot/PDF acceptance or real-browser reconciliation success is claimed.
- The source comparison narrowed the original 113 changed-runtime-file review but did not fully certify the large ortho/ceph engines, tracing/comparison/grid/print surfaces, all corresponding DB transactions, shared patient/visit pages, or all newly introduced features/schema.
- CAS tests are substantive but not a claim that every possible permission/expiry/lock/concurrent-command interleaving was exercised.
- Runtime migration batches validate separately; startup fails closed but is not guaranteed to perform zero earlier migration writes before discovering a later drift. The inherited issuance validator is not arbitrary privileged-catalog-tamper protection.
- No full build was attempted because available disk space was insufficient.

## Toolchain and panel validation

The integrated toolchain preserves production dependency entries and ortho CI checks while restoring lint/runtime/provenance gates. Its isolated clean install, 338 focused tests, production dependency graph and dependency audits passed. This is not built-artifact verification.

An initial panel validation reported 151 passing tests across eight suites and static review without a blocker. Its synthetic hook harness does not establish ReactDOM, StrictMode or browser behavior. Returning-query callback identity (Tasks A→B→A) and initial Contracts time refresh required subsequent repairs.

Before those repairs, a strict ESLint scan of 33 previously failing files completed serially and found 161 errors across 31 files, with no incomplete files or rule suppression. ContractsPanel and useLeadershipRead had zero errors in that scan. The initial combined scan was resource-killed; the serial scan superseded it. This is a historical inventory, not a final-head count.

The focused runtime configuration includes six panel components and four changed test files. That expansion has not been counted as another typecheck pass.

## Subsequent strict-hooks repairs

Ten reviewed repair patches were integrated without conflicts. Whitespace validation passed across the repair range. No combined-checkpoint lint, test or typecheck pass is established by the following individual-patch results:

- Panel follow-ups: reported 154 passing tests across eight suites; strict lint had zero errors and 12 warnings. Repairs address returning-query callbacks and delayed initial clock refresh.
- Shared UI: review found no introduced blocker; reported 168 focused passing tests and eight runtime files linted with zero errors and seven warnings.
- Patient rendering: bounded changes passed review; reported nine runtime files with zero lint errors, 431 passing tests across 12 suites and 194 across five suites. Two suites overlap, so these counts must not be summed.
- Ortho/Ceph: review found no introduced blocker across eight runtime files and four test files; reported 499 passing tests across ten suites. Earlier strict lint was clean, but final minor changes and new tests still require a final scan.

The historical 161-error inventory requires a fresh final-head scan. No final-head zero-error result is claimed. Additional patient-shell changes were not included because their review was incomplete.

## Remaining limitations and operational scope

Diagnosis and lab unknown-POST handling releases its latch. Referrals principal scoping relies on parent remount. Lab overview query keys omit user ID. Existing retention-removal callback and draft-epoch gaps remain unchanged. The synthetic hooks harness is not ReactDOM, StrictMode or browser evidence.

All database validation described here used synthetic local databases. The report establishes no live-database, backup, Production-setting or deployment verification. Full aggregate types, build, exact-head CI, remaining review, and browser/PDF gates remain pending. A production release requires verified backup readiness and deployment-target isolation in addition to those gates.


## CI repair and preserved follow-up checkpoint

This checkpoint includes the later reviewed PostgreSQL fixture/provenance, schema disclosure, strict test-contract, and adjustment UI publication repairs. It preserves the saved receipt while refusing publication through a retired React form setter. Migration SQL and production authorization contracts remain unchanged.

Hosted CI for the preceding checkpoint `51cfbf8114408e759b394bd808c279a8ac135620` exhausted the default approximately 2 GiB V8 heap during full TypeScript checking before production build. The Typecheck step now requests 4096 MiB and checks measured runner/cgroup capacity and availability before compilation. Full TypeScript coverage, strict compiler options, and mandatory build remain intact. The capacity/environment regression group passed 89 tests. Actual hosted TypeScript and build success remain required.

The synthetic print suite previously passed 35 of 37 cases; two obsolete prescription fixtures attempted unsupported draft/query-authored clinical data. The repaired test requires a saved Rx snapshot, rejects 12 unsafe query forms, and verifies historical metadata cannot override the saved record. Thirteen non-browser cases passed; the five PDF cases retain A5/native-page, field, geometry, and directionality assertions and require hosted browser execution. No production prescription route was loosened.

Focused PostgreSQL repair groups, exact migration lineage and disclosure checks, and the relevant UI regression suites passed. Preflight passed all 12 cases, including the negative dependency-symlink escape witness, with production allowlists unchanged. The complete unit suite is being rerun against this source checkpoint. The preceding full run had 94 failures and 11 skipped tests; targeted repairs are not a replacement for the aggregate result. Local full TypeScript remained resource-blocked, and hosted TypeScript, PostgreSQL, full unit, lint, audit, build, preflight, HTTP and browser gates must pass on the final remote head before deployment. No Staging or Production deployment is performed by this checkpoint.
