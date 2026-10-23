# Local validation

Node22.23.3 / PostgreSQL18.6. Relevant AGENTS/CLAUDE instructions and installed Next route guide read; no local .agents/skills available. Offline packages reused.

- Typecheck passed on final product/test source.
- Full lint passed (0 errors; existing warnings); changed product/test files passed targeted lint after final test edits.
- 28 existing focused PostgreSQL tests passed: empty-draft batching2, financial positions16, print snapshot3, portal detail7.
- 3 new populated tests passed: growth/full financial parity, concurrent payment across snapshot boundary, shared-read failure/rollback/next-request recovery.
- Expected RED on separate detached5930bed4 checkout: run only `bounds total query growth` from the new test file. At10 plans,638 calls exceeds400. No old source branch was modified. The test fixture was copied to that detached checkout with a distinct disposable database name.
- All measured snapshots match the canonical frozen-base oracle. Query-capture runs are separate from uninstrumented wall-time runs.
- Raw percentile recalculation validates complete committed samples; no slow samples removed.

The first attempt at the new failure-lifecycle test mocked the Client prototype after an earlier test had rebound a pooled instance method; it did not intercept the intended query and failed its expected-rejection assertion. The final test intercepts the actual borrowed client, confirms one schedule read and one ROLLBACK, then verifies a fresh successful request. No product error was hidden or assertion removed.

Local production build,63-asset preflight artifact build/help and actual runtime braces-absence scan passed (build g7Whi2XZB0hABuGVxLGIc,7920 files,349 traces). No database preflight was executed. Exact-head hosted CI results are reported in the PR description and final checkpoint. Previous-head CI is not final-head proof. The unchanged PDF extraction failure still prevents full PDF acceptance. Audit remediation is independently owned; no gate bypass.
