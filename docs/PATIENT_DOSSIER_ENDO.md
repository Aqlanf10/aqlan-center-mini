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
three files under `patient-dossier-endo-print-ui`; no real patient data, broad
artifact paths, new PDF-parser dependency, or print CSS changes are introduced.
The PDF checks only establish nonempty PDF bytes, a PDF header/end marker, and a
matching saved artifact. They do not verify page count, completeness, or layout.

The journey must execute successfully in CI before release. Download its PDF,
render every page, and review clipping, row/note/addendum splits, continuation-page
patient and clinical-record identity, the final record, and the signature area.
This manual page verification remains pending; neither type checking nor a
screen/print-media screenshot establishes printed-page correctness.

### Existing harness safety prerequisite

The shared HTTP setup recreates the fixed `aqlan_sec_http` database with a forced
drop. Its target-host guard is a separate existing safety gap, not changed by this
test/artifact slice. Before any local run, verify an explicit disposable local
PostgreSQL target and exclusive ownership of that database; a different HTTP port
does not isolate the database from another proof run. The test's database-name
assertion runs after global setup and does not replace that preflight. CI uses its
explicit disposable local PostgreSQL service.
