# Saved study archive and full presentation — 2026-11-10

Branch: `feat/ortho-reconcile-20261109`. Integrated application tested at `4d825046a593b2ba6c143e4db83b63e6bf94c5ce`; the subsequent test-only change uses a click for an opt-out control that immediately disappears, retaining all membership, value, provenance and database assertions. This is a bounded implementation checkpoint, not whole-unit clinical or staging acceptance.

## Result

The saved study now supports explicitly reserving, preparing and downloading a durable PPTX artifact. Reservation retries reuse the same request identity; the stored file belongs to the exact saved revision, renderer contract and source rendition manifest. Reading or opening the archive never starts rendering. Running is creator-only; downloading checks current independent export permission and current source authority before and after the bounded file read. Clinical/financial data are not written by export.

The illustrated PPTX uses native editable text and tables across the 27 supported panel layouts, including continued long tables. Source photographs remain original; saved crop/rotation recipes produce separately hashed renditions. Wide tables use named field/value continuations rather than clipped columns. Captured clinical text, images and speaker notes may identify a patient: this remains clinical export, not educational anonymization.

Measurement-session source application now previews old/new provenance and permits excluding individual targets without changing their numbers. The historical source copy in the patient workspace now accurately includes reviewed facial observations.

## Durable implementation

- Additive migration `0123` introduces immutable export jobs/artifact records, generation/token leases, exact request fingerprints, renderer contract pins, audit and restore coverage.
- Canonical patient/case/study/source authorization is reused. A bounded process slot and dedicated PostgreSQL session advisory lock prevent overlapping render work; no database transaction is held during encoding.
- Private artifact storage requires an existing durable, nonsymlink `DOCUMENTS_DIR`. Publication uses exclusive temporary creation, fsync, no-clobber linking, hash verification and bounded reads. An uncertain database publication retains the artifact for receipt recovery; it never deletes a potentially committed file.
- API routes are registered explicitly in the fail-closed HTTP permission registry. They retain current grants, CSRF, body limits and strict allowlisted commands; no route exemption was added.
- The UI retains uncertain reservation identity in memory, prevents same-turn duplicate sends, retires stale owner/revision responses and displays allowlisted recovery guidance.

## Executed evidence

All records/images are synthetic; PostgreSQL18.6 runs in an isolated local container.

| Check | Result and scope |
|---|---|
| Production build / TypeScript | Passed on exact application head `4d825046` |
| Integrated HTTP/browser | 21 distinct cases passed across two runs: 19 first, remaining 2 after correcting the removed-checkbox interaction; 390px and 1280px |
| Archive API/browser subset | 5/5: text/illustrated files, exact downloaded SHA, immutable receipt replay, current grants, creator restriction, cross-patient/forged/CSRF refusal, reload recovery, no extra financial/clinical writes |
| Actual image export | Synthetic two-color PNG with saved half-crop; manifest rendition hash equals embedded PNG hash, differs from original; original bytes unchanged |
| Shared measurement preview | 2/2 actual browser: cancel, opt-out, same numerical values, correct changed/unchanged provenance, navigation, exactly one assessment revision, zero invoice/payment/visit creation |
| Existing integrations | Export permission10, workup2 and prescription2 HTTP cases passed |
| Focused implementation units | 89/89 assembled feature checks at `6f6dc83b`; 52/52 registry/audit/source/runner checks after `4d825046`; overlapping subsets, not additive coverage |
| Archive PostgreSQL | 45/45 combined checks, including restored obsolete contract refusal, concurrency, immutable publication, revocation and restore |
| Financial regression | 53/53 across six existing PostgreSQL files in two runs; first run had 26 setup blocks from missing synthetic `SESSION_SECRET`, corrected in ephemeral test environment; no finance source change |
| Visual PPTX review | Actual LibreOffice/PDF rendering: representative14, catalog28 and wide-table31 pages inspected; RTL caption reversal and narrow visit layout corrected |

The first integrated HTTP run at `6f6dc83b` had 12 passes and 9 failures. Those exposed missing route registration, inaccessible exact select labels, and a raw-PPTX-XML assertion that did not reconstruct split text runs. The next run had 19 passes and two detached-checkbox test failures. Both later passed without removing clinical or security assertions. Evidence is retained under `/workspace/ortho-resume-evidence/`; generated synthetic artifacts and raw logs are not committed.

## Remaining limits

- Hosted CI on the earlier pushed `5e23a694` is not proof for this assembly; final assembled-head CI is still required.
- PDF/print still uses the earlier simpler compositor. Full PPTX/PDF visual parity, historical center/doctor identity binding, educational anonymization and a second Office viewer remain unverified or unimplemented.
- Archive UI currently lists the newest25 jobs and retains an unresolved reservation key only while mounted. Durable server history survives reload; cross-reload client key persistence is not claimed. Archived PDF is unsupported.
- Deployment must provision and verify durable private storage, migration compatibility, backup/restore and isolation. Local storage/restore tests do not establish staging safety.
- The separate `b2d1d771` patch remains unavailable in this environment and was not applied.
- Clinical acceptance remains partial: structured ceph correction lineage is in a separate worktree; audited reopening, recall resolution, complete import recovery and several end-to-end journeys remain outstanding. Unsupported cast methods stay unavailable. SAR-target cross-currency collection and retainer/laboratory binding remain existing integration gaps; no parallel financial engine was introduced.

No main merge, staging/production deployment, real-patient modification or retry of denied PR creation occurred.
