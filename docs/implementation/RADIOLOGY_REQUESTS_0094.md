# Radiology requests — review tranche (0094)

## Scope and operation
- Central settings → مراكز الأشعة: UUID-addressed name/address/active catalog; empty by default, structured editor and existing clinical-settings CAS/permissions.
- Patient file → طلبات الأشعة → فتح طلبات الأشعة: current self-linked active doctor authors an examination, anatomical region and optional recipient instructions. Optional visit must belong to the patient. No diagnosis generation, results entry, billing or external transmission.
- Issue creates one immutable document/command receipt and awaited audit in one transaction. Key advisory lock precedes fresh credential/role/patient authorization; downstream scope locks use NOWAIT. Same actor/key/scope/payload replays the same document, not a new issuance.
- Current-account admin status is not clinical/owner delegation. The separate protected owner-authority work is not activated here.
- Reception has **no default grant**. An authorized administrator may explicitly enable `canPrintRadiologyRequests` under users. It permits only minimal scoped history and saved printing, never clinical authorship/options/edit.
- A6 (105 × 148 mm) print is scoped to this document. Stored clinic/patient/doctor/recipient fields, clinic-zone issue time, no live rename substitution. Ordinary A4 reports are unchanged. Overflow must be verified on real PDFs; no fixed content clipping or shrink-to-fit.

## Recovery / operator instructions
The entry remains inert on unrelated patient tabs: no radiology storage or network access occurs until the user explicitly opens it. Opening restores any retained command reference before issuance becomes possible; changing patient, visit or principal retires the entry scope.

The browser stores only an opaque command key under the actor/patient/visit scope (no request text, names, medical notes, credentials or tokens). In-memory retries retain the exact original payload. Storage failure blocks submission. Reload with a retained key blocks new issuance and offers authoritative recovery/history. A missing receipt is **unknown**, not evidence of rollback. Recovery/replay never auto-prints. The app-controlled print button performs a fresh narrow POST authorization and awaited audit before window.print; errors or retired page scope never print. Browser-native Ctrl+P on content already disclosed cannot be revoked remotely.

A clinician may explicitly choose “بدء طلب مستقل بعد مراجعة السجل” and confirm the warning that the prior request may already exist. This removes only the local reference and clears the draft; it neither deletes a server receipt nor automatically creates/submits a replacement. This is a documented **new-intent reconciliation**, not exactly-once recovery of lost draft contents. There is no server cancellation/terminal-rejection command in this tranche.

## Retention / archive
0094 uses immutable issued rows, patient/visit/doctor RESTRICT references, exact snapshot identity/shape checks and a populated-TRUNCATE guard. Source-patient merge, visit delete/reparent and clinical reset explicitly refuse protected history under existing writer locks. No historical rebind. Dynamic SQL/full archive export must retain rows and migration registry. Native restore/replay tests are required before acceptance.

Runtime and CLI migrate both validate exact source/registry provenance and existing catalog before skipping/adopting anything. Unregistered residue is refused. Migration 0090–0093 bytes are untouched. Schema contract and ownership snapshots must be generated from hosted native PostgreSQL; **no hand-edited generated evidence**.

## Evidence / acceptance gates
HTML print bootstrapping is distinct from the read-only API contract. The existing
root layout already initializes schema through its settings/current-session path.
The radiology HTML page awaits that established `requireSession()` bootstrap before
starting clinical read locks, matching the prescription HTML page. Recovery,
history/options and print-authorization APIs and the read service remain no-DDL;
fresh transactional credential/grant/patient checks are not replaced by bootstrap.

Native run `41356763010`, job `124998375904`, head
`a8d40f1e38778fef034708128ae42f978b81fe0a` passed the two cold-render
characterization cases: actual initializer/read SQL produced the exact lock witness
and native `40P01` under the forced inverted order; initialization completed before
read succeeded with the immutable receipt unchanged. This demonstrates the lock
mechanism, not the deployed Next.js module-cache behavior. The HTML correction must
still turn the isolated first-HTML-request 404 into 200 on its exact new head,
without prewarming/retrying or weakening missing/revoked/scope refusals.

Local focused unit/actual-handler tests cover central CAS/permissions, parser/decoder, fresh authorization, exact replay/collisions, atomic wrapper rollback, lost-response/reload recovery and minimal reception access. Bounded PGlite tests demonstrate SQL-shape compatibility/catalog validation only, not native locking or official restore.

Pending hosted gates:
1. Full typecheck/build, migration/provenance/ownership consistency and source-generated actual-schema artifacts.
2. `__tests__/postgres/radiology-requests.test.ts`: native same-key concurrency, writer-first NOWAIT, issuance-first real writer wait, immutable/reset protections, official SQL/full archive restore + replay.
3. `__tests__/print-visual/radiology-request-a6.test.tsx`: actual page dimensions, short and long Arabic text, continuation identity and PDF text bounds. Do not claim A6 overflow acceptance until this passes.
4. Built-app authenticated HTTP/role and settings/patient workflows against synthetic data, including revoked grant, patient/visit mismatch and direct print URL.
5. Independent final source review, sole-publisher Draft PR/CI. No live settings/grants, deployment or data mutation as part of implementation.

## First hosted review evidence (2026-11-01; not release acceptance)
PR 509 head `2ca7b2e91af0f9fc7e994120df8e0acda19988e2`, checked-out CI merge
`6c477d6050f61ecfe1960ac8a2074229c4fc7919`, exact source tree
`ca1c6d8885fd24a8ad8b7828e52cafa3311279f4`, run `41316009782`, native job
`124876092331`, PostgreSQL version number `180006`:
- 15/16 radiology native cases passed, including official SQL/full-archive restore and replay.
  The reset-race observer failed because its test-only audit blocker exhausted the default
  three-connection application pool together with issuance and reset's backup connection.
  The fixture now uses a separate connection to the verified isolated database; the exact
  reset SQL-lock observation, refusal, no-backup and unchanged receipt assertions remain.
- Source-generated framed candidates were recovered with all chunk/whole-payload, ordered
  migration and generator-source hashes verified against the exact reviewed source tree.
  Current-schema contract SHA-256:
  `26c3247a9ca3193a1840514b2f1c17542e118bf15ca2ef7a0cdaaec7db9956e4`.
  Preflight disclosure SHA-256:
  `05a42c9f2a645e42eb0fe23563c94f8ece169754f7173a5b86316019120a5dcc`.
  The contract adds only `radiology_requests`; existing tables are byte-equivalent as JSON
  objects. Disclosure additions have exact readable source-DDL witnesses for all 19 new
  text hashes; none of the previous allowed hashes is removed. PGlite was used only to
  derive matching text witnesses, not as authority for native candidate bytes or semantics.
- The original short A6 fixture overflowed to two pages; long continuation tests passed.
  The compact/shared-identity correction still requires fresh actual PDF verification.
- Stale migration-tail/count expectations were updated only for 0094. No comparison,
  native lock, PDF bounds, identity or one-page assertion was waived.

A subsequent exact-head full CI run, native reset race, shared-brand A6 PDFs and built-app
HTTP journeys remain mandatory. These first-run findings do not authorize merging or release.
