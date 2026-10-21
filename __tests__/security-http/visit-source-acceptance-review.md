# Supplemental visit source acceptance candidate

Base: frozen #383 `1948be2b56cddc7e14b34e1677fcb5dae6bb0635`.
Branch: `test/visit-source-acceptance`. Product files and workflow definitions are unchanged.

All assertions live in `invoice-clinic-continuity-journey.test.ts`, using the existing built-server / isolated PostgreSQL / Playwright harness. No API response is substituted for the new source, clinical, report or print reads.

## Hosted cases to review

- Existing **Endo tooth 36** journey now invokes `sourceAcceptance` after canonical signing: covered procedure plus unresolved endodontic record = mixed, with a null direct invoice pointer. It checks actual clinical-page DOM for four admitted roles, real report JSON, real print-route table cells and generated PDF text.
- **distinguishes a signed unresolved adjustment from an explicit no-charge decision in same-day visits, reader and printed report** creates the case, visits and both signatures through HTTP. Signing records the adjustment and explicit decision; no financial rows are inserted. Exact visit IDs and distinct work keys remain separate; report multiplicities must match both states.
- **renders one valid historical agreement across two same-day signed visits without creating invoices or receipts** creates one historical document through the canonical API with three explicitly scheduled RCT sessions, records consent, stages the exact item through real clinical controls, and signs two visits. Both reference the one agreement. No synthetic invoice, receipt or financial association is inserted.

SQL bootstrap remains limited to synthetic patients, services and the existing harness shift. New SQL statements read persisted identities and nonmutation witnesses. The assistant is created through the users API and authenticates normally.

Doctor and assistant must receive no financial source references and render no invoice/agreement identifiers or links. Admin and reception must receive the exact sources; current invoices render print links, historical agreements render text without invoice links. Cashier/accountant are not admitted to this clinical route; their broader canViewMoney permission does not grant clinical access.

The report has no visit ID column. Tests compare its complete state multiset for the isolated patient, after separately verifying exact clinical/API visit identities; they do not infer associations by patient/date. The print test uses the existing column-selection contract to print patient number, work source, documentary invoice and collection legibly. Both direct-invoice and collection columns must remain unverified/empty despite source coverage.

PDFs are written only from owned synthetic fixtures to `artifacts/visit-source-acceptance/{mixed,same-day-decisions,historical-agreement}.pdf`. Hosted Chromium plus pdfinfo/pdftotext are required. No local browser execution or hosted trigger has been requested.

Suggested bounded hosted selection, only after parent review:

    npm run test:security-http -- __tests__/security-http/invoice-clinic-continuity-journey.test.ts -t 'Endo tooth 36:|Supplemental visit source acceptance'

This is authored acceptance coverage, not evidence of a successful hosted run. Canonical fixture acceptance, browser role rendering and Arabic PDF extraction remain unexecuted until that run. Any product failure must be reported before product changes.


## Reviewed assistant entry follow-up

The standalone visit page remains denied to assistants. The browser suite asserts that redirect, then uses `/patients/{patientId}?tab=today&visitId={visitId}` and asserts the exact selected-visit marker before testing source redaction. Product increment `dbc345ad` verifies only patient/visit identity through the already-permitted clinical GET; no route grant or treatment graph is added.

Real browser negatives pair an allowed synthetic patient file with another allowed patient's exact visit, and request a mixed visit-plus-existing-plan context. Both must leave the selected reader/source panel absent with an explicit context error. The mixed request must not call the graph, clinical or source endpoints. These probes do not establish tenant isolation, real callback/session-switching lifetimes, or old-day browser refusal. This journey has no canonical older-day visit fixture; it does not backdate records or bypass writers to manufacture one. Old-day 403 handling remains unit coverage plus the unchanged server guard.

Print DOM checks summary multiplicities; PDF checks unique summary presence, not complete PDF-row or invoice/collection parity. Hosted runtime evidence remains a separate result from the deterministic hook simulations.
