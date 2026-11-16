# Slice 45 — clinical problem creation and linked-case privacy

Base `db16763d61a58289f62ffce54f44b35300afdbf1` includes the separately reviewed strict dependency-input correction. This slice admits POST `/api/patients/[id]/problems` under existing `clinical.visits.document`; plan edit alone does not grant it. A reproduced existing canonical GET problem-list projection defect is corrected in the same patient workflow. No clinician assignment, case creation, native orthodontic lifecycle or financial change is included.

## Acceptance matrix

| Requirement | Implementation | Actual evidence |
|---|---|---|
| Independent documentation authority and patient scope | Exact document action; none refuses, own responsibility proved before and after patient NO KEY UPDATE; current grants and session at the final assertion | Real PG owner/own/all and none/plan-only/unlinked denials; outside and missing identical; built HTTP baseline 401→201 |
| Strict original clinical input | Exact label/site/specialty/caseId keys; reject truncating lengths, forged actor/patient/finance values; shared original normalization | 24 new parser tests; valid clinical text and retained existing specialty behavior |
| Safe optional association | Same-patient case filtering before SHARE NOWAIT; independent ortho view for native/bridged orthodontic case links; no responsibility grant | Hidden/foreign/missing and busy hidden/foreign links indistinguishable; legitimate completed general case allowed; original native/financial/responsibility snapshots unchanged |
| Atomic effect and audit | Extracted original creation/audit body on the admitted connection; no schema initializer or post-commit rich reader | Audit failure and expiry after insertion roll back; real waiting scope changes and identity-fence revocation; inverse-lock refusal |
| Meaning of retries | Two fresh intentional creates remain two records; synchronous UI guard blocks double click; no new text-based deduplication policy | Two actual PostgreSQL waiters; browser double click gives one request/effect; lost committed reply, malformed acknowledgment, reload, unavailable storage and late response |
| Preserve linked-case privacy on both readers | Canonical problem GET now selects explicit original problem facts and masks linked orthodontic case ID/title without independent ortho read; same-patient reference validation and a single existing RR READ ONLY snapshot | Built failing-before witness proved old GET restored a link hidden by the clinical case graph; owner association preserved; foreign retained reference returns sanitized 503; actual concurrent classification/title update cannot split the snapshot |
| Usable current interface | Existing RTL clinical panel; exact independent document control; visible clinical cases only, no old editor fallback | 390px DOM/screenshot, no horizontal overflow, revocation clears data/control, plan-only account cannot create |

The problem's original clinical facts remain governed by the existing care projection; this fix concerns its independently protected **case association**, not a claim that all orthodontic clinical facts are hidden. The legacy GET and POST behaviors remain preserved. The old rich legacy reader is not called by the corrected canonical GET.

There is no durable request receipt. Similar text in the fresh list does not prove which request created a record. The tab marker contains only `pending`, keyed by current user/patient; clinical text is never stored in it. Unknown outcomes are not automatically resubmitted. If storage is unavailable, reload recovery is explicitly not guaranteed.

## Verified local evidence and pending gates

- PostgreSQL 18.6 focused: **94/94 in four files**, including 19 new create/read cases plus problem status, patient directory and original legacy cases. A fixture initially violated the existing completed-at constraint; the fixture was corrected. A later expectation used an internal error name rather than the existing sanitized wrapper code; the assertion was corrected to the actual public contract. Neither product constraint nor sanitization was weakened.
- Unit/map guards: **58/58 in five files** (48 focused unit, 10 map/readiness guards). Separate dependency correction passed23/23 unit checks.
- Final built HTTP/Chromium after the dependency correction: **74/74 across six files**, including 12 new create/read journeys and15 dependency journeys, build `DyLznC2ConMfswaBdRqwY`. Earlier expanded HTTP had 71 passed and one wrong 500-versus503 expectation; corrected standalone create suite 12/12 and final combined 74/74 both pass. The failed attempt is retained.
- Production build and standalone typecheck passed. Full lint and full unit/PG for the final combined source are recorded separately when terminal; they are not inferred from focused success. The first combined full-unit attempt had14,393 passed and one unchanged development-tracing timeout; the isolated unchanged five-test group then passed. No timeout or assertion was relaxed.
- **22 preservation checks and 539 historical source hashes** at pinned revisions. Original legacy creation body, its GET/POST paths, financial writers, assignment helpers, other canonical readers/commands and all migrations are preserved by explicit comparisons.

[Evidence manifest](evidence/work-problem-create-20261101/manifest.json). Current local map: 66 canonical-done / 278 existing within 344 ordinary methods; the wider map 386 and inventory 420 methods /97 pages remain NOT_READY. The GET correction does not count as a newly converted method.

The standalone GET privacy correction remains an activation blocker until final gates and independent review close. Historical43–44 full-unit and full-PG success does not cover it. Exact-head CI, remaining main-integration source review and actual WORK Docker proof are separate gates. Alpine destination refusal remains in force; no bypass, migration, deployment or live change occurred.
