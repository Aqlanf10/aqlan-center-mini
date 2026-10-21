# Visit report and checkout reference repair

## Findings and bounded outcome

Three synthetic witnesses reproduce on Production main:

1. A visit with persisted `visit_procedures` and no `visits.invoice_id` displays no services or specialty. The report reads both exclusively from invoice lines. The repair reads recorded procedures first and uses them for service filtering; invoice lines remain the fallback for older visits without recorded procedures.
2. The clinical component describes a signed null-invoice visit as `بلا فاتورة (كشف)`. Null does not establish consultation, free care, debt, or prior coverage. Both report and clinical page now say `لا فاتورة مباشرة مثبتة`. KPI labels explicitly count direct invoice references, not uncovered work.
3. The standalone visit page discards visit identity after signing by navigating to the generic account tab. It now opens the existing exact-visit checkout URL (`tab=today&checkoutVisit=<signed visit>`), whose reader already refuses silently substituting another visit.

The report accepts a direct invoice only when its persisted ID belongs to the visit's patient and is not cancelled. Coverage is not equated with collection. No source associations, principal, receipts, eligibility, or historical rows are changed.

## Exact baseline and overlap

- Production baseline: `3f7b02b5a6cd31764543f466e3e58a1285f9efc5`.
- Isolated branch: `fix/visit-financial-evidence`.
- Compared #371 head: `af709ae57c5efbb52d70998dac751f3c07df0d7c`.
- Compared composed #379 head: `80a8bea3bc9a4acdb5affa3b5b9876bf35a8788d`.

Neither pending head repairs these visit report/standalone navigation paths. #371 supplies treatment/orthodontic financial-reference readers and historical-document improvements; #379 composes those with unrelated supplier and purchase work. Those changes are not copied here. This branch preserves the actual Production baseline, including its restore security protections.

## End-to-end trace

- Registration (`addVisit` and appointment arrival in `lib/db.ts`) inserts operational visits, without inventing invoices.
- Queue `finishVisit` sets `status='done'` and `finished_at`, and completes an appointment; it does not clinically sign or issue an invoice. A completed report row is therefore not proof that signing/billing ran.
- `signClinicalVisit` classifies procedure sources, progresses treatment sessions, creates invoice lines only for new billable work, and writes signature and direct invoice reference in one transaction. Source invoice lines use `source_type='visit_procedure'` and exact procedure IDs. Existing invoice links may be retained; no-charge/covered work can legitimately produce no new invoice.
- `PLAN_ITEM_PREBILLED_SQL` checks persisted source identity, same-patient invoice ownership, currency, provider and current line identity. `PLAN_ITEM_LEGACY_COVERED_SQL` checks the live agreement and coverage snapshot. These are source-specific authority, not patient/date matching. This change does not replace those predicates or broaden eligibility.
- Generic invoice creation uses `lib/invoice-visit-context.ts` for explicitly selected visits; no nearby-visit inference is appropriate. Existing signing/linkage regressions remain green.
- Clinical GET remains protected by patient access and assistant date restrictions. Its existing direct invoice ID is a documentary reference, not proof of active coverage. No financial payload or permission is added.
- `readVisitCheckout` uses the existing financial snapshot and settlement readers. `TodayVisitTab` retains distinct unresolved coverage and collection states. The route repair now carries exact visit identity into that existing flow.
- Official report print (`app/print/report/page.tsx`) and report API use the same `buildReport` projection. The report fix therefore reaches print without duplicating calculations. Browser print layout remains a hosted CI review requirement.

## Validation

Node 22.23.3; owned disposable PostgreSQL 18.4 on loopback port 55438. No Production database access. The harness-required database name is `aqlan_p1_test` inside that newly created cluster.

Baseline witnesses, before behavioral edits:

- Report integration: 9 passed, 1 failed; recorded service expected, em dash received.
- Clinical component: 49 passed, 1 failed; unsupported consultation label reproduced.
- Standalone route: 1 failed; generic account URL received instead of exact-visit checkout.

After repair:

- Report, explicit invoice-visit context, and new-patient finish integration: 26 passed across 3 files.
- Clinical ownership, checkout owner/review, checkout URL validation, and standalone route: 77 passed across 5 files.
- Report projection, access, export and page unit regressions: 58 passed across 4 files.
- Same-patient/same-day sibling visits remain separate; read leaves the null invoice pointer unchanged. Cancelled and cross-patient direct pointers are not counted as active direct invoices.
- TypeScript and targeted ESLint checked; existing warnings only (unused `TZ`, unused `ReportColumn`, existing hook dependency).
- No local browser was run. Hosted browser/security CI remains required before considering release.

## Explicit unresolved review state

This is a bounded projection/navigation repair, not a complete historical financial-linkage resolver. Missing direct pointers remain unresolved: genuine unbilled work, valid earlier invoice/agreement coverage, intentionally no-new-charge work, and bad historical references require exact persisted source evidence. The supplied private report cannot establish these links, and no patient data or source PDF is included here.

Structured endodontic or orthodontic work without `visit_procedures` is not newly projected as a service by this patch. Existing invoice corrections, old package coverage, historical agreement identity, and mixed covered/uncovered visits require source-specific parity review with #371/#379 before adding a comprehensive visit coverage DTO. Cancellation of an existing documentary reference is not active coverage. No claim is made that these broader API/source cases are fully repaired.

No merge, deployment, migration file, automatic backfill, historical data repair, eligibility change, receipt change, or debt change is included.
