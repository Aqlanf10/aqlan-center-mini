# Local Ortho/Ceph activation review — 2026-10-11

This is a resumable local implementation packet for dot/root review, not acceptance
of the 349 requirements or 52 scenarios and not a deployment. No remote branch,
main, Staging, Production, real patient data, or outbound patient message was used.

## Source identity

- Invoice/HR parent: `2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9`, tree `880030f12d6fc718fcf98720327f9ba8969478b8`.
- Independent Ortho parent: `476f374b33e996bcf2909cbdb9449d25fffcc6c0` (PR324).
- Local merge: `c21a15a5db4bf9ce49c1addc60bb6cd742524ca0`, tree `28ea1a38ffd3fa775cc2325ae887d3ea801cc2f0`.
- First connected checkpoint: `74113ee58af99e6ff8bbe57fa2e30168fda20cfc`, tree `25c598532f496e155ee8567aea4d78bfd74b8f56`.
- Tested workflow/science checkpoint: `9259dc6f5a56d6e40e3fc1d3d8bf0e310fc132fa`, tree `f73f52486c055740095d3ab31050900bafa34031`.
- Branch: `local/ortho-finance-union-20261011`. Later review commits name this code checkpoint; do not infer an unrecorded CI result for them.

Both PR324 coordination comments were read, including
[6113666398](https://github.com/Aqlanf10/aqlan-center-mini/pull/324#issuecomment-6113666398)
and [6113602548](https://github.com/Aqlanf10/aqlan-center-mini/pull/324#issuecomment-6113602548).
Shared changes were applied as proposal hunks, with manual resolution of the
PatientOrtho owner and finance intersections. No whole shared file was restored
from an archive. The original reference archive could not be materialized through
the supported Library transfer; it was not used as a verified local source.

## Connected behavior

The app layout now provides recovery ownership and actual session user ID. The
eight registered routes admit the current session, validate their exact scope and
bounded body, and call the existing transaction-backed stores. Reads, refusals and
uncertain writes are private. Current actor/patient authority is rechecked under
transaction locks; a route-level permission check alone is insufficient.

PatientOrtho mounts intake, structured assessment, study and retention into the
five-section/thirteen-step navigation. New intake first selects the server-confirmed
case and bridge before refreshing. Same-case navigation retains drafts and refuses
pending/uncertain operations. Actor/case/patient retirement invalidates children.
The original guarded `onOpenTreatmentEntry` callback and invoice entry remain.

Assessment-only cases do not invent appliances, treatment dates, duration, phases,
or financial plans. Nullable consumers no longer substitute assessment or upload
timestamps for clinical dates. Photo acquisition stage/date and Ceph phase require
explicit input. Study saves/reopens through PostgreSQL without an export converter.
The title includes the actual patient; center identity/logo comes from settings.
The center doctor label is not an invented responsible clinician assignment.

## Shared review boundaries

`ORTHO_UNION_PRESERVATION.json` records 133 unchanged protected production files
and exact hashes for `itemsFor` and `getInvoice`; both retain the optional client
and are byte-identical to PR325. HR reset table membership remains identical.

- `lib/db.ts`: compose the three new schema modules, project assessment/nullable
  clinical facts, keep the established invoice/HR implementation.
- `components/PatientOrtho.tsx`: ownership and connected mounts; preserve original
  finance entry and package linkage position. Hash-boundary tests were deliberately
  repinned for these reviewed additions, while Visit/mutation/writer pins remain.
- `lib/http-permissions.ts`: exactly eight route entries; no export capability.
- `lib/migrations.ts`, fixture chain and schema verifier: exact 0052–0054 suffix.
- `lib/clinic-reset.ts`: prepend seven new Ortho tables, preserving the HR lists.
- `proxy.ts` follow-up: API errors emitted before handlers also need private
  no-store headers. Permission decisions are unchanged. The real HTTP test first
  exposed missing headers on anonymous/cashier refusals; this is a separate fix.

Review patch: `/workspace/ortho-union/review/shared-files.patch` (regenerate after
later code commits). No permission registry, migration registry or reset file was
replaced wholesale.

## Migration and recovery evidence

0052–0054 SQL is the exact SQL exported by the pinned independent TypeScript schema
sources. 0044 stays reserved; 0045–0051 remain unchanged; no placeholders were
created. 0055 governance and 0056–0057 HR remain reserved. The periodontal suffix is
0058 in the union-only test fixture; historical prefixes retain their own exact
expectations. The strict migration-chain guard was not loosened.

All execution used local synthetic PostgreSQL 18.6. UUID fixtures verify their
database identity before disposal; the browser harness owns `aqlan_sec_http` on
127.0.0.1. No external database connection was used. Tests cover backup/restore of
the composed 0052–0054 chain plus the temporary periodontal fixture, HR backup
roundtrip, and audit-failure transaction rollback.

Schema ownership characterization: unexpected differences 0, known differences 0,
**16 open convergence findings; application schema equal = false**. Raw report:
`/tmp/aqlan-schema-ownership-report.json`; execution log:
`/workspace/ortho-union/schema-ownership-initial.txt`. This is not a clean convergence
claim. Versioned operational catalogs still require source-bound regeneration and
review before publication.

An unversioned database bootstrapped with nullable 0054 no longer satisfies the
historic 0001 NOT NULL baseline probe. The probe remains strict. The adoption test
now constructs the actual historical <=0051 shape before adoption; a separate test
asserts rejection of bootstrap-only 0054 as 0001. Operational adoption must precede
this new bootstrap or use a separately reviewed convergence procedure.

Exact 0055 source was recovered from Library text, not guessed or activated:
`libfile_4ff12d4c3b2c81918210b57c7be0b791`; 39,016 bytes;
SHA256 `a3f2f8bbb640b2bdf671f6d9607a61784a5ef7df73b02d82a4c5d75e5beec013`.
All six decoded file hashes match the supplied manifest in
`/workspace/ortho-union/private-owner-package/verified-0055/`.
This is schema/helper source only. Management writers, explicit grants, lock-order
and atomic audit integration are not claimed. Admin is not an implicit grant.

## Executed evidence, with limits

Logs are retained in `/workspace/ortho-union/`; they contain synthetic data only.

| Evidence | Observed result | Scope/limit |
|---|---|---|
| `pg-independent.txt` | 8 passed | Existing real-store study/retention tests |
| `pg-union-regression.txt` | 35 passed / 5 files | Connected intake/study, invoice selection, HR replay/backup, periodontal restore |
| `pg-finance-hr-final.txt` | 174 passed / 9 files; one fixture setup failed | Missing synthetic SESSION_SECRET in the tenth suite |
| `pg-hr-operational-final.txt` | 22 passed | That suite rerun with an explicit synthetic secret; no test skipped |
| `target-sixth.txt` | 116 passed | Current-owner/read safety, intake and Ceph zero tests before later science additions |
| `target-science-contract-second-final.txt` | 87 passed / 5 files | Independent numerical fixtures, WITS zero/invalid calibration, existing Ceph, integration guards |
| `native-connected-sixth.txt` | 4 passed | Native Chromium + built app + actual HTTP/PG at 390 and 1280 |
| `build-verified.txt` | exit 0 | Build including WITS positive-calibration guard, before proxy follow-up |
| `typecheck-second-final.txt` | exit 0 | Checkpoint source before later independent-fixture additions |
| `unit-final.txt` | 10,202 passed; 2 failed; 1 pre-existing skipped | Superseded run: hash pin and WITS zero-scale failures subsequently fixed, 87-test targeted run above passes |
| `unit-verified.txt` | 10,219 passed / 592 files; 1 pre-existing skipped | Full post-fix suite; no new skip or disabled guard |
| `build-proxy-verified.txt` | exit 0 | Build also includes the private API error-header follow-up |
| `http-eight-routes-final.txt` | 14 passed | All eight routes reject anonymous/cashier reads privately; six writers refuse reception before parsing malformed bodies |

The browser scenarios prove new intake, exact lost-response study replay, reload,
and historical 300000/120000/180000 financial registration through the existing
writer, replay, bridge reuse, explicit unknown date/duration, same-case activation
and study save/reopen. Clinical actions leave financial row counts unchanged.
This is not proof of the complete examination, treatment, image-editing or export
journey. Patient/actor changes and revoked authority are additionally covered by
unit/real PostgreSQL tests, not yet by every native-browser combination.

Four final native screenshots were visually inspected:
`.settings-ui-artifacts/ortho-union-{study,historical}-{390,1280}.png`.
Their pixels show patient title and clinic identity with no horizontal overflow.
These are synthetic application screenshots, **not** the three unavailable private
reference images. No claim of visual comparison with those originals is made.

## Scientific and bilingual scope still open

The three independent scientific review files in `ortho-union-science/` are exact
Library text materializations with supplied matching hashes. They are focused
evidence and fixture proposals, not clinical approval. Independent tests exercise
calibration, SNA/SNB/ANB, WITS, Bolton exact tooth sets/residuals and signed permanent
space. Mixed-dentition prediction remains unsupported; no Yemeni coefficients or
universal norms were enabled.

WITS coincident projections now yield 0 only on a valid plane with positive finite
calibration. The old x-oriented sign convention and ambiguous occlusal-plane
protocol still require versioned review. The current `SNGOGN` legacy calculation
uses Go–Me. Owner explicitly requires Steiner SN–GoGn and Downs FH–GoMe; do not
silently rewrite old stamped measurements or treat their codes as comparable.
Steiner's original 1960 article p.724 was read through the public PDF text; it names
GoGn–SN. Full original Downs definition verification is pending. A publisher
download returned 403, and the web screenshot was only a reference, so visual
inspection of that article page is not claimed.

Full bilingual behavior is mandatory under V2R129 and the latest owner clarification:
intake, examination, measurement labels/results, validation/missing-data messages,
diagnosis/planning, longitudinal study and both exports. Current coverage is partial:
journey navigation has an ar/en dictionary; Ceph labels have both languages; the
mounted journey and most new forms/messages remain Arabic. Neither an English
native journey nor bilingual exports has passed. Authored clinical text must remain
verbatim, with no implicit translation or approval. Landmark abbreviations, units,
numeric direction and RTL/LTR layout require separate checks.

PPTX and PDF are not connected or delivered. Image preview/edit composition still
needs connected original-media delivery and independent persistence/pixel evidence.
The private template references are missing. Full 0055 approval governance,
versioned Ceph definitions/reference applicability, full bilingual UI, remaining
native adverse scenarios, export generation and all 52 acceptance scenarios remain
open. The ledger records partial evidence without converting it to acceptance.
