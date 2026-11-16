# Pending laboratory prescription completion — bounded repair

## Implemented foundation

- The patient laboratory card and laboratory module expose **استكمال الإرسالية** for a pending (`needed`) request.
- Complete or revise the same request with an explicitly selected active registered laboratory, standardized shade, tooth roles, optional stump shade, due date, priority and impression type.
- **حفظ المسوّدة دون إرسال** permits incomplete lab/shade/tooth fields and keeps it pending. Dispatch requires complete validated values. A separate confirmation records actual dispatch; it does not message the laboratory.
- Clinical specification editing is restricted to admin/doctor, matching signed-visit procedure-edit authority plus patient ownership. Reception/assistant/accountant cannot use the all-fields writer; a separate operational-only command is not inferred from read access. No new permission is invented. This temporarily means reception cannot complete/dispatch a pending order through this all-fields command; operational-only authority remains separate.
- The writer locks the existing row, revalidates the live session and checks patient access inside the transaction, checks a clinical-metadata snapshot, locks the selected active laboratory, updates only prescription metadata, and appends actor-attributed tracking plus transactional before/after clinical audit. Auto-origin prescriptions must retain the original source tooth and compatible work roles; independent single-tooth work cannot be merged through this editor. It never inserts a second order, changes source/visit/tooth/doctor provenance, guesses prices or writes payables. A financially linked provider reassignment is refused.
- Bare `PATCH {status:'sent'}` is refused for pending requests: use the reviewed completion command. Other existing lifecycle transitions are unchanged.
- A pending request no longer claims its placeholder date is a dispatch date. A posting-setting flag alone no longer displays a posted liability badge: a payable link is also required.
- Preview and external print reuse the existing canonical anatomical tooth cells. An unknown role is shown neutrally and explicitly, never inferred as crown/abutment. Primary teeth are included when present. External projection still excludes patient demographics and internal free text; QR still contains only the order reference.

## Deliberately not implemented by this foundation

The requested unified data entry **inside Today Visit and invoice creation** remains a separate source-composition change. This repair does not pretend that a laboratory-module editor alone fulfills it. It does not migrate/backfill old source links, enable invoice-driven lab creation, or alter signing/billing semantics.

Current exact edges available for that next change:

- `invoice_items.source_type='visit_procedure'` + `source_id` identifies the signed visit procedure exactly.
- Planned execution and billing share explicit `plan_item_id` links.
- Current auto lab rows retain `visit_id` and `tooth_code`, but lack an exact persisted procedure/work-item link. Existing cross-session suppression is not a sufficient universal identity for invoice/visit composition.

Proposed next gate (design, not migrated): persisted canonical request identity and exact typed source links with database uniqueness and patient ownership checks; shared clinical fields in both originating forms; pending incomplete drafts; transactional idempotent materialization/reuse at source commit. Never deduplicate using service, tooth, description, amount or temporal proximity. Legacy requests require explicit reviewed lineage rather than guessed backfill. Migration 0073 is separately reserved for agreement clinical authorizations and is not reused or changed here.

An early `ROW EXCLUSIVE MODE NOWAIT` lab-table lock is acquired before row/ownership locks to avoid waiting in the reverse order of the separately composed clinical-authorization boundary. Broader origin integration must also add lab-link correction/substitution protection to `invoice-revision-db.ts`; current financial correction safeguards alone do not establish that dependency.

## Evidence and remaining acceptance

- Regression-first: pending external date and unknown-role diagram tests fail on baseline and pass after repair.
- Focused unit/component/API/privacy tests and actual PostgreSQL integration cover same-ID updates, financial/provenance invariance, concurrent dispatch, stale data, inactive lab and unauthorized roles.
- Local typecheck and targeted lint run separately. PostgreSQL uses a fresh owned loopback-only synthetic cluster, stopped after testing.
- Browser interaction, focus/scroll, RTL tooth orientation, A4/A5 pagination and PDF glyph/layout validation remain required on the composed deployment. No deployment or real/Staging patient mutation is part of this source repair.
