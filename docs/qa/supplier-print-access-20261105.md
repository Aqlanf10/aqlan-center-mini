# Supplier statement print authorization

Base: `6a6bdc0cc705874fd4ff6d0f0ddc3fdcd314e9e6` (main, independently verified).

## Defect and fix

An accountant with `financeAccess.viewSuppliers: false` was refused by the supplier API gate but admitted to `/print/party/[id]`. The server page only required a money-reading role, so direct rendering read the party, statement, and settings even for that restricted account.

The print is now included in the existing supplier permission gate, using the same trailing-slash-aware route matcher as the allowlist. The server page independently runs that gate against the freshly revalidated session before any party, statement, or settings read. Admin, reception, and permitted/default accountant printing retain their existing behavior. Cashier direct rendering now matches the pre-existing proxy denial. No financial calculations, data, schema, or commission policy change.

## Evidence

Synthetic data only; no Production requests or changes.

- New regression suite on unchanged main: 8 failures and 23 passes. Witnesses included the missing route denial and direct server-page reads for a restricted accountant and cashier.
- Same suite after fix: 31/31 pass, using actual token signing, session validation, proxy, and server rendering with mocked headers and database readers.
- Coverage: signed cookie and Bearer sessions; disabled and allowed supplier permission; legacy default permission; current-account authority over a stale signed projection; permission-revision revocation; all relevant roles; no data reads after denial; GET/HEAD and trailing slash; non-read methods; unauthenticated and invalid-ID denial.
- Existing role, print security, party statement, native-balance, and opening-adjustment suites: 66/66 pass across 5 files.
- Separate compatibility checkout at PR506 head `171ae786cbe2f3cdae4d91f843a2659c646d9046`, with the identical production patch: 40/40 pass. This includes the same 31 tests plus 9 canonical/durable compatibility witnesses: obsolete authority markers, valid durable cookie/Bearer sessions remaining unsupported here, and no fallback from a signed canonical cookie to an otherwise valid legacy Bearer. Those PR506-only tests remain separate from main, where the newer session modules do not exist.
- Focused ESLint and `git diff --check` pass.

Commands use Node 22.23.3 and `npm ci --ignore-scripts` from this checkout's exact lockfile. Vitest runs use `--maxWorkers=1 --no-file-parallelism` to stay within shared execution capacity. A first combined focused-test/typecheck attempt was interrupted to relieve shared memory pressure; the completed sequential runs above are the reported test evidence.

Full typecheck, full suite/build, CI, deployment, and live HTTP validation are separate checks and are not claimed by this report.
