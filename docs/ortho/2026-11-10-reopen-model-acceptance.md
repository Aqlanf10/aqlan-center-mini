# Reopening, readable model results and clinic workflow checkpoint

Branch: `feat/ortho-reconcile-20261109`. This is a bounded implementation and acceptance record, not approval of the whole orthodontic unit. Only synthetic records were used. No merge or deployment occurred.

## Implemented changes

- Migration0125 introduces a lifecycle version and immutable reopening journal. Reopening requires an explicit target and reason, current clinician access, exact patient/case/bridge scope and a matching lifecycle version. Retrying the same command returns its original receipt alongside a separate current-state read. An old receipt cannot reopen a subsequently closed case. Prior closure metadata is retained exactly; phase, treatment records, generic clinical-case storage and financial balances are preserved.
- The clinician panel supports explicit review and recovery after a committed response is lost. The parent authority refresh is retained. Expansion is held in the existing scoped workspace draft, with a fresh server read after remount; a historical receipt is never presented as current state. This does not promise persistence of an uncommitted draft across browser reloads.
- Model-analysis slides show readable saved measurements, units, formula meaning, applicability and unapproved clinical status. Exact technical evidence remains in bounded, source-bound PowerPoint notes. No stored result is recalculated by the renderer. Old queued renderer versions require a fresh request; existing completed exports remain readable.
- Facial measurement guidance is collapsible while the primary instruction and unsaved-state warnings remain visible. The archive download link has a separate, correctly sized row beneath its timestamp.

Migration0125 SHA-256: `6d9eb902c4c834f6d8b6be381c57b46a3a0e2992cdc40a05d688234bb9e3b8a3`.

## Evidence and discovered regressions

The earlier remote checkpoint223c has a **failed** hosted run: [42748478290](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/42748478290). Print succeeded; quality had18103 passing and6 failing tests; PostgreSQL had4749 passing,7 failing,4 skipped plus an HR backup setup failure; HTTP was skipped. Migration-ledger expectations and additive trigger expectations require explicit updates and later proof. These are not silently treated as passing CI. Later explicit trigger/appointment fixture corrections passed10/10 PostgreSQL tests; HR/ownership/debt/legacy fixtures already include0124/0125 in the assembled head.

Later local evidence on Node22/PostgreSQL18:

-144 focused model/facial/archive tests passed;44 migration/docs checks passed.
-41 distinct PostgreSQL checks passed across the initial run and one corrected visible-text extraction assertion. The extraction preserves clinical text while ignoring only whitespace and Unicode direction-isolation controls; exact stored evidence is compared independently.
- Built head8ff52de2 passed production build and TypeScript. Its actual HTTP/browser batch passed19 of22 tests: facial measurement2, archive5, daily-visit continuity and patient cockpit passed. Reopening API checks passed, but both browser reopening cases lost the expanded panel after parent refresh. The390px prescription card also exceeded its established viewport boundary.
- Commitb359a5de preserves panel expansion across refresh and omits that panel from the compact prescription workspace. The remount regression failed before the fix and13 component tests passed afterward. The subsequent production build onb359a5de passed, and root reran13/13 component tests. The built-browser rerun passed13/15 including both prescription viewports, but still failed both reopen remount cases. Synthetic failure diagnostics showed the panel stayed open with no fresh GET after recovery: the child layout effect preceded parent view-lease activation. Commit1c3dc85b makes that admission transition trigger the read, preserving all dynamic authorization guards; its ordering regression failed before and13 component tests passed after. The rebuilt93880fe2 application then passed15/15 actual HTTP/browser checks in4 files: reopening including lost-response recovery at390/1280px, both prescription viewports, daily visit continuity and patient cockpit. The generic closed bridge fixture also remains byte-equal. The mobile recovery screenshot was inspected; current closure and historical receipt are displayed separately.
- The frozen759f4bdc full unit run passed18166 tests, failed3 and skipped11, with one additional suite setup failure. Three assertions still expected raw model evidence inside visible cells after evidence moved to notes; the preflight suite rejected a dependency path. The three model assertions were reproduced and updated to check readable values plus exact source-bound notes:25/25 passed. The preflight failure was traced to dependency symlinks outside the frozen worktree;12/12 passed at the same759f4bdc SHA with physically local dependencies and unchanged security policy. The assembledf322c048 root rerun passed37/37 across all four affected files. This does not turn the earlier full run into an all-passing run.

The daily-visit test creates the assessment/problem/strategy sources through actual HTTP, explicitly starts treatment, then saves the session through the390px browser. A lost committed response is retried with the same body/key and produces one adjustment linked to one existing visit. It checks unchanged sources and no automatic invoices. It does not claim every initial field was entered through the browser, nor a new explicit strategy-revision foreign key on the visit.

## Independent source comparison

The private reference repository `Aqlanf10/aqlan-dental` was inspected at9c375fbee53e23e00ab62cfabcf4bc91aaa60321. Its complete tree and README contain no software license declaration; no code was copied or executed. Its task-readiness summary and presentation branding provide ideas for incremental improvements. MINI already has13-step canonical navigation and calibrated two-study comparison; the reference is not evidence that those baseline capabilities are absent or clinically validated.

## Outstanding acceptance

Full final-head CI, complete52-scenario acceptance, full print/PDF parity, versioned authorized presentation branding, a second Office viewer, remaining retention/laboratory and collection/checkout integration remain outstanding. Unsupported analysis methods stay unavailable until their protocols are verified. The unrelated-cloudb2d1d771 patch is still unavailable and has not been applied. Existing worktrees and backups remain intact.
