# Non-orthodontic extraction boundaries and laboratory verification

This is a review map and a laboratory checkpoint, not an implemented 0079 cut or a release candidate. No migration, clinical workflow, permission policy, existing record or historical fingerprint is changed by this document.

## Verified sources and publication

- Laboratory repair: `codex-grouped-lab-followup-20261117`, `32febf7de196c923883af2eddbc8a1abc85ed207`.
- Laboratory repair plus the independently isolated Next 16.4.5 security patch: `codex-lab-next-security-20261117`, `9abbfe0f902fd61599118586b0123c9016da67ce`.
- The upstream laboratory branch advanced during this work from `ba468764adf0c530691585c553207c0bd45b47c0` to `d9119d33a391f9d3816ad8c60c419863f55fd9ed`. The fetched diff changes only `docs/security/staff-cutover/inventory.json`'s source digest. Our independently regenerated digest corresponds to our own changed source; copying the upstream digest would be wrong.
- Separation base remains `c8580ebc4d0c8a3dd255d4919e1cda0bafe1bc23`; integration #541 remains `4e88b6a791d859cc9a066888f54c0eddff91dde7`; 0134 WIP remains `b2580abcb0491f0af6b79a2b9a19c1d2b1dc2ffb`.
- `main` input for the requested comparison: `c6c886121bcc50aa548f64b0b0fbd7b5beb1f324`.

## Keep / separate / exclude

| Slice | Decision and exact source boundary | State here |
| --- | --- | --- |
| Grouped laboratory 0136 | Keep one order and one payable for selected teeth, including both jaws. Keep each tooth's service/price/currency and existing permission boundaries. | Implemented and tested in the published laboratory branches. |
| Laboratory source labels | Reviewed four-file repair `b293486472ffdf70dd2066ad005ed7786df73ca4`. | Included and tested. |
| Existing-screen access safeguards from #539 | Preserve safeguards while separating clinical features. Do not activate the canonical runtime or change grants merely to perform extraction. | Preserved. |
| New follow-up coverage 0079 | Remove new activation and authoring from the eventual candidate; retain immutable historical contracts, records and readers. | **Not cut. Still active in this base.** See the restore dependency below. |
| Finance 0128 | Source sequence starts at `bdb7dba2`, then `0fa4e67b`, `31f2aea7`, `4c58a856`, `33e689ab`, `c04db046`; retain subsequent recovery/retirement fixes. Contract: `docs/finance/EXPENSE_COMMANDS_0128.md` on #541. | Not extracted. |
| Shift opening 0129 | `ac6ca269` plus blind-count correction `40513af4`, subsequent fixtures and `9795e691`. Contract: `docs/finance/SHIFT_OPENING_REVIEWS_0129.md` on #541. | Not extracted. |
| Expense retirement 0133 | `dc341d2c` plus audit repair `e6391fc3`; keep the late-send refusal and exact original-request recovery. Contract: `docs/finance/EXPENSE_REQUEST_RETIREMENTS_0133.md` on #541. | Not extracted. |
| Owner funding account 2108 | `1ac491d0`; this is an accounting treatment, not migration number 2108. | Not extracted. |
| Booking / prescriptions 0090–0093 | Extract from mixed `51cfbf81`: booking request preferences/key/hash, prescribing-doctor identity and snapshot, immutable issuance command and completed receipt binding. | Not extracted. |
| Medication catalogue grant | Extract medication-specific hunks and tests from mixed `6d9610d4`; shared seams include settings routes, canonical settings, catalogue/labels and user-permission UI. | Not extracted; the whole commit must not be imported because it also changes cephalometric writers. |
| Shared laboratory cost 0134 | Keep separate from a ready candidate. Its WIP is not a completed integration proof. | Not integrated. The both-switches-off fallback is still described as an unconfirmed proposal in the published contract and #483 comment 6905003552. |
| Adjustment wires / auxiliaries | Only the owner's accepted expansion, retaining daily steps. Compare A/B below before adopting a UI extraction. | No session workflow change made. |
| Copied workup/navigation/cephalometric redesign | Exclude from this extraction. Existing main functionality and its access controls are a separate concern. | No excluded source imported by the laboratory repair. |

Shared files such as `lib/db.ts`, `components/PatientOrtho.tsx`, reset registries and schema/audit manifests cannot be copied wholesale from #541. In particular, schema lists from that head also contain excluded orthodontic migrations. Regenerate the extracted candidate's manifests from its actual schema and source; do not copy #541 counts or weaken assertions.

## 0079: the additional restore dependency

The published SQL and embedded source are unchanged:

- `migrations/0079_ortho_followup_coverage.sql`: SHA-256 `5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99`.
- `lib/ortho-followup-coverage-schema.ts`: SHA-256 `b4e70b75c3967b2e3dce85e4beecb912f75e2bdf8534713c38e7bde80576f9a9`.

Removing `ensureSchema`'s registration alone does not retire 0079: `loadMigrationFiles` still discovers its SQL and the CLI migrator applies it. Removing its artifact makes a previously applied version unknown to `migrationStatus` and loses checksum verification.

There is a third path: `lib/restore/staging.ts` creates the destination schema from the migration catalogue, then `prepareBackupSql` removes source migration-record INSERTs before data replay. A fresh-install exclusion applied indiscriminately to restore would leave old coverage tables/columns absent and break restoration of their rows and signed proofs. Silently omitting those rows is unacceptable. The eventual cut therefore needs an exact, validated historical-schema restoration path and tests of retained source fingerprints; a flag that merely hides the UI is insufficient.

Authoring surfaces found: `app/api/ortho/[id]/followup-coverage/route.ts`, `lib/canonical-ortho-coverage-command.ts`, `appendFollowupCoverageWith` / `appendFollowupCoverage`, both legacy panels, the account's durable-command recovery panel and the canonical coverage editor. Preserve read authorization and immutable signed-proof readers in `visit-financial-context-db.ts`, visit sign-off/walkout and backup/reset handling. Pending browser commands must not be silently acknowledged or deleted merely because new authoring is removed.

Required proof before claiming this cut complete:

1. Fresh runtime **and CLI** initialization omit 0079 and return the base coverage classification without introducing new daily-session steps.
2. A synthetic database with the exact historical 0079 registry, revisions, refusals and signed proofs survives initialization/migration unchanged. Wrong name/checksum/adoption and hand-installed unregistered footprints fail closed.
3. Both raw SQL replay into a historical-compatible target and full-archive restoration into a new owned target preserve complete historical rows and guards; a fresh archive must not activate 0079 accidentally.
4. Public legacy and canonical authoring paths cannot create a new coverage decision. Historical reads/status remain scoped; unresolved requests are not reissued under a new key.
5. Reset refusal, cancellation, patient reassignment, concurrent commands and restored receipts retain their existing safety assertions. No DROP, data rewrite or migration-registry deletion.

These tests have **not** been implemented or run for a cut. This review leaves the tested laboratory branches unchanged instead of claiming a partial removal is safe.

## Adjustment A/B comparison

The exact source is #541 `4e88b6a7`, not a date-based assumption. Three modules alone do not close the dependency set.

| Boundary | A: extract minimum existing request machinery with 0109 | B: extend main's existing screen |
| --- | --- | --- |
| UI | Extract only the session editor's command/recovery and wire/auxiliary controls; do not copy the whole `PatientOrtho.tsx` (its #541 diff is 1,128 added / 269 removed lines). | Preserve the existing form order and navigation; add optional wire/auxiliary controls in place. No workup navigation required. |
| Command dependencies | `ortho-adjustment-command` directly requires date, interval, idempotency-key, auxiliaries and session-match. `ortho-adjustment-requests` also requires request-hash, patient access and transaction-time session revalidation. Display requires `ortho`, auxiliaries and `OrthoSessionDetails`. | The same input/value distinctions are required. Optional inputs alone do **not** establish replay safety; the backend needs a reviewed receipt mechanism, which may be the minimum 0109 slice. |
| Shared integration seams | `/api/ortho/[id]` POST admission; `recordAdjustment` transaction and result; read projections; schema/runtime registration; reset/restore; screen recovery; session print if expanded fields are printed. | Existing POST/writer/read projections need narrow edits. Keeping the screen does not remove database and authority obligations. |
| Historical meaning | Preserve exact v1 request hashes. Wire removal and auxiliaries enter the hash only when present; do not rewrite omitted-date or old normalized receipts. Recovery equality is not proof of photo ownership. | Preserve existing session rows and wire defaults; make new optional values explicit. Do not silently infer auxiliaries for old rows. |
| Schema | 0109 references existing users/patients/cases/adjustments/visits and stores immutable outcomes. 0132 adds nullable auxiliary columns and an exact check. Its SQL has no dependency on the excluded workup migrations. | 0132's nullable storage can support the existing screen. Whether 0109 is reused for save protection remains a separate reviewed backend choice. |

0132 distinguishes `NULL` (not recorded), `[]` (explicitly none), and a recorded ordered list; `other` requires its bounded name. It is optional documentation, not a treatment recommendation. The 0109 lock sequence includes its reset fence, actor/key advisory lock, patient lock and current authority check before receipt use; extracting a writer without those dependencies would change safety.

For either option, acceptance must cover duplicate save, lost response, exact receipt replay, changed body under the same key, authority revoked before commit/replay, omitted date over midnight, unchanged historical hashes, signed visits, wire keep/remove semantics, auxiliary null/empty/list, and visual confirmation that daily steps are unchanged. Existing source suites include `ortho-adjustment-request-replay`, `ortho-adjustment-legacy-receipt`, `ortho-adjustment-midnight`, `ortho-adjustment-auxiliaries-upgrade`, and `ortho-adjustment-wire-defaults-ui`.

This is a source boundary comparison, **not** an executable A/B prototype or a completed transitive dependency closure through the shared DB/session modules. Neither option has been selected or integrated. The UI-preserving option B is narrower visually, but cannot be called safer until the same save/authority proofs pass.

## Completed verification on laboratory security head 9abbfe0f

Node 22.23.5; final clean dependency/build checks used npm 11.21.1. Only synthetic loopback PostgreSQL 18.6 databases and local Chromium were used.

- Full units: **894 files / 15,114 tests passed**.
- Targeted real PostgreSQL: **54 tests passed**, including mixed-currency refusal, sole-doctor preservation, concurrent identical saves, clinical projection and external-dispatch omission.
- Built-app grouped laboratory journey: **3/3 passed**, repeated against the clean patched build.
- Further backlog/read-state/status-refusal browser suites: **21 passed**. The separate dispatch PDF journey reached its final evidence emitter but failed its required GitHub run-ID assertion in the local environment; it is **not counted as a passing test**. A first launch without CI environment markers failed setup, not product assertions. Hosted execution remains necessary for the complete artifact proof.
- Typecheck, build, audit and immutable preflight-asset checks passed. Full/production npm audit returned zero findings. Scoped lint had zero errors and 12 existing warnings.
- Runtime dependency proofs passed on build `GCiPlicY3orUgijk-49bL`: braces verifier checked 11,236 shipped/provenance files and 373 traces; lint-tooling verifier checked 743 traces and 86 manifests. Their stated artifact/provenance limits remain applicable; this is not an arbitrary opaque-code absence claim.
- Hosted CI [43996863431](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/43996863431), exact head `9abbfe0f`, passed quality/unit/audit/build and synthetic print at this inspection. Full PostgreSQL and both HTTP/browser shards were still running. **No full CI pass is claimed.**

Only source/tests/manifests/review documentation were published. Raw logs, PDFs, screenshots and build artifacts remain local and ignored. No patient or production database was contacted; no merge, PR or deployment occurred. Railway source inspection showed staging and production web services tracking `main`, not these independent branches.
