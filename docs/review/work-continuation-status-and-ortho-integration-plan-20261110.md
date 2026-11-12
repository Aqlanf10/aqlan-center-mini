# WORK continuation: status and orthodontic/cephalometric integration plan (2026-11-10)

Independent branch `feat/claude-work-continuation-20261110`. It stacks, in order, on the #506 head `8586f991`:

1. the interim branch `feat/claude-interim-plan-item-scope-20261109` (`aae4d721`, `8417afdb`, `44e85d1f`), unchanged;
2. slices 95a, 95b and 95c (historical onboarding), which were local and unpublished.

Nothing here is merged into `main`, WORK (#506), or any orthodontic branch. No deployment. Synthetic data only.

## 1. What was verified first

| Item | State on 2026-11-10 |
|---|---|
| #506 head | `8586f991`, unchanged since 2026-11-07. |
| CI on `8586f991` | Run 42407639303: all five required jobs green. |
| Later red run 42527137906 | Same commit, pushed as the interim branch on 2026-11-08. Every job ended within two seconds with no steps: the runner never started. It is not a test failure and not evidence against the code. |
| Interim fix (Dot's P2 on #506, comment 6672535456) | Had never been executed (the interim session had no local environment). Executed here: `plan-items-canonical` 8/8 with the fix; with the fix reverted the new test fails (`does not reveal an external item's financial lineage by its identifier`). Confirmed and fixed. |
| Same pattern elsewhere | `updatePlanItemOn` checks plan membership before the lineage read; `canonical-plan-case-command` resolves the item's patient and reads outside as missing. No sibling defect found. |

## 2. Route conversion state (from `M2_ROUTE_CAPABILITY_MAP.json` on this branch)

386 mapped methods: 200 canonical-done, 144 still legacy-only ("existing"), 42 entry/self/owner-only/excluded. Conversion state is not system readiness; the readiness audit still reports `NOT_READY`.

| Area | Done | Remaining | What remains |
|---|---|---|---|
| Patients and families | 72 | 3 | Includes the legacy balance arrangement writes (slice 95d) and the prescription list read. |
| Clinical visit | 13 | 1 | — |
| Plans (finance side) | 18 | 0 | Complete, including the plan-item privacy fix. |
| Finance (invoices, payments, shifts, expenses, treasury, payables, commissions, reports) | 21 | 29 | Slices 96–98: shifts and day close, expenses and treasury, payables, commissions, reports. Owner policy points 1–8 (contract section 15) and the correction price question (93c) are still open. |
| Appointments | 13 | 2 | `PATCH /api/appointments/[id]` and `GET /api/appointments/availability`. The separate appointments candidate #522 (categories, durable receipts, migration 0096) is not composed with WORK. |
| Laboratory | 20 | 0 | Complete on the canonical runtime (slices 66–71). |
| Prescriptions | 0 | 3 | `POST /api/prescriptions`, `POST /api/prescriptions/[id]/void`, `GET /api/patients/[id]/prescriptions`. Deliberately held: the reviewed Rx design lives on #519/#523/#524 with migrations 0090–0094 and must be composed before a canonical branch is written on top of it. |
| Ceph and orthodontics | 21 | 3 | See section 3: the canonical ceph commands follow the older contract. |
| Governance (settings, accounts, audit, backup) | 3 | 18 | Unified settings step 3 (canonical account writes in the staff editor); 20 owner-only methods are by design. |
| HR | 0 | 41 | Not started on the canonical runtime. |
| Inventory | 2 | 7 | M3b acceptance. |

Still separate and unchanged: M4 (schema registration and upgrade/restore rehearsal), M5 (Staging plan and cutover runbook).

## 3. Overlap with Dot's orthodontic work

Dot's active line is `feat/ortho-reconcile-20261109` at `51c58e93`, with test-only drafts #532 (`a426553d`, 11 files) and #533 (`c1044c84`, 3 files). These branches and their test files were only read.

### Facts

- `51c58e93` is 90 commits ahead of `51cfbf81`, the head the earlier alignment proposal on #483 was written against.
- **Completion contract: stable.** `app/api/ceph/[id]/complete/route.ts`, `ceph-completion-provenance`, `ceph-completion-snapshot`, `ceph-source-review`, `ceph-completion-access`, `ceph-draft-authority` and `ceph-lifecycle-authority` are byte-identical between `51cfbf81` and `51c58e93`. The request is `{ expectedSnapshot, expectedSources }`; the witness is sealed in the same transaction.
- **Correction (duplicate) contract: changed.** `duplicateAuthorizedCephAnalysis` now requires an `expectedCorrectionSource` token; new modules `ceph-correction-origin`, `ceph-correction-source`, `ceph-correction-lineage-schema`; new migration `0124_ceph_correction_lineage`; the reset fence also locks `ceph_analyses` and refuses when a correction exists. The study read returns `correctionSource`.
- **WORK's canonical ceph commands follow the older contract.** `commandCanonicalCephComplete` accepts only `expectedVersion` and calls a completion writer without snapshot, sources or witness. `commandCanonicalCephCopy` knows nothing of correction lineage. On WORK the canonical branch runs before the legacy branch, so a canonical account would be refused by, or would bypass, the new protections after a naive merge.
- A trial merge of the older ortho head into WORK gave 86 conflicts, reaching `ClinicalVisit`, `ci.yml`, settings and finance screens. It was aborted.
- Seven of the 14 test files in #532/#533 were also changed on WORK since the common base (`clinical-visit-ortho-entry-ui`, `hr-temporal-history-ui`, `legacy-onboarding-checklist-ui`, `ortho-compatibility-reference-http`, `ortho-package-read-state-ui`, `patient-ortho-real-react`, `prescription-diagnosis-ui`). They will conflict on integration; Dot's versions are the reference for orthodontic behaviour, WORK's for canonical sessions.

### Plan (not executed)

**Gate 0 — freeze.** Integration starts only from an orthodontic head that Dot names as frozen, with #532/#533 resolved and its hosted CI complete. Until then nothing is ported. A port against a moving head would be stale within days, as the 90-commit move shows.

**Step 1 — take the ceph source verbatim, on a separate branch from WORK.** From the frozen head only: the ceph libraries, the ceph section of `lib/db.ts`, the ceph migrations (0113, 0114, 0124, unchanged bytes), the ceph UI, the legacy branch of the ceph routes, and all ceph tests. Not taken: orthodontic study/facial/space/retention modules and their migrations, Rx, `ClinicalVisit`, the financial link, CI workflows. A manifest lists each taken file with its blob id, to prove it is unchanged.

**Step 2 — one body, two authorities.** The orthodontic writers keep their bodies: lock order (provenance fence, patient, analysis, image and references), CAS inputs, snapshot and source comparison, readiness checks, witness capture, atomic audit, messages. Only three points take an authority:

| Point | Legacy session | Canonical session |
|---|---|---|
| Transaction | the writer's own | the admitted staff operation's (the writer's work behind a savepoint) |
| Admission right after the patient row lock | label and `canAccessPatient(…, "canUploadXrays")` | grant `clinical.ceph.analyze`; scope `all`, or `own` with the ownership witness `NOWAIT`; outside reads as missing |
| Still valid before each write and before commit | session expiry | `assertStaffOperation` (grant, generation, revocation) |

The actor in stamps, witness and audit is the session's on legacy and the canonical identity's on canonical. No protection is removed on either path.

**Step 3 — canonical commands speak the orthodontic contract.**
- Complete: `{ expectedSnapshot, expectedSources }`; the `expectedVersion`-only command, its parser and its tests are removed, not carried over. Lost-response replay only for the same actor (user id and username) with matching snapshot and sources.
- Duplicate: `expectedCorrectionSource`, with correction ancestry enforced under the lock.
- Edit, create, discard: the orthodontic CAS inputs (`expectedCalibration`, `expectedLandmarks` including `[]`, `expectedDiagnosis`).
- Reads: the orthodontic shapes (provenance state, source identity, `correctionSource`) inside the patient scope.
- Grants do not change: reads `clinical.xrays.view`, writes `clinical.ceph.analyze`.

**Step 4 — tests before the branch is shared.**
- Every orthodontic ceph test (unit, PostgreSQL, browser) passes unchanged, including the genuine-witness fixtures of #533.
- Canonical tests per writer: positive write and audit; grant matrix (analyze, view-only, other grants, the label); `own` outside reads as missing; a lock race in which the patient leaves the scope while the writer waits (with a failure-first proof); revocation before and during the operation; completion with snapshot mismatch, source mismatch, unreviewed landmark, missing calibration provenance, same-actor replay and refusal of another actor's replay; duplicate with a stale correction source.
- WORK's full gates on the branch. The seven shared test files are resolved by keeping both sides' assertions; none is weakened or deleted.

**Step 5 — review.** The branch, its head, the manifest, the diff of every non-verbatim file and the test results go to Dot on #483/#506 before any integration into WORK or into the orthodontic line. Whole-branch composition (the remaining orthodontic modules, `ClinicalVisit`, the visit and financial-link contract) is a later, separate decision; `REVIEW_REQUIRED` and `OUTSIDE_CONTRACT` are kept and no fee is inferred from unlinking a plan.

### Local preparatory work (not published)

A local branch holds a partial port against the older head `51cfbf81`: the verbatim ceph files, the transplanted `lib/db.ts` ceph section, and the authority seam of step 2 (`lib/ceph-write-authority.ts`), compiling except for the canonical commands that step 3 rewrites. It has never run a test and predates the correction-lineage change, so it is kept as a prototype of the seam only and will be redone from the frozen head.

## 4. Blockers

- **Hosted CI startup.** Runs on the interim branch ended with zero steps. Whether it recurs is checked on this branch's own push run.
- **Orthodontic head not frozen** (gate 0).
- **Owner decisions open:** policy points 1–8 of contract section 15, correction price controls (93c), responsibility for case financial ownership (G4-7).
- **Local browser:** three journeys fail locally on Chromium 1194 and pass on hosted CI's Chromium (`agreement-reconciliation-browser` at 390 and 1280 px, `dental-chart-built-page` at 390 px). They fail identically on older WORK heads.
