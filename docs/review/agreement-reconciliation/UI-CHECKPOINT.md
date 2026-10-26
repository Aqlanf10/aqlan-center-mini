# Reconciliation UI checkpoint

Standalone base: main dc1be92e. Frozen DTO contracts: 33f8d3d3 / a656a177 (local equivalents af4b061b / 491a6646).

Exact Arabic action: «تسوية الاتفاق». Existing clinic typography/tokens and inline bordered sections retained; no theme/token or global layout changes. Native disclosure and labelled textarea; financial confirmation is pessimistic. Canonical owners: server DTO/route owns monetary truth and permission; existing financial-command IndexedDB journal owns actor/patient command arbitration and retention; component owns scoped inline alert/status; natural document scrolling and global focus styles remain unchanged.

Implemented: complete source preview, nullable unknowns, source invoices, explicit commission impact, reason, exact-once request identity, strict receipt and permanent-refusal proof matching, unchanged command on401/403/409/network loss, source refresh only after proven no-save. Uses shared journal rather than parallel session storage. Account recognizes/reopens pending reconciliation while blocking new financial commands; clinical plans offer entry for active/completed classic installment contracts. Post-conversion collection links to canonical Account source invoices rather than issuing another classic installment invoice.

Validation: 180 focused tests across five files passed, including12 interaction-harness cases and16 DTO/proof cases plus existing ledger/plan suites. Interaction harness exercises real handlers with disposable hooks, not a real browser or PostgreSQL. Initial48 ledger harness failures caused by changed outer Fragment were resolved by preserving existing PatientLedgerContent boundary; assertions unchanged. One initial WebCrypto harness test required event-loop completion rather than microtask-only flushing. ESLint0errors,2 pre-existing warnings in PatientLedger/PatientPlans. Full tsc queued on shared heavy lock; earlier run found only a nullable test fixture access, fixed. No final tsc, build, actual browser, schema/engine integration, or deployed acceptance claim yet.

Required before release: fresh combined source verification, actual IndexedDB two-tab/reload/browser journeys, final backend status/receipt/source adapter integration, PostgreSQL rollback/race/restore gates, full CI and staging acceptance. No live patient mutation or publication.

## Independent review follow-up

00ab722 binds the permanent rejection proof to the full immutable command identity; a second tab replacing an old rejected attempt with a new uncertain attempt cannot inherit its permission to retire. Zero-unbilled adoption permits null commission without inventing a provider/accrual. Independent reviewer reran30/30 focused tests. Full tsc subsequently passed (including the drafted browser suite); actual browser execution remains pending registered combined source.

The additional hosted browser source uses the real application API and IndexedDB: completed classic plan,390/1280 widths, actual POST commit followed by deliberately lost response, reload/status recovery, stale second tab adoption without a second POST, preserved original payment rows and principal exactly once. It is a prepared test, NOT executed evidence. No migration proposal injection is allowed in that suite; official runtime registration must exist first.
