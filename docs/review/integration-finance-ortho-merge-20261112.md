# Integration merge: finance/permissions work into the staging orthodontic line (2026-11-12)

Branch `feat/claude-integration-finance-ortho-20261112`, created from the staging reference
`4d85fb6943b889d5b343c8467be1adccece9e327`, with `33175cbe5ad88601e890f6e4f6a6faa5094347e6`
(#539, which contains #536) merged in by a non-fast-forward merge commit. Common ancestor
`6a6bdc0c`. Directive: #483 comments 6830782877 and 6830804146 (integration), 6831365228 and
6831400531 (finance additions), 6831528725 (migration numbers). Synthetic data only. Not deployed.

## 1. Rules applied

- Neither side was taken wholesale. Each of the 108 conflicted files was resolved hunk by hunk.
- Staging owns the orthodontic, cephalometric, prescription and portal contracts. My branch owns
  finance, permissions (canonical runtime), lab work identity and case participation.
- Where my branch had moved a function body into a transaction helper (`…On`, `…With`,
  `…InTransaction`) and staging had hardened the same body, staging's protections were moved
  into the helper, so the legacy route and the canonical runtime share them.
- Where both sides rewrote a component only for the newer React lint rules, the version of
  whichever side also carried functional changes was kept whole; mixing two equivalent rewrites
  produced broken code and was undone file by file.
- Published migrations, their bytes and checksums are unchanged. No renumbering.

## 2. Migrations

| Source | Versions |
|---|---|
| Staging | 0090–0093, 0106, 0108–0125 |
| This branch | 0074, 0079–0082, 0126 |
| Merged tree | 95 numbered files; no shared file differs by a byte |

- `0126` is registered after `0125` in `ensureSchema`.
- The reviewed migration manifest (`__tests__/fixtures/reviewed-migration-manifest.json`) gained
  only my six entries; staging's 89 entries are byte-identical.
- `0127` belongs to `security/patient-isolation-and-hardening-20261111` and is not used here.
  Numbers for the new finance work are proposed in #483 (6831614143) and not yet fixed.

## 3. Database layer (`lib/db.ts`, 50 conflicts)

| Area | Resolution |
|---|---|
| Visit relink / delete | Staging's admin-only, patient-scope, prescription-history and adjustment-request guards moved into `linkVisitToPatientOn` / `deleteVisitOn`; the legacy `deleteVisit` keeps staging's session signature, audits in the same transaction and calls the helper; the canonical command maps the two new refusals. |
| Patient merge | Staging's reset fence, history locks and seven history refusals moved into `mergeDuplicatePatientOn`; the canonical merge maps the new refusals (counts only to care roles). |
| Settings | Staging's medication-catalog authority moved into `writeSettingsInTransaction` as a required `catalogAuthority` callback re-proved after the settings locks; absent → refused. |
| Visit ortho context | Staging's strict recorded visit→case source (`recordedVisitOrthoSource`) combined with my explicit follow-up coverage; preview no longer swallows a link conflict. |
| Visit signing | My split kept (`signClinicalVisit` + `signClinicalVisitLockedOn`); staging's signer re-check, assistant rules, scope, interval/text admission, in-transaction audit and 55P03 mapping added; `signAuthorizedClinicalVisit` restored as the HTTP entry. The multi-adjustment ambiguity rule now runs on staging's verified case only. |
| Documents | Staging's upload authority wraps my `recordDocumentOn`; the canonical download read also returns the stored hash. |
| Ortho billing decision, close, phase, retainer, baseline | Staging's authority wrappers kept; my transaction helpers take staging's rules (case lock before adjustment, no lifecycle change from retainer metadata, scoped close). |
| Cephalometrics | **Staging's writers kept whole.** My old-contract transaction helpers were removed. |
| Clinic reset | Both sides' history protections and truncation lists combined. |

## 4. Canonical ceph writes: re-aligned with staging's contract

The merge commit held the canonical (staff-cutover) ceph write commands with 409
`ceph_contract_alignment_pending`, because they were built on the earlier completion contract.
The follow-up commit removes the hold by running **staging's own protected writers** inside the
admitted staff operation, instead of keeping a second writer:

- `runCephWritersInTransaction` (lib/db.ts): within a canonical operation the writer's client is the
  operation's client, and its BEGIN/COMMIT/ROLLBACK become one savepoint. A refused write rolls
  back to the savepoint and the command then aborts the whole operation, so nothing partial survives.
- Admission seam (`CephDraftWriteRequest.admit`, `authorizeCephCompletion(..., admit)`): after the
  writer locks the patient row, canonical admission proves current patient scope and identity
  (`canonical-ceph-admission.ts`) in place of the legacy session re-proof. Capability is the one the
  operation was opened for and is re-asserted before commit.
- Edits take the legacy route's body (observed prior calibration/landmarks/diagnosis; `ceph-draft-edit.ts`
  is shared by both routes). Completion and correction copy take a **server-computed fingerprint** instead
  of staging's snapshot/identity/token, because those carry internal identifiers (image document, case)
  that the canonical study read never discloses. The read returns only
  `completionSources: {state, fingerprint}` (drafts) and `correctionSource: {state, fingerprint}`
  (completed studies). The command rebuilds the snapshot, sources and token inside the admitted
  operation (`canonical-ceph-review-fingerprint.ts`, the same builder the read uses), refuses on any
  difference (409, no effect), and hands the rebuilt values to staging's writer, which re-checks them
  under its own locks. A completed study is rebuilt too, so a lost-response replay still reaches
  staging's read-only replay rule. The legacy route's bodies are unchanged.
- Runtime handle: staging's writer passes its savepoint view of the transaction to the admission
  callback; runtime calls use the operation's own client (same transaction), which the handle is bound to.
- Scope: no record scope → the runtime's 403 refusal; a patient outside "own" → 404, identical to a
  missing study.

Canonical ceph reads stay; the canonical pair comparison uses staging's acquisition-date ordering
and refuses an unresolved order instead of falling back to creation time.

## 5. Generated files

Regenerated with the repository's tools, never merged by hand:
`schema/current-schema-contract.pg18.json` (`npm run schema:contract`),
`schema/preflight-disclosure.pg18.json` (`generatePreflightDisclosure`; no staging fingerprint
removed, 13 fingerprints of this branch's superseded definitions no longer produced),
`docs/security/staff-cutover/*.json` (audit scripts).

## 6. Tests changed by the integration

- Migration lists and counts: staging's lists plus 0074, 0079–0082, 0126.
- `periodontal-candidate-chain`: staging's chain test now covers 95 files ending in 0126 (0126
  requires 0125); a separate test keeps my finance-only chain; the fixture accepts 0126 only after
  0089 or 0125.
- `visit-workspace-contract`: my historical pins unchanged; staging's reviewed sign/load
  deltas (a241e995, 680b0fd8, the preview setter rename) are listed as exact literal reversals.
- `ceph-comparison-record-order`: rewritten to staging's ordering rule (no creation-time fallback).
- Five PostgreSQL tests of the old-contract canonical ceph writers replaced by
  `postgres/ceph-canonical-staging-contract.test.ts` (success with witness for own/all/owner; stale
  snapshot, changed image or reference source, out-of-scope and read-only refused with no effect;
  audit failure rolls back; diagnosis against its observed prior; discard; correction token; create),
  and parser tests by `canonical-ceph-staging-contract-parsers.test.ts`. HTTP journeys use the
  staging bodies.
- `ceph-completion-stale-witness`: same assertions, now through staging's completion API.
- Tests calling changed signatures (`deleteVisit`, follow-up board `GET`, legacy billing decision)
  updated to the merged signatures.

## 7. Post-merge verification fixes (unit suite on b39efe1d: 180 failures in 27 files)

Each failure was traced to its owning contract; none was silenced.

| Area | Cause | Resolution |
|---|---|---|
| Ortho session documentation | This branch required «ما نُفّذ» on every new session; staging's entry contract (and the directive: entries start unrecorded) keeps it optional. | Requirement removed from `checkOrthoSessionDraft`; the refusal text no longer asks for it. This branch's tests that pinned the requirement now pin the optional rule. |
| Standalone adjustment route | The merged POST used this branch's strict draft parser, which broke staging's enum/text/interval admission ordering and legacy replay. | Staging's POST restored whole. Explicit wire removal (this branch) re-added on top: admitted before any write (unknown action or removal plus a wire → 400), passed to the writer, and hashed only when present so every earlier request keeps its exact fingerprint. The command store and the form carry it the same way. |
| Visit signing (client) | The client re-ran the strict server parser and refused staging's lossless interval spellings. | The client checks only the wire action; staging's interval admission stands. |
| Visit with adjustments on two cases | Staging's strict recorded source refuses before this branch's ambiguity rule. | Test expects the refusal for two cases and the ambiguity code for one case; no write in either. |
| Restore staging | Staging's new study-export restore test mocked a client without the identity probe this branch's restore runs. | Same probe stub as this branch's sibling restore test. |
| Prescription owner | Staging fixtures built version-1 permission documents; this branch's documents are version 2 with owner confirmation. | Fixtures use version 2, `confirmation: "owner"`. |
| Settings classes | Staging added `clinical.medication_catalog`. | Classified owner-only; the canonical writer passes no catalog authority, so a canonical catalog write is refused until wired. |
| Lint tooling runtime verifier | Both sides added the file independently. | Staging's version kept; it passes both sides' tests. |
| Route capability map | 45 staging route methods held for canonical admission had no map entry. | Entries added (`clinical.ortho.view`/`edit`, `clinical.prescriptions.write`, patient scope) marked as legacy-only; two `result.mode` reads declared as non-branches. |
| CI | Sharded HTTP job (this branch) lacked staging's failure index; two staging uploads were neither owner-gated nor shard-named. | Normal suite writes `http-main-raw.json` per shard; the locations sanitizer reads it before the failure index deletes it; both indexes upload per shard; the two staging evidence sets have producers in the ownership table. |
| Other pins | Migration lists, a component's hook order, a staging package-link text. | Updated to the merged tree. |

Environment-only (not a merge defect): `ortho-study-export-artifact-storage` refuses storage under `/tmp`
by design (ephemeral zone), and this local worktree lives under `/tmp`. Hosted CI runs from the runner workspace.

## 7a. PostgreSQL verification fixes (suite on 6d81832f: 61 failures in 18 files)

Run from a durable path (`/root/...`), one PostgreSQL run at a time, with CI's two disposable-fixture
switches (`CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE`, `MANUAL_CASH_CI_DISPOSABLE_FIXTURE`). Without them the
five empty-database proof suites refuse a nonempty schema by design; that is how CI runs them, not a defect.
Each staging-only suite was first run on staging 4d85fb69 alone (7 files, 89/89 passed) so only merge
regressions were changed.

| Area | Cause | Resolution |
|---|---|---|
| Legacy baseline writer | This branch's responsibility check (user SHARE lock) ran before staging's patient lock; a permission change committed behind the patient lock deadlocked (500) instead of refusing. | Order is now patient → identity → responsibility, the same as staging's admission; stale account 401, stale access/plan 403, changed doctor 409 again. Responsibility check kept. |
| Clinic reset (study suites) | This branch refuses reset while patient files or retired numbers exist (number reuse protection); staging's study tests reset with a patient present. | Protection kept. Tests prove an empty reset succeeds, and a reset with a patient file is refused before backup with the study history untouched; the merge-serialization test expects the same refusal after waiting. |
| Session writer enums | This branch's writer validates every new session (enum, interval, text); staging seeded a historical invalid-enum receipt through the writer. | Writer validation kept. The historical row and its exact v1 receipt are seeded directly (immutable receipt inserted, never updated), so replay/expiry/actor tests still prove the legacy path. |
| Billing class of a new unfunded case | This branch classifies it `REVIEW_REQUIRED` (decision pending); staging's tests expected `OUTSIDE_CONTRACT`, which this branch keeps for per-session legacy cases. | Expectations follow the merged classification; frozen signed billing and no-charge behaviour unchanged. |
| Reopen guard (0125) | This branch's coverage/decision fixtures reopened a closed case with a direct UPDATE. | Fixtures seed the case open; the decisions test leaves the case closed (its pending review is what later tests read). Guard untouched. |
| Retainer metadata | This branch's lifecycle test expected a retainer save to move the case to retention; staging's rule never infers a lifecycle transition from retainer metadata. | Staging rule kept; test expects the case to stay active. |
| Ceph superimposition | Staging requires a non-collinear S–N–Me frame and refuses an overflowing transform as unavailable geometry. | Pair fixture records Me; overflow expects `ceph_pair_geometry_unavailable`. |
| Ceph comparison overflow | Staging's comparator skips a pair whose difference overflows, so a saved value could vanish from the canonical answer. | Canonical comparison refuses the whole pair (`ceph_pair_invalid`) when a value present in both studies has a non-finite difference. |
| Ceph completion fixtures | Index-derived landmark positions are collinear for several measurements, which staging's completion gate refuses; the PG test also passed the BIGINT id as a string. | Shared defined synthetic geometry (`__tests__/fixtures/ceph-valid-geometry.ts`, same as staging's identity fixture) and a numeric id. |
| Schema ownership | Table count. | 132 (merge base) + 17 (staging) + 14 (this branch) = 163. |
| Canonical ceph read | Staging's correction token and source identity exposed `documentId`/`orthoCaseId` through the canonical read. | Fingerprint contract (section 4). |
| Canonical ceph/catalog fixtures | Migrations-only databases have no seeded reference set; BIGINT ids arrived as strings. | Synthetic reference set seeded in the fixture; numeric ids. |
| Medication catalog (6839071994) | The new tests had a wrong column, a wrong revision, a timing-based revocation and no concurrency proof. | Revocation now committed behind the identity fence; two concurrent dose edits from one observed version: one saves, the other is refused with no effect; a stale legacy edit is refused. |
| Preflight artifact (local only) | With `node_modules` symlinked, esbuild sees dependency paths outside `node_modules/`. | Not a defect; passes from a real checkout. |

## 7b. Hosted browser verification fixes (CI run 43377703712 on d6d6c71d: 55 failures in 13 files)

The hosted HTTP and browser shards ran this branch's and staging's journeys together for the first time.
Every failure was investigated against both sides. Local reproduction ran from the durable gate worktree,
because document storage refuses temporary directories by design.

| Area | Cause | Resolution |
|---|---|---|
| Ceph discard (canonical) | Section 4's integration dropped #539's observed-version check: a stale discard removed a draft that was edited after it was read. | Version check restored inside the admitted operation (patient → study → children share-locked), with a strict body and `{ok, studyId, status}`. Staging's writer still audits. |
| Ceph create (canonical) | Section 4 dropped #539's checks: a posted orthodontic case ID was linked without the `clinical.ortho.view` grant (201 instead of 403), and image refusals differed per reason. | Grant check and one private reference refusal restored before staging's creator. The duplicate warning no longer lists other study numbers. |
| Ceph edit (study journey) | The journey still sent #539's body; edit follows staging's `expectedDiagnosis` contract (section 4). | Journey uses staging's body; the completed study still refuses with 409. |
| Legacy ceph compare/superimpose | #539's test compared completed studies without a provenance witness; staging refuses them by design. | Staging rule kept; the test asserts the refusal in both orders with no computed values. |
| Canonical assessment (read-only) | Staging's client role check (admin/doctor) hid the canonical view from a reception user who holds the explicit `clinical.ortho.view` grant. | Role check kept on the legacy editable path. The canonical read-only view follows slice 31 and the M2 map: the server admits it by grant and scope. |
| Lifecycle editor | The editor expected a retainer save to move the case to retention (see 7a), so it reported a committed save as uncertain. | It now expects the status unchanged. |
| Legacy case entry | #539 requires an administrator to choose the responsible doctor; staging's journey did not. | The journey selects the doctor explicitly. |
| Plan unlink write | The merge dropped staging's assertion that the unlink carries `expectedVersion`. | Assertion restored. |
| Coverage journeys | The fixture now creates a completed case; reopening it is refused by the reopen guard (0125). | The journeys request an active case. |
| Case card at 390px | The merged card grew about 135px: the case navigation took three rows, and the admin-only responsibility box sat above the clinical header. | One-row navigation (icon above the full label on phones); the responsibility setting moved into the case reference context. |
| Diagnostic case section name | Staging's records and diagnosis journeys open the section by the word "السجلات"; #538 renamed it "التشخيص" and stage 3 renamed it "الفحص والتشخيص". | Named "السجلات والتشخيص" (records, then diagnosis). |
| Workup step selector | Staging's journeys used the step selector, which #538's direct section navigation replaced. | The journeys open the workspace and the exact section directly. Leaving and returning through sections keeps the unsent draft. |
| Package read-state wait | The hydration wait targeted a summary text that the merged screen no longer has. | The wait targets the current summary text. |

## 8. Migration allocation for the finance additions (#483 6833690789)

Coordinating allocation for this integration line only; not an exclusive or global lock. Re-checked
before the first push of this branch: `git fetch` of all 335 remote branches, then a search of every
fetched tree for `migrations/0127_*` … `migrations/0132_*`. Only `0127_patient_portal_security.sql`
(`security/patient-isolation-and-hardening-20261111` @ `a77f8cdc`) exists; 0128–0131 are unused. Local
work of other sessions is not visible to this check. It is repeated before the final integration.

| Version | File | Purpose | Depends on |
|---|---|---|---|
| 0126 | `0126_case_participations.sql` | Case participation (published; unchanged) | 0125 |
| 0127 | — | Reserved by the patient-portal security branch; never used here | — |
| 0128 | `0128_expense_commands.sql` | Expense idempotency; drawer amount vs owner's private-source amount; real payment source | 0126 |
| 0129 | `0129_shift_opening_reviews.sql` | Opening difference review per currency with reason, reconciliation, references and the previous close reference; the close is not changed | 0128 |
| 0130 | `0130_lab_payable_waivers.sql` | Separate documented waiver of a remaining lab obligation (permission, reason, agreement evidence); no automatic waiver on cancel | 0129 |
| 0131 | `0131_invoice_doctor_corrections.sql` | Post-approval invoice doctor correction (grantable permission, reason, before/after, request key, settlement links) | 0130 |

None of these files exists on this branch yet. If a collision appears, only that number is held and
reported (file, branch, blob, whether published or applied); published migrations are never renamed.

### 8b. 0128 in use (2026-11-14)

`0128_expense_commands.sql` is now written on this branch (contract `docs/finance/EXPENSE_COMMANDS_0128.md`).
Collision check first: a tree-only fetch of all 336 remote branches found no `0128_*` file; only 0127
(two patient-portal security branches) and 0132 (this branch) exist in 0127–0139. 0128 sits between 0126
and 0132 in the runtime registration; the reviewed-chain checks accept 0132 after 0128 and, for heads
pushed before 0128 existed, after 0126. 0129–0131 are still unused.

### 8a. 0132, session auxiliary appliances (#483 6867852606)

| Version | File | Purpose | Owner | Depends on |
|---|---|---|---|---|
| 0132 | `0132_ortho_adjustment_auxiliaries.sql` | Optional auxiliary appliances in an adjustment session: two nullable columns on `ortho_adjustments` (NULL = not recorded, `{}` = explicitly none), key and length check | Orthodontic session screen, this integration line (allocated by Dot, #483 6867852606) | 0126 |

Collision check before the first push (2026-11-14 00:00 UTC): a tree-only fetch of all 336 remote
branches into a separate scratch repository, then a search of every tree for `migrations/0127_*` …
`migrations/0139_*`. Only `0127_patient_portal_security.sql` exists, on
`security/patient-isolation-and-hardening-20261111` and
`security/staging-integration-portal-hardening-20261114`. 0132 is unused everywhere. 0127–0131 are not
filled and no placeholder migration is added for the gap. The check is repeated before the final
integration; on a collision only 0132 is held and reported.
