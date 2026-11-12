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

## 4. Held on this branch

The canonical (staff-cutover) ceph write commands (create, copy, discard, complete, edit) were
built on the earlier completion contract. On this branch they refuse with 409
`ceph_contract_alignment_pending` before any read or write; malformed input still gets 400.
The legacy ceph routes use staging's protected writers unchanged. Canonical ceph reads stay;
the canonical pair comparison now uses staging's acquisition-date ordering and refuses an
unresolved order instead of falling back to creation time.

Re-alignment of those commands with the snapshot/sources/provenance contract is open work.

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
- Five PostgreSQL tests of the held canonical ceph writers replaced by
  `canonical-ceph-write-hold.test.ts` (400 for malformed input, 409 hold, no database access).
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
