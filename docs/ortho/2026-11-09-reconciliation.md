# Orthodontic reconciliation checkpoint — 2026-11-09 / 10

This is a development checkpoint, not clinical acceptance or permission to deploy.

## Pinned baseline and preserved work

- main: `c6c886121bcc50aa548f64b0b0fbd7b5beb1f324`.
- PR530 / `review/ortho-ceph-current-source-20261107`: `f2a968da504751af24cc84d69b703602edcdcc72`. Chosen baseline for the independent `feat/ortho-reconcile-20261109` branch.
- PR529 / `fix/ceph-canvas-loupe-20261105`: `94ecd293f428bb690144fa7ff38020aae86a462b`.
- PR506 / `feat/work-recovery-followup-20261027`: `8586f991d95b6456e2b58574a33add3418b93702`.
- Previous Ortho branch: `accb6b5679fcf4c53270bb072a16a66f8eb4612e`.

PR530 imports source snapshots; missing Git ancestry does not mean a feature is missing. PR529's substantive native viewport, subpixel placement, queue ownership and geometry protections are present and extended in530. No whole-branch merge was performed. PR506's broad canonical financial/authority cutover was not imported.

The previous cloud worktree has twelve uncommitted phase21 source files. Its tracked binary patch, untracked source archive and per-file SHA256 manifest were preserved outside this branch; the original worktree was left unchanged. The offline Windows integration tree is not available here. The later reported separate-cloud commit `b2d1d771049b716f2e2e1858b15fac4ad541140c` and patch (expected SHA256 `84e987f0b9fd62e0bc582edbdeb333deba0026c705692b11a922505635587abe`) are also absent from this environment. They were neither inspected nor applied. Future integration must compare their actual contents with this checkpoint.

## Requirement/evidence matrix

“Present in source” is not a claim of end-to-end acceptance.

| Requirement | Baseline evidence/status | This checkpoint / remaining verification |
|---|---|---|
| Single case intake and explicit treatment start | Existing `ortho-assessment-intake` command/store and migration0108; parent assessment owners | Preserve existing command identity; guided browser tests on390px/1280px prove one intake and one saved assessment under a committed response lost to the client and identical retry |
| Ordered clinical journey and resumption | Diagnostic focus links exist; previous thirteen-step workup absent | Restore an optional case/patient-scoped workup over the existing owners, preserving query context and guarding pending writes |
| Draft protection across steps | Assessment/study owners already persistent; diagnosis/ceph/record drafts local | Keep diagnostics mounted after first use within the same authority lifetime; register live child operations with navigation and departure guards |
| Problem list to saved case presentation | Problem review records exist in0117; no study `problem_review` source | Add source inventory/capture/current-access checks, immutable review facts, picker and saved review explanation; no migration or duplicate problem writer |
| Facial/image analysis | Existing facial revisions0115 and submissions0116 | Baseline facial units129/129 passed; separate uncommitted integration's reported four failures not reproducible from this evidence alone |
| Ceph definitions/completion | Existing core, versioned completion0113/0114 and source witness checks | Retain quarantine of unverified `EXT_INDEX`; no clinical algorithm or reference changed here; comprehensive clinical acceptance remains outstanding |
| Cast/space/IPR | Existing model assessment, space ledger0119/submissions0120 and immutable `space_ledger` study capture | Preserve530 replacement; do not add old parallel `space_plan`/`space_ipr` capture or duplicate executed IPR totals |
| Treatment/visits/financial linking | Existing strategy, sessions and main financial references | No new financial engine, debt, invoice or clinical action from navigation; broader acceptance still required |
| Retention | Device/event ledger0121/submissions0122 present | Prior explicit documented lifecycle transition absent; separate additive-schema slice remains, not old0101 migration copy |
| Records upload recovery | Generic private document upload present | Specialized old recoverable upload-command ledger absent; current ambiguous upload error/re-read policy unchanged |
| Study export/archive | Existing saved study, image recipe, text/illustrated export and longitudinal eligibility | Preserve current export contracts; final archive/full-layout/export-authority phase21 requires further reconciliation |
| Previous saved-content compatibility | Strict530 source enum differs from older branch | `problem_review` restored; historical `space_plan`/`space_ipr` compatibility and actual installed migration history require explicit investigation before any deployment |

## Migration decision

No migration is added or replaced in this checkpoint. Old0100–0107 must not be pasted over530: their tables were redesigned under0108/0111/0115/0117/0119/0121 and additional submission/provenance migrations. Deployment history and staging schema compatibility are not established by a source comparison.

## CI evidence before changes

- PR530 run42431330492: quality/build, PostgreSQL18 and print passed; HTTP/browser failed. Artifact13600505316 download is blocked by this environment's network policy; the precise hosted failure remains unverified until its index or equivalent full reproduction is available.
- PR529 main CI41972376485 failed: a diagnostic script was collected as an empty Vitest suite, and the old ceph verifier expected a value for quarantined `EXT_INDEX`. Current530 has fixes for both. The successful529 payroll/ceph diagnostic workflows are not a successful full CI.
- PR506 latest CI42407639303 passed. Earlier42130794719 failed an unrelated Havana DST expense fixture; current506 fixes its date. No finance code was imported for this.
- Previous Ortho accb6b56 CI41774087988 failed HTTP, despite other gates passing. Earlier local results do not certify this new composition.

## Validation record

Synthetic data only; PostgreSQL18.6 runs use a newly created loopback-only container. Existing database containers, real patient records and reference-presentation images were not used or changed. Evidence logs are retained outside the repository in the task environment; no patient presentation or runtime database is committed.

| Check | Executed result and limit |
|---|---|
| Baseline530 facial units | 129/129 passed in9 files. Does not certify unavailable Windows/other-cloud composition. |
| Baseline530 targeted built HTTP/browser | 20/22 passed; both prescription viewport scenarios failed. Measured bounds reproduced the defect locally; the inaccessible hosted failure index is still not inferred from this. |
| New study source and surrounding units | 640/640 passed in54 files. |
| PostgreSQL18 study/capture/submission integration | 33/33 passed in3 files, including4 new problem-review tests: immutable capture, current authorization/source revocation, case isolation and invalid hashes. |
| Full unit invocation before final harness repairs | 17,732/17,909 passed; 177 failed in4 of1005 files. 176 failures were bespoke parent React mocks missing the new hook/provider; one was an exact source-delta contract. This full invocation was not repeated locally after repairs. |
| Focused repairs of all4 failing files | Parent/navigation suites191/191 and diagnosis contract/panel66/66 passed. The diagnosis contract still pins the original SHA256; only the exact read-only observer addition is reversed. One visibility assertion now accepts both native visible representations (omitted or false hidden); it still rejects hidden content. No failing tests were removed. |
| Child draft lifetime/registry regression | 206/206 passed in6 files; real React development StrictMode/Chromium registry test also passed. |
| Built HTTP/browser composition | The41 distinct selected scenarios passed across targeted reruns, not one fresh41-test run on the final composition. Initial failures led to layout/focus fixes and precise accessible-role locators. Final combined guide + original prescription cases passed4/4 on390px/1280px against build `ugdUpNDmDe1rNsfQNaWfs`. |
| Guided application journey | First intake, interview draft across sections/pillars, save with lost response, blocked navigation/hash while uncertain, identical retry without duplicate revision, all13 destinations, retained local diagnosis draft, reload/bookmark and no extra clinical/financial writes. This is a defined subset of O01/O04/O05, not full clinical acceptance. |
| Prescription viewport | Original unchanged390px/1280px assertions pass after moving read-only billing context into the existing financial disclosure, placing the guide entry inline, and making space/legacy context accessible disclosures. No clipping or assertion relaxation. |
| Build and TypeScript | Next production build succeeds; full `tsc --noEmit --incremental false` succeeds. |
| Changed-file ESLint | 0 errors,21 warnings. Warnings remain; this is not a warning-free claim or a full repository lint invocation. |
| Visual review | Synthetic mobile workup and active/legacy prescription screenshots inspected for RTL, readable controls and bounds. No full clinical export/layout visual acceptance claimed. |
| Diff hygiene | `git diff --check` passes. No dependency, schema or migration change. |

The [52-scenario matrix](acceptance-matrix.md) is an explicitly timestamped source audit, with companion file hashes. Its individual full acceptance scenarios remain unverified; limited test groups above must not be converted into a completion percentage. The private43-slide reference and lecture files are not included in this branch.

## Independent review

A separate agent reviewed the final product diff, patient/authority teardown, live child operation registry, pending/hash guards, immutable problem-review capture and transitive source access. No new actionable defect was found. Earlier draft-loss/pending-navigation findings were fixed and covered by the focused tests above. This was source review, not independent clinical acceptance.

## Outstanding acceptance

This checkpoint does not complete all clinical flows, archive/export authority, retention transitions, migration-history reconciliation, all52 original acceptance scenarios, full hosted CI, or staging isolation/backup/restore proof. No main merge, PR creation retry, staging deployment or production deployment has been performed.
