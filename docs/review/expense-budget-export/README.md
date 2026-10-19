# FIN010 — filtered expense workbook totals

Baseline: `8bcab4f74ed3454bcb3bf6bbf72477dc0d1d4ee9`.

## Independent reproduction before application edits

The real `exportExpenseBudgetToExcel` writer received one synthetic category with budget 100 and actual 40, alongside a stale global summary with budget 1000 and actual 600. Its actual output Blob was saved as Excel XML Spreadsheet 2003 (`.xls`) and parsed with Chromium's XML DOM parser, respecting merged cells and explicit column indices.

| Workbook cell | Baseline | Repaired |
| --- | ---: | ---: |
| Exported detail, budget column G | 100.00 | 100.00 |
| Total row, budget column G | 1000.00 | 100.00 |
| Total row, actual column H | 600.00 | 40.00 |
| Total row, variance column I | 400.00 | 60.00 |

The [baseline workbook](evidence/baseline-filtered.xls.gz), [repaired workbook](evidence/repaired-filtered.xls.gz), and their parsed cell JSON files are retained. Decompress the `.xls.gz` files to inspect the exact original workbook bytes (including writer whitespace). All content is synthetic. The baseline workbook suite had 12 failures; the caller contract suite had 10 new failures with 16 existing tests passing. Caller failures explicitly show both components supplying the unrelated global summary alongside their filtered selections.

The workbook regression was initially run with the unit test configuration for reproduction. It now resides under `__tests__/security-http/` because CI installs Chromium for that suite, not the unit job. The final suite adds an all-data preservation case.

## Narrow repair

The exporter owns its summary and computes it from exactly `categories`, the rows it writes. Neither caller can supply a separate global summary through the export interface. The manager's global on-screen summary, permission gates, database readers and accounting entries are unchanged.

Budget, actual, variance, expense count, over-budget count and the percentage denominators now refer to the same exported selection. Ratios are calculated from aggregate amounts and rounded using the existing report convention, not averaged from row percentages. Empty results produce zero totals. With zero aggregate budget, consumption remains 0; variance percentage remains 100 for positive actual, otherwise 0, matching existing report semantics. Negative actual values and over-budget negative variances are retained.

An exported inactive row still carries its budget cells, so its amounts now contribute to the workbook totals too. The over-budget count's denominator is the exported row count. All-data exports still contain every input row; when the original full summary represented those same rows, amounts and ratios remain identical. This intentionally fixes the prior mismatch for inactive rows whose displayed budgets were excluded from the global summary.

Currency formatting still uses the supplied base currency and its existing `MINOR_UNITS`: YER, SAR and USD are covered. No conversion, exchange-rate selection or row-currency reinterpretation was added.

## Verification commands

With Node 22, configured disposable local `TEST_DATABASE_URL`, and Playwright Chromium installed (or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`):

```sh
npm run build
npm run test:security-http -- __tests__/security-http/expense-budget-export.test.ts __tests__/security-http/expense-catalogue-visibility-ui.test.ts
npm test -- __tests__/expense-catalogue-manager.test.tsx __tests__/expense-budget-modal-export.test.tsx __tests__/expense-catalogue-visibility.test.ts __tests__/expense-catalogue-route.test.ts __tests__/expenses.test.ts
npm run typecheck
npm run lint
npm run scan:money
```

Candidate verification: **22 Chromium workbook/HTTP/UI tests passed** (13 workbook cases and 9 existing expense catalogue UI cases); **72 unit/caller/permission tests passed**. Production build, standalone typecheck and money aggregation scan passed. Lint completed with **0 errors and 208 warnings**, including pre-existing unused variables in the touched manager/exporter. The build retained its existing dynamic-filesystem tracing warning.

Caller tests execute the real component handlers with controlled hooks/feed and a mocked exporter. Workbook tests execute the real writer with synthetic categories, capture the actual Blob and parse its cells in Chromium. They do not launch Microsoft Excel or LibreOffice; desktop spreadsheet compatibility beyond the existing XML format is not claimed.

## Separate observations and limits

- The external `node:crypto` / `UnhandledSchemeError` was **not reproduced** on this baseline. `next dev --webpack --port 3228` compiled `/finance/expense-categories` and returned HTTP 200; the browser had no page errors. It displayed the unauthenticated login shell, so this proves route compilation, not an authenticated development workflow. The reviewed expense components/exporter import DB types with `import type`; no client import changes or polyfills were made.
- Separate source-review observation (not runtime-reproduced here): the modal QR payload uses global totals and `categories.length`, while the printed table computes totals from `filteredRows`. That separate existing print/QR scope mismatch is reported for review and is not changed by this Excel-export repair.
- No financial entries, DB/schema, permissions, credentials, or Production service were changed. `lib/db.ts` and the files in PRs #346/#348 are untouched. No merge or deployment was performed.
