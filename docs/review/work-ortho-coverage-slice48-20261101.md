# Slice 48 — scoped saved followup coverage read

Base `327b12fba84049e2b0f5e4e65fbd48445da42386`. Only GET `/api/ortho/[id]/followup-coverage` is converted. The original POST/PUT, durable command receipts, source-locking writer, sign-time coverage rules, immutable signed proof and financial calculations are byte-preserved. This is not a coverage editor or completion of the orthodontic module.

## Acceptance matrix

| Requirement | Result and witness |
|---|---|
| Independent current authority | Registered read requires existing `finance.agreements.manage` and patient scope. Its catalogue prerequisite remains `finance.patient-ledger.view`; no grant is added. Own/all/owner pass; none, unlinked clinician and adjacent grants refuse regardless of legacy role. |
| Same patient and privacy | Exact positive case/patient IDs, no duplicate or extra query aliases. Missing, foreign and mismatched references have one 404 response. Only saved decision/reason/version/author/date, availability and current applicability are projected. Invoice source references and service names separately require `finance.invoices.view`. No raw commercial snapshot/fingerprint, source plan/case/tooth fields, totals, command receipts or editing choices. |
| Existing source meaning | Original commercial SQL, site validity and fingerprint logic are shared unchanged. A legacy comparison witness proves identical source choices and applicability. Invoice total, cancellation, plan owner, site and conflicting lineage changes invalidate applicability without rewriting the saved decision. Payment and treatment progress retain their original non-invalidating behavior. |
| Coherent read | Existing shared identity fence precedes one RR READ ONLY lease. Activation, scope, current head and commercial sources use that connection. Independent source and scope writers leave the admitted snapshot coherent and affect the next read. Proven fence waiting rechecks revocation. No initializer, pool-level reads, audit or persisted changes. |
| Bounded failure | At most 256 candidates and 2 MiB of source material cross from PostgreSQL; candidate 257 or an oversized record refuses the whole context. The saved head has a 16 KiB SQL envelope and field validation. Disabled activation is an explicit unavailable state, not an exclusion or silent empty accepted decision. Historical-owner mismatch refuses safely; no immutable record is rewritten or inferred through an unproved merge. |
| Current UI | Separate read-only on-demand pane, existing RTL identity, 390px checked. Clinical visibility does not grant the pane: the independent agreement grant is also required. Finance-only API readers do not gain clinical access; a new finance-only navigation screen is not introduced here. |
| Revocation and stale responses | Refresh, hide, failed/malformed response and revocation clear old content. Closed-request completions are ignored. No mutation or source-selection request comes from this pane. |

The existing patient timeline remains governed by its already accepted ledger grant. Since the agreement grant requires that ledger grant, its invoice event reference can still appear elsewhere in the patient page. This slice restricts the independent coverage-source projection and does not claim that all invoice references are globally absent. The inspected screenshot includes that existing timeline behavior; no service detail is obtained from it.

## Actual local evidence

- PostgreSQL 18.6: **34/34 in four files**, including 25 new canonical cases and the unchanged coverage concurrency/migration/restore suites.
- Built HTTP/Chromium: **35/35 in four files**, including 10 new journeys and existing native detail/strategy/followup regressions. Build `krjMdegCPffqpvKRweu6l`.
- Unit/projection and map/inventory guards: **32/32 in three files** (22 projection/query cases and 10 unchanged guards).
- Production build, standalone typecheck and raw-body guard pass. Full lint passes with zero errors and the existing 345 warnings.
- **21 source-preservation checks and 591 pinned historical source hashes**. No migration, writer, receipt or signed-proof changes.
- Before implementation the authenticated canonical read failed 401 despite its agreement grant and own scope. The old built GET was unchanged through the frozen 47 source.

Intermediate failed attempts are retained: a test-created history initially lacked its required actual source snapshot; the fixture now captures that actual query result without bypassing any trigger. A fixture accidentally assigned the outside case to the reader and violated the one-open-case constraint; historical completed cases without false responsibility now represent the intended independent episodes. A payment witness initially named a nonexistent invoice column; it now inserts an actual synthetic payment in a closed synthetic shift. The first typecheck caught the envelope's correct `handle` property and two test typings. The first expanded HTTP suite passed 34 and failed one because its audit snapshot preceded login; taking the snapshot after login preserves the complete no-change assertion. These are recorded harness corrections, not product defect claims or weakened constraints.

[Manifest, raw logs and synthetic screenshot](evidence/work-ortho-coverage-20261101/manifest.json). Full unit/PostgreSQL and runtime provenance are running at this source checkpoint. Exact-head CI and independent review of this slice are pending. Published 43–47 CI is a separate head. Actual WORK Docker proof remains blocked by the prior enforced Alpine destination refusal. No deployment, live configuration, real data or new migration occurred.

## Full-suite finding and isolated correction

The first full-unit run on `b93bf771` was **not accepted**: 14,438 passed, five failed, and the report-envelope file failed at import before its 11 cases could collect. Extracting the shared SQL as a module-level template accessed coverage-specific DB exports during an unrelated report import. A separate correction restores call-time template expansion exactly as in the original helper; the SQL bytes and all three original affected test files remain unchanged. The original report-envelope, signer/session and new projection files pass **52/52**, and the complete focused coverage/legacy PostgreSQL group passes **34/34** after the correction. No mock export or assertion was added to conceal it.

The five signer/session failures had a distinct invocation cause: the local full-unit command omitted the synthetic SESSION_SECRET. It is explicitly provided for reruns; no application secret or guard changed. [Original failure, correction and source proof](evidence/work-ortho-coverage-import-fix-20261101/manifest.json). Full acceptance awaits complete later gates with this correction. The initial build/HTTP evidence remains tied to the earlier source, never silently claimed for changed bundles.

The frozen b93 PostgreSQL run subsequently completed **5193/5193 in 400 files, zero skipped**. Both provenance guards, preflight, environment and money scanner also passed for build `krjMdegCPffqpvKRweu6l`. These are historical evidence before the isolated lazy-import correction, not substitute final gates for later slices. The corrected full unit suite on frozen b49 passed 14470/14470 in 857 files with the synthetic secret explicitly supplied; its raw log is in the slice 49 manifest.
