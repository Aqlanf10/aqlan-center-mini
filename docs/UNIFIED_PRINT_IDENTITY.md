# Unified print identity — migration and acceptance ledger

## Authority and boundaries

Owner requested the approved installment-contract design across all system printouts and statements on 2026-10-29. Implementation base is published-main content tree `fb2ad454f692e59b302be798dde7c49efb7da6ce` (local source-equivalent proxy `355a5643`, remote main `b5540169`). This is presentation only; no migrations, DB mutations, financial recalculation, permission expansion, new AI/Dot features, main merge or deployment.

Canonical owners: `PrintHeader` / `PrintFooter` → configured center identity; `ReportPrintHeader` / `ReportPrintIdentity` / `ReportPrintFooter` → client adapters; `PrintMetadata` → compact paired fields; `PrintTableFrame` → table pagination and screen fallback; `PrintDocumentWatermark` → exactly one body-owned official-logo image at opacity 0.15 per printed page; `print-document.css` → scoped layout; `PrintReportModal.module.css` → selected-modal print isolation. Agreement renderer content is unchanged; `print.css` changes only the decorative watermark sizing following the owner’s later correction.

## Route coverage (25)

| Route under `/print` | Renderer migration | Preserved variant / boundary |
|---|---|---|
| `card/[id]` | Shared identity/footer, paired metadata | A6 appointment card; existing operator paper selection |
| `patient-card/[id]` | Shared identity/footer, paired phone/date | A6 large patient identifier retained |
| `receipt/[id]` | Shared identity/footer, paired ref/date | A6 amount, native currency/rate/equivalent, provenance and reprint unchanged |
| `voucher/[id]` | Shared identity/footer, paired ref/date | A6 payout/FX/signatures unchanged |
| `prescription/[id]` | Shared identity/footer, paired patient context | A5 allergy, dosing, stored prescription semantics retained |
| `referral/[id]` | Shared identity/footer, paired reference context | A5 urgency/clinical text retained |
| `post-op/[id]` | Shared identity/footer, paired patient context | A5 instructions unchanged |
| `walkout/[id]` | Shared metadata and table frame | A5 review-required and per-currency meanings unchanged |
| `shift/[id]` | Shared metadata and table frame | A5 Z-close totals unchanged |
| `invoice/[id]` | Shared metadata and table frame | A4 stored rows/discount/net/ref/signatures unchanged |
| `statement/[id]` | Shared metadata; invoice, historical, receipt frames | Current snapshot and date-bounded report branch retained |
| `family-statement/[id]` | Shared metadata/table frame | No cross-currency netting |
| `party/[id]` | Shared metadata/two table frames | Existing per-currency payable/receivable accounting unchanged |
| `plan/[id]` | Approved agreement layout retained; fixed page watermark; historical reference uses shared metadata | Ordinary, saved-version debt, historical, invoice-backed and unavailable branches unchanged |
| `consent/[id]` | Shared patient metadata/header/footer | Signed stored wording, signatory/date/signature and refused/blank boundaries immutable |
| `dossier/[id]` | Shared patient metadata/data-table frames | Outer repeating-identity pagination table and clinical drawings excluded |
| `ceph/[id]` | Shared metadata/measurement-table frames | Tracing SVG, anatomy, diagnosis and semantic colors unchanged |
| `ceph-compare` | Shared metadata/measurement frame | Comparison calculation/clinical meaning unchanged |
| `lab/[id]` | Paired external context, technical table frame, subtitle spacing | External DTO, name policy, QR reference, warnings and anatomy unchanged |
| `commission-statement/[id]` | Shared metadata/table frame | Existing landscape columns/financial provenance retained |
| `hr/staff` | Shared paired context/table frame | Existing landscape terms snapshot and labels retained |
| `hr/tasks` | Shared paired context/table frame | Existing scope/status/row count preserved |
| `hr/contracts/[id]` | Shared A4 body/metadata/signature grouping | Saved contract clauses/addenda and draft/approved labels retained |
| `hr/payroll/[id]` | Shared wide body/metadata/table frame | All ten columns and approved payroll snapshot retained; landscape named page |
| `report` | `PrintableReportDocument` shared metadata/table frames | Selected columns/order/groups/filters unchanged; landscape at >=8 columns |

## Other printed families

| Surface | Migration status | Variant / verification boundary |
|---|---|---|
| `/report` operations/appointments/chairs/lab/tomorrow | Shared client header/footer/metadata | Existing screen and paper content scope unchanged |
| `/finance/reports` | Shared client header/footer/metadata | Existing cards/lists, amounts and filters unchanged |
| `/reports/daily-clinic` | Shared identity/metadata; all 14 table bodies framed | Summary/full/reference/per-currency appendix semantics unchanged |
| `/reports` → `ReportView` / `PrintFrame` / `DataTable` | Shared identity/metadata, normal-flow footer and print-only table frame | Ctrl+P fallback; explicit print still goes to official route |
| Expense budget modal | Shared identity/metadata/footer/table frame and isolated paper scope | Ten columns, landscape; no sibling/offscreen data |
| Lab accounting audit modal | Shared identity/metadata/footer/table frame and isolated paper scope | Nine columns, landscape; print truncation removed |
| Lab pricing modal | Shared identity/metadata/footer/table frame and isolated paper scope | Six columns, portrait, existing lab/category scope retained |
| Inventory doctor custody | Shared identity/footer, compact record-list variant | Existing location/lot rows retained; no invented table projection |
| Inventory valuation | Shared identity/footer/metadata, record-list variant | Unknown/estimated costs and full print list preserved |
| Procurement administration | Shared identity/footer/metadata, record-list variant | Selected request + approval only |
| Procurement operations | Shared identity/footer/metadata, record-list variant | Selected order / receipt / invoice-matching only |
| `LabPrescriptionModal` | Shared identity adapter only | Remains non-printable preview; canonical `/print/lab` link unchanged |

## Report engine coverage (35 source-routed outputs)

All below delegate to the same `PrintableReportDocument`; this is source coverage, not a claim of 35 individual visual witnesses:

`daily`, `monthly`, `annual`, `debt`, `aging`, `specialty`, `doctor`, `doctor-commission`, `plan-double-billing`, `pre-system-receipts`, `ortho-duplicate-adjustments`, `commission-detail`, `internal-referrals`, `chair-flow`, `collections`, `services`, `visits`, `appointments`, `treatment-plans`, `lab`, `inventory`, `suppliers`, `recall`, `patients`, `patient-statement`, `practice-overview`, `provider-utilization`, `chair-utilization`, `appointment-performance`, `plan-intelligence`, `unscheduled-treatment`, `lab-intelligence`, `new-patient-intelligence`, `recall-intelligence`, `practice-trends`.

## Export and immutable exclusions

- Styled `labAccountingExport.ts` and `expenseBudgetExport.ts`: palette-only changes inside SpreadsheetML `<Styles>`; twelve baseline typed-cell golden checks across YER/SAR/USD and empty/populated fixtures. No unsupported logo watermark or new metadata rows. Existing page settings retained.
- `report-export.ts` data-only XLS and all CSV exports unchanged, including escaping/injection guards and exact cell types.
- Uploaded PDFs/images/documents, attachments, messages, SQL/tar backups and signed archived bytes unchanged.
- No thermal implementation exists; receipts/vouchers/cards remain documented A6 layouts. A6/A5 automatic paper selection is intentionally not introduced: existing operational printer choice remains authoritative.

## Verification ledger

See local task evidence for exact command logs; committed tests are reproducible without live data.

- Historical checkpoint before the 14:04 owner correction: approved 24-row agreement PNG was pixel-identical in WeasyPrint70. The subsequent fixed-size logo request intentionally changes only decoration; six columns, three paired rows, text and financial layout remain the regression anchor. Hosted Chromium now checks fixed physical size across 1/2/4/6/12/24/36/60 rows.
- Actual-route synthetic SSR: invoice 5/90 rows, missing logo, current statement, external lab privacy/QR/anatomy, receipt A6 and A4-stock, empty/75-row landscape report; native currencies preserved and input objects immutable.
- Long-table AST audit: data-table bodies/totals retain their existing source expressions. Table children are byte-identical except numeric header alignment in `PrintableReportDocument`, print-only overflow/whitespace classes in interactive `DataTable`, and the outer dossier pagination table containing newly framed nested tables. No financial row/column projection changes.
- Styled XLS typed-cell golden checks preserve values/types/escaping/order; calculations and code outside `<Styles>` byte-identical.
- `unified-print-document.test.tsx`: new hosted Chromium/PDF RTL, missing-logo, 100-row pagination, repeated headings and totals-once acceptance. **Not run locally**: local browser launch is unavailable; no sandbox bypass.
- HTTP/security browser suites and Staging print-dialog acceptance remain **not run for this local candidate**. Local SSR/WeasyPrint cannot substitute for these gates.
- Full-project premium static audit reports the same 71 existing findings on baseline and candidate (41 unresolved ownership +30 form violations); no new findings. Existing app-wide form/select debt is outside the print-only scope.

### Local candidate checkpoint (2026-10-29)

| Check | Actual result |
|---|---|
| Focused unit/SSR/financial/privacy/export regressions | **25 files / 310 tests passed**; supplementary print/identity checks **6 files / 63 tests passed** (overlapping files; do not sum as unique tests) |
| Source-only TypeScript (`app`, `components`, `lib`, Next config/proxy) | **Passed** with Node 22, `noEmit`, `incremental: false`; excludes test/scripts/generated route types, not a full-project pass |
| `next typegen` | **Passed** |
| Changed/new TypeScript/TSX scoped ESLint | **0 errors**, 5 existing warnings (lab image suppression and four unused expense-export variables) |
| Full-project TypeScript | **Blocked locally**: initial low-heap OOM and serialized 3072 MiB runs killed by OS (exit 137), including after type generation; no diagnostic-free pass claimed |
| Production build | **Not run** after confirmed local resource limit; required hosted CI gate |
| Chromium/PDF, HTTP/security browser, PostgreSQL and Staging | **Not run locally**; no browser/sandbox workaround, no clinic DB used |
| Historical 24-row contract anchor (before 14:04 correction) | **Pixel-identical** at that checkpoint; later owner-requested fixed-size watermark intentionally supersedes decorative pixel equality |
| Long independent PDF witnesses | Invoice 90 rows: 4 pages; report 75 rows: 4; expense modal 80 rows: 6; lab-accounting modal 80 rows: 6; repeated table headers and end totals preserved |
| Compact-paper witness | Receipt on operator-selected A4 stock: 1 page; explicit A6: 2 pages both before/after (existing sizing behavior, not forced onto one page) |

Pixel-inspected synthetic samples cover current statement, invoice/header and long invoice, missing logo, receipt on A4/A6, external lab dispatch, empty/long landscape report, and all three report modals (first/last pages). Other route families and all 35 report types have source coverage and focused semantic checks, **not** individual visual/browser acceptance. Inventory record-list, HR, clinical forms and daily report variants still require representative Staging print review.

Wide-family orientation is intentional: ten-column payroll and expense budget, and nine-column lab-accounting audit use document-scoped named A4 landscape pages for readable full columns; lab pricing retains named A4 portrait. No anonymous `@page` is introduced by the modal stylesheet, so an inactive wide variant cannot change another document's page choice. A6/A5 operational paper choice remains untouched.

Evidence is retained outside the public repository in `unified-print-evidence-20261029/`: command logs, source-only typecheck config, before/after HTML/PDF/PNG, render manifests, typed-cell and table-content audits, premium baseline delta, and frozen owner previews with hashes. Fixtures are synthetic; no real patient data is included. Owner-delivered preview files are immutable copies; any later corrections use separately versioned previews.

## Rollout and remaining gates

Owner requested images **before upload** and then identified missing central logos on non-table documents. Corrected receipt, prescription and appointment-card previews were delivered. On 2026-10-29 at 13:47 UTC the owner approved the corrected previews and authorized publication and a Production exception for this print-only update **after successful build/CI**. This does not authorize unrelated numbering/clinical branches. Full typecheck/build/required CI and independent review remain release gates; local WeasyPrint is not browser acceptance. Keep row/column/filter/currency/provenance/consent/privacy checks coupled to visual acceptance. Do not call all surfaces visually verified merely because they share a primitive. Revert this presentation changeset as a unit if browser pagination or CSS-order regression appears; there is no schema/data rollback.

## Owner-requested watermark completeness correction

- Plain receipts/vouchers/cards, prescriptions/referrals/post-op forms, consent, HR contracts, reference-only plan branches, finance cards and inventory records now use the same root logo as table reports. Presence follows their existing `PrintHeader` identity; no new data lookup or permission path is introduced.
- Fixed-page image positioning covers continuation pages, not the aggregate center of a long table. Print CSS hides ordinary `PrintTableFrame` decorations while the singleton owns the page, so multiple tables or multiple lab sections do not double the logo. The image remains an actual `<img>` when print-background graphics are off.
- Latest owner correction at 14:04 UTC requires contracts to have a large constant logo regardless of installment count. Both ordinary and saved repayment agreements now use the body singleton (76 × 65 mm frame on A4); their old table mark is hidden in print. Screen fallback has the same fixed dimensions. Opacity remains 0.15, six columns/three paired rows and all financial/terms/signature source content remain unchanged.
- Compact A6/A5 centering refers to the logical sheet on larger operator-selected stock; no automatic small-paper selection was added. Normal reports center within each page. Protected QR, actual saved-signature images and clinical regions remain above decoration with opaque backing; empty signature rows remain transparent to avoid slicing the logo; reprint warnings remain above the logo.
- There is no existing configurable logo visibility setting in the reviewed print source. The singleton uses the existing `/logo.png`; empty source/failure removes the image and never invents a replacement. Archived bytes, signed wording and signature URLs remain unchanged.
- Legacy styled SpreadsheetML `.xls` cannot carry this image watermark without a format migration. Its HTML print counterparts are covered; no silent `.xlsx`/engine migration, CSV modification or raw-file rewrite is included.
- Correction-focused local regression: 17 files / 185 tests passed; additional fixture suites cover 18 non-table cases and 6 report-family cases (overlap those totals). Exact final render/page-image counts and scoped lint logs are retained in `unified-print-watermark-evidence-20261029/`; `delivery-1345/` contains immutable owner-reviewed before/after copies. Hosted Chromium now checks one actual logo paint on every PDF continuation page, no old table duplicate, and backgrounds-off behavior. Hosted execution remains required; no local Chromium claim.

## Fixed-size contract watermark correction (14:04 UTC)

The owner’s private four-installment print photo was inspected only as a visual reference and is excluded from source, artifacts and uploads. Synthetic 4/6/12/24/36/60 installment fixtures verify constant physical logo dimensions, repeated page coverage, exact row retention and unchanged text geometry. The previous table-relative `height: 80%` behavior was the root cause. No financial calculations, agreement wording, signatures, density profiles or paper selection are changed. This is a bounded follow-up to the approved print update, not a redesign.

Fixed-size correction local evidence: 3 focused files / 49 tests passed, changed test files lint clean, and seven synthetic contract variants rendered with WeasyPrint70. All pages measured one large logo of 76 mm physical width (65 mm contain frame), with identical before/after non-decorative word coordinates; 60 rows remained two pages and the other fixtures one page. Frozen 4/24/60 previews are in `unified-print-contract-fixed-20261029/delivery-1419/` outside git. Empty signature-row backgrounds are transparent so they do not cut the logo; actual signature image/QR/clinical protection remains opaque. Hosted browser proof is still pending CI. Corrected inventory fixture pixels exposed a nested RTL metadata grid collapse; the narrowly scoped inventory print owner now uses a block wrapper around its unchanged two-column definition list.
