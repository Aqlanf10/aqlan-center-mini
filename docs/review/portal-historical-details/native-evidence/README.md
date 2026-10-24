# Bounded test/evidence follow-up on PR #458

Base: `1edac8b9a1d74a0752ecc5e5d9f550a8e50ab2bf`. This follow-up changes tests, evidence, and one narrowly scoped CI artifact upload only. It does not change application behavior, approve the proposed tolerant-history fallback, change financial rules, or authorize merge/deployment.

## Added regression cases

- PostgreSQL: inject a genuine undefined-column error into the historical read on the same snapshot client. Require SQLSTATE `42703`, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `ROLLBACK` without `COMMIT`, an exact generic Arabic HTTP 500 response, and a subsequent healthy response equal to the original.
- Built-app HTTP without Chromium: temporarily rename the history `lines` column in the disposable harness database, require the exact generic 500 body rather than `{historical:{available:false}}`, restore the column, and require unchanged synthetic rows plus recovered response equality. No application fault-injection hook is added.
- Browser at 390 and 1280 px: corrupt one saved synthetic revision's unit-price type, require the Arabic unavailable notice, no historical region/table/details, unchanged canonical balances and displayed `60,000 ر.ي`, and restore the original revision. These are tests of the proposal, not owner approval of it.
- Actual SAR PDF: generate the current Arabic A4 statement from a synthetic historical agreement, extract the actual PDF with `pdftotext`, require literal major-unit amounts (`1,500.50`, `500.00`, `1,000.50`) against stored minor units (`150050`, `50000`, `100050`), require SAR labels and no YER/cross-currency amounts, render the PDF bytes with `pdftoppm`, and verify no synthetic financial rows changed. This is deliberately not described as proven by portal DOM assertions.

## Oracle and artifact scope

The literal SAR expectations were checked against the current source, not invented: `lib/money.ts` uses 100 minor units per SAR, fixed two-decimal rendering (including `0.00`), and `ر.س`; `app/print/statement/[id]/presentation.tsx` renders the recorded zero discount because it tests `!== null`, not `> 0`, and supplies the asserted Arabic labels. The current statement summary uses the agreement currency's canonical due. Source inspection does not substitute for PDF extraction or visual review.

The existing CI upload steps did not collect the new output directory. A narrowly scoped `portal-historical-details-evidence` upload now allowlists the seven synthetic PNG/PDF/TXT/JSON outputs, including hidden paths, with seven-day retention. It uploads no browser/session state, cookies, traces, broad directories, or database dumps. At initial publication this was collection configuration only. The follow-up below records the later, partially populated CI artifact and the remaining final-head CI gate.

## Local verification

- Focused lint: passed for both modified test files.
- Typecheck: passed using Node 22.23.3 with a 4096 MB heap. The initial default-heap attempt exhausted Node's roughly 2 GB heap; its failure log is retained rather than reported as a test failure or hidden.
- Focused portal units: 12/12 passed (2 files).
- PostgreSQL historical suite: 17/17 passed on isolated PostgreSQL 18.6, including the new genuine database-error/rollback case. `postgres.log` contains the run.
- Built-app build: passed, with one dynamic-filesystem-tracing warning in unchanged `lib/migration-files.ts`. `build.log` retains the full result.
- Built-app API-only regression: 1 selected test passed; 7 browser/PDF tests were not selected. `http-database-error.log` and `database-error-response.json` contain the actual result. The temporary synthetic column was restored, all compared synthetic rows were unchanged, and the subsequent response equaled the healthy response.
- CI workflow YAML: parsed successfully; the upload allowlist contains exactly seven synthetic outputs.
- Browser corruption scenarios and actual SAR PDF generation/extraction/visual review: blocked in this execution environment. The runtime preparation probe reports Chromium Unix-socket creation failed with EPERM; the supported escalation could not launch either. No Chromium flags, different browser route, or permission workaround was used. No generated PDF or browser screenshot is claimed.

This is not a full unit-suite, full HTTP-suite, hosted CI, or Production verification claim. The fallback policy remains pending the owner's decision, and the unexecuted browser/PDF cases require a supported browser-capable run before those evidence gaps can be called closed.

## Commands and remaining gate

The runtime wrapper supplied Node 22.23.3, a 4096 MB heap, a private PostgreSQL 18.6 cluster at `127.0.0.1:55458`, and a built-app server at `127.0.0.1:3458`. It sanitized inherited environment settings, serialized heavy work, and stopped the private cluster after each DB/HTTP run. The HTTP harness created and removed only its own `aqlan_sec_http` database. No Production/Staging URL, credential, data, branch, or provider was used or changed.

Executed application commands:

- `npm run typecheck`
- `npm test -- __tests__/portal-statement-historical.test.ts __tests__/portal-statement-parity.test.tsx`
- `npm run build`
- `npm run test:postgres -- __tests__/postgres/statement-historical-details.test.ts`
- `npm run test:security-http -- __tests__/security-http/portal-statement-historical-ui.test.ts -t 'a real database error'`

In a supported browser-capable environment, run the complete `portal-statement-historical-ui.test.ts` suite and inspect the actual PDF-rendered PNG, not only its DOM or extracted text. The later CI run published five of the seven files. Replaying its exact raw PDF text reproduces the currency-text assertion failure; the follow-up below records the diagnosis. The corrected final head still requires a complete hosted run and seven-file artifact. The owner must separately decide the corrupt-history fallback policy; passing tests do not make that decision.

## CI follow-up: bidi-only PDF test-oracle correction

Run [40122100420](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/40122100420) on published head `8282a58842315bdf0479023ebc721e3a3842754d` finished with quality and PostgreSQL jobs successful, HTTP integration failed, and required gates failed closed. Artifact `12573080972` contained both corruption screenshots, generic-500 JSON, the actual SAR PDF, and raw text, but not the later rendered PNG/summary. Its downloaded ZIP SHA-256 matched GitHub's recorded `7653cb909d7e0235e542b2f66064f6ffcd1ca3c99c4b9eae74f0eaaf8874f23b`.

Replaying the exact original assertion loop against those bytes fails on `toContain("ر.س")`: `pdftotext` emitted `ر\u202a.\u202cس`. All five raw labelled numeric-token assertions pass. The correction removes only U+202A–U+202E and U+2066–U+2069 for currency matching and negative wrong-currency checking. Raw numeric and Arabic-label assertions and raw output are unchanged. No Arabic letters, punctuation, digits, ligatures, or words are rewritten.

The original oracle replay failed; the corrected replay passed 6/6, including rejection of wrong YER currency, reversed Arabic currency letters, x100 amounts, a one-cent prior-payment error, and a changed Arabic label. Sanitized `pdf-oracle-red.log` and `pdf-oracle-green.log` preserve those runs; `pdf-oracle-ci-lines.json` preserves the five original raw lines as escaped codepoints. Reproduce the durable counterexample checks with `node docs/review/portal-historical-details/native-evidence/replay-pdf-oracle.mjs`.

The actual CI PDF was rendered directly and visually inspected: readable RTL A4, `1,500.50`, `500.00`, `1,000.50` SAR and `0.00` discount, without visible content clipping. Both CI corruption screenshots show the Arabic notice, no history table, and the unchanged `60,000` YER balance with the `40,000` receipt. This visual observation does not establish a passing final test run. Complete HTTP logs could not be retrieved because the connector transport closed, so the absence of unrelated HTTP failures remains unconfirmed. The corrected head must pass full hosted CI before that claim is made. The owner fallback-policy decision is still outstanding.

After the bidi-only change, focused lint, the 4 GB typecheck, and the 12 portal unit cases passed again. The durable counterexample replay also passed. A new complete hosted CI run is still required.
