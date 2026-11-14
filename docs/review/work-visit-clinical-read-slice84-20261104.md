# M2 slice 84 — the visit cockpit read and the lab receipt read (2026-11-04)

Design: [visit documentation contract](visit-documentation-contract-design-20261104.md) §2. Group 3, the first slice of the last contract.

## Routes

| Route | Canonical rule |
|---|---|
| `GET /api/visits/[id]/clinical` | `read:patients.clinical` on one owning snapshot; the visit inside the scope by the queue read's condition (all, the clinician's assigned visit, or its patient inside the scope); outside reads like missing (404) |
| `GET /api/visits/[id]/lab-work-command` | one admitted `clinical.lab.order` transaction (legacy: doctor/admin labels); the visit's file inside the scope; the legacy lock order and actor/key try-lock; never creates |

## The projection (owner rule 6615124926)

- The legacy composite runs unchanged on the snapshot (`getClinicalVisitWith`); the canonical read projects it through an **allowlist**.
- **Money group**, only with `finance.invoices.view` or the protected owner (design proposal 3, reversible):
  - line prices and totals; the visit total; billing and plan currencies; the invoice reference; the plan warning;
  - session pricing; the outstanding items' billing and coverage fields; the ortho adjustment billing class;
  - **`labSignVersion`**: a hash over the procedures *including their prices*. The design note did not list it. A price could be recovered from it by trying candidates, so it belongs to the money group.
- Hidden fields are omitted, never zeroed.
- Orthodontic chairside data, and ortho entries among the active cases, need `clinical.ortho.view` (the independent ortho projection).

## Findings fixed in this slice

1. **An unlinked visit could show another file's record.** For a walk-in whose phone matches a file, the legacy composite reads that file's active cases, outstanding plan work and lab context as a preview.
   - On the canonical path, the file contributes only when the reader's scope admits it (`admitPreviewPatient`). Otherwise the visit reads as unmatched.
   - PG test: a clinician's assigned walk-in matching another doctor's patient shows none of that patient's case; the owner still sees the legacy preview.
   - The legacy path is unchanged. Its reach (any role label with access to free visits) is recorded here for the financial/clinical review, not changed.
2. **The composite read two parts outside the snapshot.** The active cases and the case plan items still used the global pool. Both now run on the caller's facade (`listPatientCasesWith`, new `listCasePlanItemsWith`).
3. **The design asked the owner a question the approved map already answered.** Price overrides were already assigned to `finance.discounts.apply` / `finance.discounts.override` / `finance.price-increases.apply`. The design was corrected (`04175751`) and the correction posted on #483 (6628065093).

## Equivalences stated

- **Assistant label, today only.** Legacy refused an assistant label older visits in this read. The canonical read follows the clinical record read already in force since slice 3: the same visit notes are readable in the patient file by a clinical grant. The today-only rule stays where it protects something — documenting (slice 85).
- **The receipt read.** It reads a receipt by the canonical actor's user id. Canonical writes of lab drafts land in slice 85; legacy receipts belong to their legacy actor and remain theirs.

## UI

`/visits/[id]` is registered as a canonical page (pattern-matched, any clinical grant, the patient record scope; nested visit screens stay legacy) and renders `CanonicalVisitClinical` for a canonical account, a read-only cockpit. Prices and totals appear only when the server returns them. Saving and signing are not yet enabled on the canonical path (85, 86).

## Tests

| Gate | Result |
|---|---|
| PG `visit-clinical-canonical` | 8/8 (owner = legacy composite exactly; money omitted for a clinician; invoice view and ortho view; scope; walk-in preview; receipt found/absent/other actor/hash conflict/scope/grant) |
| Legacy PG touching the refactor | 30 files, 295/295 |
| Related unit suites | 21 files, 328/328 |
| Journey `canonical-visit-clinical-journey` (portOffset 142) | in the batch gate |
| tsc, lint | clean |
