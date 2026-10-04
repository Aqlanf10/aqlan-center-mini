# Endodontics in the existing patient dossier

The existing `/print/dossier/[id]` now reads the existing patient-scoped
`listPatientEndo` records after the same patient-access guard. No clinical input,
new report source, ledger, plan, or database writes are introduced.

The printed title is a clinical summary and an explicit scope note names its
sources: demographics/alerts, chart history, recent encounters and ENDO records.
It does not represent every specialty record, document or treatment-plan detail.
Any separately permission-gated financial summary is not a financial statement;
this page does not establish financial completeness. An authorized finance read or
balance-derivation failure prints an incomplete-section notice with no fallback
amounts or internal error details. Denied readers see neither financial amounts
nor that notice; valid zero balances still print normally. Ledger calculations and
permission rules are unchanged. Registration-date formatting remains separate debt.

`PatientDossierEndo` is a clinical-only rendering projection. It explicitly copies
case/tooth/visit identifiers, recorded clinical findings, canal measurements and
measurement provenance, doctor/recorder attribution, signed-versus-draft state,
and append-only addenda with their original author and timestamp. It never copies
crown plan item identity/name/status, financial values, plan-derived summaries or
next-action guidance into the print projection. The existing finance section
remains independently permission-gated.

Empty form defaults do not become documented clinical work. Meaningful unsigned
records are visibly marked as drafts. Signed originals remain separate from later
addenda; the record timestamp is labelled as recording time, not signing time.
Clinical record, encounter and addendum identifiers are explicitly distinguished;
each addendum prints its own ID and its parent signed clinical-record ID.
A failed read produces a clear incomplete-section notice instead of claiming that
there are no records. The same incomplete notice applies to a failed chart read,
without printing fallback-zero counters. Empty visit notes are labelled as absent,
not as completed examinations; visit dates use the clinic time zone.

The dossier no longer silently truncates its already-loaded dental history to ten
rows or its visit list to six. Its latest-50 visit source limit is explicitly
printed; this does not claim uncapped lifetime visit history. The chart table is
labelled as history with its existing recording date and linked visit ID, while
the counters remain the current canonical chart summary.

## Verification

- Original dossier route fails the new ENDO/addendum, incomplete-read notice, and
  hidden-history regressions; the patched route passes
- Synthetic unit and actual server-component rendering tests cover ownership
  denial before reads, clinical-versus-financial separation, strict field
  projection, signed originals/addenda, meaningful drafts, empty defaults, valid
  zero findings, canal provenance and source-limit disclosure
- No Production report was generated and no private patient data was exported

This is a print projection of stored findings, not medical interpretation or a
new clinical record. Full app/HTTP/browser validation remains part of release.

## Built-app release gate

`security-http/patient-dossier-endo-print-ui.test.ts` uses the existing isolated
`aqlan_sec_http` harness and a dedicated synthetic patient. It creates/saves/signs
ENDO work and appends a correction through the existing real API routes, then
opens the existing dossier as an owning doctor with plan/finance rights disabled.
It checks original/addendum/draft context, empty-draft omission, lack of plan or
finance leakage, patient isolation and unchanged stored record counts. Eight
distinguishable visit-history notes exercise the removed six-visit cap, alongside
the twelve chart records and explicit upstream latest-50 disclosure. The dossier
response must carry the existing private/no-store and production CSP protections.

After the page and its fonts load, the journey retains the two synthetic
screen/print-media PNGs and generates actual Chromium A4 paginated output at
`.settings-ui-artifacts/patient-dossier-endo-a4.pdf`. CI allowlists exactly these
four files under `patient-dossier-endo-print-ui`, including a 390px RTL mobile
preview screenshot. The mobile proof checks that the ordinary browser Print
button remains visible and inside the viewport, invokes that action using a
synthetic browser callback, and preserves the loaded clinical content. The
paper-sized preview retains its A4 geometry; no real patient data, broad
artifact paths or new runtime/npm dependency are introduced.

### Repeating identity and actual multipage proof

The first CI artifact was visually reviewed: both pages were readable, but page
two had no patient identity. That was a print safety blocker, not a passing visual
gate. The dossier now uses a compact real table header for patient name, file
number and print date. Browser pagination repeats the header and reserves its
layout height on each page, including wrapped names. Patient strings remain React
text; they are never interpolated into CSS. Styles and the named A4 page apply only
to this dossier. Static page/total counters use native CSS margin boxes, supported
in [Chromium 131 and later](https://developer.chrome.com/blog/print-margins).
Other browsers' counter support is not established by this CI.

The normal browser Print path and the test PDF share this DOM/CSS. The test keeps
Playwright's `displayHeaderFooter` off and supplies no PDF-only header template.
Each ENDO clinical record also has its own repeating header containing case,
tooth, record, encounter and signed/draft status. This context must survive when a
single record exceeds one page; making a whole record unbreakable is insufficient.
The fixture uses a valid 114-character patient name and an original clinical note
with 80 distinguishable short lines within the existing 2,000-character limit.
The proof requires that this same record actually spans at least two PDF pages.
CI installs `poppler-utils` from the runner's official package
repositories, then `pdftotext` reads the saved PDF. The proof fails if extraction
is unavailable, fewer than two pages exist, any actual PDF page lacks the
synthetic patient number/name marker or matching native page/total counter, or
any continuation page lacks its clinical-record context. Every clinical line
marker must occur exactly once, and the terminal document footer must be on the
last page. Only synthetic data is
extracted; no text dump or additional artifact is uploaded.

The corrected head `80f554f5aa72005f5ae16da168a014c92ab17c06` passed the complete
CI run `37106351635` on 2026-10-03. All four actual A4 pages were subsequently
rendered and inspected: patient identity and native page counters remained
visible on every page, the signed record retained its continuation context,
all 80 note lines remained readable, and the addendum, final draft and signature
area survived without clipping or overlap. This is evidence for that head only;
latest-main integration still requires its own full CI and fresh artifact review.
Local validation of the integrated candidate used Node 22.23.3: all 20 focused
SSR/projection tests, scoped ESLint and the full TypeScript check passed. The
built-app desktop/mobile/actual-PDF journey remains a full CI release gate.

The browser proof also rasterizes each saved PDF page with `pdftoppm`, reads its
patient-header band through a blank browser canvas, and compares the visible
pixels with page one. The first page must contain visible ink, and every page
must retain the same ink and geometry. This detects a clipped or overpainted
header even when its text remains extractable. Raster buffers remain in memory;
the same four synthetic CI artifacts remain the only uploaded files.

The journey must execute successfully in CI before release. Download its PDF,
render every page, and review clipping, row/note/addendum splits, continuation-page
patient and clinical-record identity, the final record, and the signature area.
Fresh manual page verification remains mandatory after this correction; text
assertions, type checking and screen/print-media screenshots do not establish
printed geometry or absence of clipping/overlap.

### Existing harness safety prerequisite

The shared HTTP setup recreates the fixed `aqlan_sec_http` database with a forced
drop. Its target-host guard is a separate existing safety gap, not changed by this
test/artifact slice. Before any local run, verify an explicit disposable local
PostgreSQL target and exclusive ownership of that database; a different HTTP port
does not isolate the database from another proof run. The test's database-name
assertion runs after global setup and does not replace that preflight. CI uses its
explicit disposable local PostgreSQL service.
