# Assessment privacy, legacy history and reception journey — 2026-11-10

2026-11-10 UTC. Branch `feat/ortho-reconcile-20261109`. Product/source checkpoint `a2efe399a257bf9e003ba8fa5637f205ab21a933`; the subsequent `ec1663da` changes only two browser-test selectors. Evidence is bounded to the exact executions below; the whole unit is not accepted for deployment.

Only synthetic records were used by the cited executions. No reference-patient content or images are reproduced here. No main merge, staging/production deployment, or new financial engine is part of this checkpoint.

## Result and scope

Assessment clinical content now requires the current clinical reader role at its direct route/store and copied assessment-source paths. Reception retains the tested account, appointment and workflow access but cannot use a general export grant to obtain an assessment embedded in a saved study. This is a bounded confidentiality correction, not certification of every clinical projection.

Legacy baseline duration fields now start blank and require explicitly entered integer months. Blank or whitespace cannot silently become zero/today, and Arabic/Persian digits are accepted as explicit numeric input. For legacy cases without any recorded adjustment, the follow-up board and print disclose unknown review history instead of calculating a due date or lapse interval from treatment start. Real booking/no-show evidence and actual recorded adjustment chronology remain distinct and usable.

One actual reception journey now composes arrival, deferred payment, physician signature, canonical collection, exact visit checkout and repeat-request protection. It proves the supported same-currency historical-opening path; it does not implement SAR-target conversion or other financial policy.

## Source and build identities

| Checkpoint | Meaning |
|---|---|
| `c8340975a68e259118d13766b456cd4054fc1f45` | Last confirmed remote head; hosted results belong to this older head. |
| `741e7fc55b3ef7032a842c77c71e14a46d8446cc` | Earlier frozen full-unit result: 18,252 passed in 1,032 files. Actual HTTP20 and PG10 evidence belongs to that earlier checkpoint, not the later privacy/legacy changes. Product build was d1fe9b9a; 741 added only the approved-crop acceptance test. |
| `cfd1c5e3` / `b2cc9f25de1b81d93a43496b24cfa00277fd8e1b` | Integrated assessment privacy implementation / privacy acceptance checkpoint. Production build with full TypeScript passed on b2cc. Later530/b7ca/e74 changes in its combined proof were test-only. |
| `350e7515` + `8ae21f52` + `91dd650a` | Explicit legacy month entry, Arabic/Persian numeral support and unknown-review-history board/print behavior. No migration. |
| `a2efe399a257bf9e003ba8fa5637f205ab21a933` | Frozen assembled source with legacy browser test; production build including full TypeScript passed. Frozen full-unit run completed: 18,307/18,307 tests in 1,033 files, no skipped or failed tests, exit0 in784.25s. |
| `199ef710c0f90014925a53e2c2225cf99a08b636` | Test-only correction, integrated as `ec1663da`: selects the legacy wire input by accessible label because a datalist input is not the expected textbox role. Targeted two-viewport browser rerun passed against the unchanged a2 build. It changes no product code. |
| `1bb6a1274bff7b0275f2731898aa6847e0ce95b3` | Separate staged generic problem-label read-projection fix. Not integrated, built or tested through real HTTP as part of a2. |

## Reproduced defects and bounded changes

### Assessment privacy

The earlier policy expressly allowed reception to read complete current/historical assessment revisions while denying writes. That did not satisfy the requested confidentiality boundary. Copied assessment information could also be read through saved-study capture sources and current/historical problem-source snapshots. This was a policy mismatch, not evidence that a role registry had been bypassed.

Synthetic before-controls exposed two direct-store, one copied-study and two problem-source failures; route/UI assertions also failed. The integrated change requires current admin/doctor clinical roles before those reads, preserves patient/source/image authority, and stops mounting the assessment read lifetime for other roles. A historical copied snapshot is not made readable merely because its current source disappears. Studies without assessment sources retain their existing independent export behavior.

Relevant paths: assessment route/registry and canonical assessment store; `lib/ortho-case-study-source-union.ts`; prepared source admission; current/historical problem-source readers; assessment UI read lifetime and `components/PatientOrtho.tsx`. Further implementation detail is in the source commits and tests linked by this checkpoint.

### Legacy entry and review history (O02 containment)

The old browser showed default elapsed6/remaining12; blank input became numeric0 before submission. The new explicit input validation preserves legitimate entered0 but rejects empty, fractional, exponent and hexadecimal forms. Both elapsed and remaining values must be deliberately entered; no default course duration is inferred.

Previously an active legacy case without recorded adjustments used `startDate` as its latest-care date, generating due/lapsed buckets. The server now projects persisted baseline origin, and the classifier returns `legacy_adjustment_history_unknown` with null due date and null elapsed care age in that situation. Screen and print state the uncertainty. Actual appointment timing and no-show evidence remain; actual saved adjustments restore the existing interval calculation. Retention keeps its own documentary context and unavailable operational recall semantics. Read-only PG assertions include unchanged public tables/sequences.

Relevant paths: `components/PatientOrtho.tsx`, `lib/db.ts`, `lib/ortho-followup.ts`, `lib/ortho-followup-worklist-contract.ts`, `app/ortho/page.tsx`, `app/print/ortho-followups/page.tsx`. No dates, saved study captures, financial rows or lifecycle records are rewritten by this slice.

**O02 remains partial.** Unknown treatment start cannot yet be saved as unknown in an active legacy baseline; the form still requires elapsed months and remaining duration. The existing API derives a day from elapsed months, and the database does not preserve whether that day was explicitly supplied or estimated. Existing saved date displays therefore still lack a reliable precision contract. A durable known/estimated/unknown model requires a coordinated additive provenance contract and narrow state-constraint change, not a guessed backfill or a change to old capture hashes. The separate first-recorded-photo suggestion can still confuse first documentation with pretreatment initial; baseline saving itself creates no T1, visits or photographs. See `o02-baseline-date-provenance-review.md` for the source trace; its blank/default and false-lapse findings are now superseded by this bounded fix, while its precision/unknown-start findings remain.

### Reception collection journey (O46)

`__tests__/security-http/ortho-reception-collection-journey.test.ts` uses actual server replies and a synthetic browser at390px. It creates a legacy case, historical YER opening and collection schedule through canonical APIs; arrives once; distinguishes arrival dismissal from audited signed-visit deferral; explicitly saves/signs the clinical review as the doctor; defers without receiving money; collects one opening-linked receipt through the account UI; retries the identical payment request/key; refuses repeated signing without altering the signature; reloads the exact visit checkout and verifies the remaining balance and current due suggestion.

Exact row-count checks retain one case, one visit, one opening, one arrangement and one payment, with no new invoice or treatment plan. The test does not introduce a new adjustment or billable procedure merely to obtain a signature. Reception clinical write/read refusals are retained, while its allowed financial workflow remains usable.

This upgrades O46 from an uncomposed evidence gap to **bounded demonstrated acceptance for this same-currency opening-balance journey**. It does not establish all agreement/partial/multiple-currency/extra-procedure variants. O43 SAR-target conversion and O48 retainer–lab binding remain explicit unsupported paths.

## Executed evidence and failures retained

Logs below are under `/workspace/ortho-resume-evidence/`; counts overlap and must not be summed into an overall test total.

| Execution | Actual result and scope | Log / qualification |
|---|---|---|
| b2cc privacy assembled units | 458/458, 24 files | `b2cc-privacy-scoped-units.log`; predates later legacy edits. |
| Privacy agent PG | 53 distinct cases across4 files | Prior privacy report; overlapping invocations36/36 and22/22 are not58 distinct tests. |
| Root privacy + hosted-failure PG regression | 40/40, 6 files | `530-privacy-ci-regression-pg.log`; includes7 new privacy cases plus the corrected migration/closure fixtures. |
| b2cc production build | Passed, including full TypeScript; exit0 | `ortho-privacy-b2cc-build.log` and `.exit`. |
| Combined b2cc-product HTTP/browser | Initial42 passed /1 failed across12 files; corrected targeted2/2 passed; **43 distinct cases passed across runs** | `b7ca-assembled-http.log`; failure was fixture SQL selecting nonexistent `content_hash`; e74f8cf2 switches to canonical assessment fingerprint. `reception-privacy-query-after-http.log`. Not a single43/43 execution. |
| Legacy follow-up negative controls | 12 failed /85 passed before change | `legacy-followup-before-unit.log`; failures established manufactured lapse/due and missing uncertainty copy. |
| Legacy root assembled units | 474/474, 15 files | `legacy-assembled-units.log`; agent131/268 subsets overlap and are not additional distinct coverage. |
| Legacy agent PG | 51/51, 3 files | `legacy-followup-after-pg.log`; board context, retention context and worklist, including no mutations on reads. |
| Legacy actual browser before | 2/2 failed on old b2 product, as intended | `legacy-history-b2-before-http.log`: expected blank elapsed field, observed6 at390/1280. |
| a2 production build | Passed, including full TypeScript; exit0 | `ortho-legacy-a2ef-build.log` and `.exit`. |
| a2 actual HTTP/browser | Initial10 passed /2 failed across6 files; test-only selector fix then2/2 passed; **12 distinct cases passed across runs** | `legacy-a2ef-after-http.log`: wire-input locator timed out after earlier assertions. `o02-legacy-actual-selector-fix.log`: unchanged actual a2 product passed390/1280. 199ef710, integrated ec1663da, changes only selector, not product or acceptance semantics. |
| Prior741 archive expiry/restore | 10/10: expiry7 + backup/restore3 | `741-expiry-restore-pg.log`; actual signed-session wait expiry, missing/replaced artifact refusal and successful restore. Separate earlier checkpoint, not rerun on a2. |
| Frozen a2 full units | **18,307/18,307 in1,033 files; 0 failed/skipped; exit0,784.25s** | `full-unit-a2efe399.log/json/exit`; source remained frozen throughout. |

Privacy HTTP covers current/historical assessment refusal, copied-source refusal, physician exact reads, and reception browser absence of the assessment opener, while account/appointments remain available. This does not establish that every generic case label/free-text projection is safe.

## Hosted CI and pending integration

Last reported c834 hosted run: https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/42753107984 . Quality and print succeeded; PostgreSQL reported4,774 passed and6 failed; HTTP also finished with failure. Exact HTTP assertions/counts could not be retrieved: connector logs returned transport errors, redirected log access was forbidden, and the supported artifact download returned403. The failure is recorded without guessing its cause; final artifacts13736969498/13737612651 remain to be read through an available authorized path. These results belong to c834, not a2. The six migration/closure expectation failures were reproduced and corrected in test fixture commit530e0aaf (agent ad7dc1c1); scoped before6-fail/after33-pass evidence and root40/40 are separate local proofs. They do not retroactively make hosted PostgreSQL green. The final failed outcome has been preserved; the new head requires an independent complete CI run.

The older741 local print result was52/53 with a lab-dispatch failure; no relaxed gate or whole-print success is asserted here. Earlier18,252 full-unit success at741 is valuable baseline evidence but predates privacy and legacy changes.

Staged generic-label commit `1bb6a127` restricts the standalone problems read and adds explicit `problemsVisible` projection to cases. Its unit evidence is212/212 in4 suites after route/UI negative controls; targeted lint passed. The first intermediate implementation incorrectly cleared unrelated recovery UI and failed four existing tests; the final staged implementation scrubs only the problem projection and retains those tests. It is **not yet integrated**: no corrected-product runtime acceptance, build/full TypeScript or full-unit result is claimed for it. Its later actual-a2 negative control proved reception200 instead of403 and the exact synthetic-label leak in both routes; actual cookie invalidation on role downgrade also passed. Test-only4281824c is staged separately for corrected-product verification. Other generic case free-text fields remain a separate residual disclosure surface. See `generic-problem-read-boundary/HANDOFF.md`.

## Acceptance delta and remaining limits

- **O02:** partial, now safer explicit duration entry and truthful unknown prior-care history. Unknown start, persisted date precision and first-system-photo vs pretreatment classification remain open.
- **O03/O04:** current patient/source/role containment improved by assessment privacy and actual browser proof; no claim that every clinical read surface is isolated.
- **O05/O46:** supported receipt replay, no money from deferral and exact re-signing/checkout invariants demonstrated in the bounded real journey. Complete historical import recovery and all financial variants remain unverified.
- **O20:** documentary retention remains available, but explicit recall fulfillment/cancellation and operational due semantics remain incomplete.
- **O21/O23/O35:** prior full-PPTX and browser-PDF evidence remains valid for its tested shapes; no second Office viewer, exact all-template fidelity or durable PDF archive claim.
- **O25/O50:** clinical exports are not anonymized; case_only does not remove identifying free text/images/notes. Versioned captured branding/identity remains separate.
- **O43/O48:** unsupported SAR-target cross-currency collection and non-null retainer lab-order binding remain unchanged. No financial policy workaround was introduced.
- The a2 local full-unit run passed; final hosted CI, staging isolation, deployment/rollback acceptance and blanket52-scenario completion remain unproven. The unavailable other-cloud patch remains unapplied.

## Next work and preserved sources

The next staged changes are separate from this checkpoint: generic problem-label containment `1bb6a127` plus actual acceptance `4281824c`; consent-source truth `418da905` (blank source instead of claiming a paper signature,56 scoped tests passed); and an actual first-assessment/photo journey still under test. None is represented as part of a2 acceptance.

The other-cloud `b2d1d771` repository and patch paths were checked again and remain absent; no application or merge is claimed. Offline Windows uncommitted work and prior worktrees remain untouched. Last remote read confirmed main `c6c886121bcc50aa548f64b0b0fbd7b5beb1f324` and this branch `c8340975a68e259118d13766b456cd4054fc1f45` before this checkpoint push. No main merge, deployment or denied PR retry occurs here.
