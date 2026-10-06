# INV-LINK — Invoice-first clinical linkage (audit, design, lineage contract)

Status: design for PRs B–D. Measured on `main` @ `ea312ad` (2026-10-06). Older docs were not trusted as a
description of `main`; every statement below was re-read from code.

## 1. Audit — how the two entry points behave today

| Path | What it writes | Clinical effect |
|---|---|---|
| `POST /api/invoices` → `createInvoice` (`lib/db.ts`) | `invoices` + `invoice_items` (service_id, doctor_id, description, qty, price). No `source_type/source_id`, no plan/case, no idempotency key. Price authority via `checkInvoiceAuthority` (FIN-4); description forced from the catalog when a `serviceId` is chosen. | **None.** An ortho or RCT invoice leaves no plan item, no case, nothing in the specialty tab. |
| Visit → `visit_procedures` → `signClinicalVisit` | One transaction: procedures, invoice lines with `source_type='visit_procedure'`, chart, plan-item sessions, lab, materials, ortho session. Linked lines (`plan_item_id`) are priced from the plan via `classifyLinkedProcedureLines` → `loadPlanItemsForPricing`, which requires the plan `active`, **consented**, and the item `planned/in_progress`. BILL-1: a plan funded by an installment agreement classifies sessions `INCLUDED` (not invoiced). | Bills clinical work; double billing of a procedure is stopped by the unique partial index `invoice_items_source_uniq (source_type, source_id)`. |
| Plans (`createPlanV2`, `addPlanItem`, `recordPlanConsent`) | `treatment_plans` + `plan_items` (`billing_rule`, `billing_status ∈ unbilled/billed/included_in_package/waived`, `session_count`, `case_id`). `canEditItems` refuses edits once consented: "وثّق المستجدّ بخطة جديدة". | The agreed treatment. `billing_status = 'billed'` exists in the type but **no code path sets it today**. |
| Cases (`clinical_cases`, CASE-MODEL-1) | Generic specialty case (`specialty`, `site`, `responsible_party_id`, status machine). `plan_items.case_id`, `visits.case_id`. Ortho bridges to `ortho_cases` via `ortho_case_id`. | Specialty context. |
| `invoices.plan_id` | Used by payments/installments (BILL-1 targeting). | **Must not** be set by invoice-first: it would change payment semantics. |
| Cancel / correct (`setInvoiceStatus`, `correctInvoice`) | Cancel flips status; correction cancels + reissues lines **without** `source_*` (the cancelled original keeps the source so the source is never billed a third time). | Clinical records are untouched today. |

Conclusion: the gap is real — a treatment invoice has no clinical identity, and nothing prevents the visit
from billing the same work again.

## 2. Source of truth

**The plan item is the canonical work identity** (agreed treatment, priced, consented). The invoice line
points at it; the case gives it specialty context; the visit consumes it. `invoice_items` is never the clinical
origin.

```
Patient → Treatment plan → Plan item ──case_id──→ Specialty case
                               ▲    └─billed_invoice_id──→ Invoice (financial link)
invoice_items(source_type='plan_item', source_id=item)     (lineage; unique ⇒ never sourced twice)
Visit(case_id) → visit_procedures(plan_item_id=item) → sign → progress; no second invoice if pre-billed
```

## 3. Lineage contract (additive migration 0041)

| Column | Meaning |
|---|---|
| `invoice_items.source_type='plan_item'`, `source_id` | The invoice line bills that plan item. Existing unique index guarantees one sourcing line per item, ever. |
| `plan_items.billing_status='billed'` + `plan_items.billed_invoice_id` | The item is financially accepted ("pre-billed") by that live invoice. Cleared on cancellation; moved to the replacement on correction. |
| `plan_items.origin`, `plan_items.origin_invoice_id` | Who created the work identity: `plan` / `visit` / `invoice` (+ which invoice). NULL = pre-existing rows (unknown). |
| `clinical_cases.origin`, `origin_invoice_id` | Same for cases (`clinical` / `invoice`). |
| `invoices.idempotency_key`, `idempotency_request_hash` (unique key) | Same pattern as `payments`: a retry replays, a different body with the same key is a 409. |

Questions answered by the contract: who created the treatment (`origin` + audit actor), who created the invoice
(`invoices.created_by`), which plan item / case (`source_id`, `case_id`), is it pre-billed and by how much
(`billed_invoice_id` + the line naming it through `invoice_items.plan_item_id`), and does the current visit
execute it (`visit_procedures.plan_item_id`).

## 4. Rules (PR B — transactional linkage inside `createInvoice`)

1. **Classification per line** (pure, `lib/invoice-clinical-linkage.ts`): no `serviceId` ⇒ financial-only (text is
   never parsed). Catalog category ⇒ clinical or financial-only:
   `ortho→orthodontics`, `rct→endodontics`, `post/crown/bridge→prosthodontics`, `implant→implantology`,
   `cleaning→periodontics`, `extraction/surgery→surgery`, `veneer/whitening→cosmetic`,
   `filling/sealant→restorative (plan item, no case)`; `consultation`, `xray`, unknown ⇒ financial-only.
   Pediatric is not inferred (no category carries it).
2. One transaction, patient row locked (serialises two tabs / concurrent posts), idempotency key checked first.
   The fingerprint covers everything persisted from the request (patient, currency, discount, note, and per line
   service/description/quantity/price/doctor/tooth/case/sessions); the same key with any other body ⇒ 409.
   **Cross-entry serialisation:** candidate plan items are locked `FOR UPDATE` and their eligibility is re-read in a
   new statement after the lock wait — the same item lock `signClinicalVisit` takes — so an invoice and a visit
   sign-off cannot both treat one unbilled item as billable. Lock order everywhere is *plan item → invoice*:
   sign-off locks the item then share-locks its covering invoice; cancellation and correction lock the invoice's
   billed items before the invoice itself.
3. **Find, then create.** Reuse an existing item only if it is an *exact compatible open item*: same patient,
   service, tooth, currency; plan active + consented + not funded by an installment agreement; item `planned`,
   `unbilled`, no sessions done, not already sourced by an invoice line; **and the same work shape**: same total,
   same quantity, no surfaces (the invoice carries none) and, when the line states a session count, the same
   session count. Different total ⇒ `amount_mismatch`; same total but a different shape ⇒ `shape_mismatch`; more
   than one exact match ⇒ `ambiguous_item` (all refused, fail-closed, Arabic message) — the price or shape of
   agreed work is not silently changed, partial coverage is not assumed, and no item is picked arbitrarily.
   A `caseId` that differs from the reused item's case ⇒ `case_mismatch` (the invoice never moves an item between
   cases).
4. Otherwise all new clinical lines of the invoice go to **one new plan** (one master plan per invoice, never one
   per specialty), consented at creation with an explicit note "قبول مالي بالفاتورة … — التقييم السريري لدى
   الطبيب" — consistent with `canEditItems` ("المستجدّ بخطة جديدة"). Session count comes from the request, else
   the specialty template step for that category, else 1.
5. **Cases.** Specialties that need a case reuse the patient's single open *compatible* case of that specialty
   (or the `caseId` supplied per line). For tooth-bound specialties (endodontics, prosthodontics, implantology,
   surgery) a case is compatible only if its `site` is empty or names the line's tooth — an RCT on 36 never joins
   the open endodontic case of 11; whole-mouth specialties (orthodontics, periodontics, cosmetic) match by
   specialty. None ⇒ a minimal shell `«<تخصص> — تحتاج تقييم سريري»` with `site = tooth`, `origin='invoice'`, no
   responsible doctor, no problem text; more than one compatible open case and no `caseId` ⇒ refused (never
   guessed). Lines of one invoice share a case per specialty, and per tooth for tooth-bound specialties.
6. **Nothing clinical is invented.** Ortho: no `ortho_cases` row, no wires/appliance/diagnosis/ceph — the
   clinical case says "needs clinical assessment" and the doctor's intake bridges it later. Endo: no
   `endo_treatments`, no diagnosis, canals or working length. Prostho: no lab order (labs stay at the clinical point).
7. Audit in the same transaction: `plan.create`, `plan.item_add`, `case.create`, `plan.item_case`, plus the route's
   `invoice.create` with the linkage summary.

## 5. Sign-off containment (PR C)

`loadPlanItemsForPricing` adds "pre-billed by a live invoice". A linked session of such an item classifies as
included (no invoice line), progress/session/provider still advance; procedures stay clinically recorded. Ortho
adjustments on a case whose plan item is pre-billed classify as included (same as an installment-funded package).
Anything not clearly covered stays on the existing path (fail-closed: `NEW_BILLABLE`/`OUTSIDE_CONTRACT` decision),
never a guessed zero.

## 6. Corrections

Cancel ⇒ clinical records untouched; the item's financial link is cleared (`billing_status='unbilled'`,
`billed_invoice_id=NULL`) and audited — the UI shows "الفاتورة أُلغيت — يحتاج مراجعة مالية". Correction
(cancel + reissue) ⇒ items whose line survives move `billed_invoice_id` to the replacement; items whose line was
removed are cleared as on cancel. No delete, no re-pricing of history, no linking of old invoices to new plans.

**Line lineage across corrections.** The unique source (`source_type='plan_item'`, `source_id`) stays on the
original line, which keeps its history after cancellation. Every invoice line also carries
`invoice_items.plan_item_id` (migration 0041): written with the original line and **copied to its replacement**
on each correction. Kept items, duplicate service lines and changed quantity/price are resolved line by line from
it, and a second or third correction keeps the link on the newest live invoice. A corrected line with a lower
price still covers its item (the admin's correction reason and the `invoice.correct` audit record the change).

## 7. UI (PR D)

Invoice form: a read-only preview per clinical line (service, specialty, existing/new plan item, existing/new
case, amount/currency) — "سيتم الربط بالحالة الموجودة" / "سيتم إنشاء حالة أولية تحتاج تقييم الطبيب". Patient
file: the item in Plans, the case in Cases/specialty tab, the invoice in Account, next action "بدء التقييم
السريري — <تخصص>" instead of "إنشاء خطة". Browser journeys for the scenarios below.

## 8. Test scenarios (PG18 + HTTP + browser)

1 Ortho 300,000: 1 invoice, 1 item, 1 case, visible; visit uses the item; sign creates no invoice #2.
2 Endo RCT #36: case appears; no diagnosis/canals; visit completes the same item.
3 Crown #36: plan/case created; **no lab order** from the invoice.
4 Cancellation after case creation: case preserved, financial link cleared, nothing deleted.
5 Retry / double click / two tabs / concurrent: one invoice, one item, one case.
6 Mixed Ortho + Endo + Crown: one plan, three items, cases per specialty, one patient ledger.
Plus: same service different tooth ⇒ two items; two open cases of one specialty ⇒ refused without `caseId`;
amount mismatch with an exact open item ⇒ refused; line without `serviceId` ⇒ financial-only.

## 9. PR split (as delivered)

B and C ship in **one PR**: linkage without sign-off containment would leave a double-billing window (a visit on a
pre-billed item would invoice it again), so they are not separable safely. Implemented: `lib/invoice-clinical-linkage.ts`
(pure), `lib/invoice-linkage-db.ts` (`createLinkedInvoice`), `insertPlanV2InTx` (plan creation core shared with
`createPlanV2`, behaviour unchanged), `PLAN_ITEM_PREBILLED_SQL` in the sign/preview pricing, walkout and
`ORTHO_CASE_FUNDED_SQL`, cancel/correct link maintenance. Additional refusal found while testing: the same
service+tooth already pre-billed by a live invoice and not started ⇒ `already_billed` (two tabs with different keys).
Audit-detail keys avoid the sanitizer's secret pattern (`سر`).

## 10. Original split

A (this doc) · B migration 0041 + pure classification + transactional linkage + idempotency + cancel/correct
link maintenance, PG18 + HTTP · C sign-off containment · D invoice preview + patient-file surfacing + browser
journeys. Each PR ends `READY_FOR_DOT_REVIEW`; merge, deploy and production verification are Dot's.
