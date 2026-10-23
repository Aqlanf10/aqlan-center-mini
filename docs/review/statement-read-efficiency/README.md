# Statement read efficiency inside one financial snapshot

**Current follow-up:** [populated-optimization/README.md](populated-optimization/README.md) documents the proven repeated repayment reads, the transaction-local fix, executable growth/concurrency/error tests and complete new interleaved timings.40-plan SQL falls8533→799 and warm p50~5092→457ms. Small-path tails remain mixed/worse in some retained cohorts, so blanket no-slowdown acceptance is still open. Earlier evidence below and reproduction/ remains historical and is not relabelled as the new product version.


The coherent statement snapshot performed a separate currency read and one invoice-source discovery query per unapproved plan. On the reviewed #439 base, five draft plans required 18 SQL calls. This change reuses the complete plan rows for the currency map and batches source discovery, yielding 13 calls for the same result.

Only patientStatementSnapshot opts into batching. Standalone plan readers retain the same SQL and the shared financial resolver. The repeatable-read, read-only transaction, currency validation, plan/invoice ownership checks, approved-principal authority, correction lineage, refunds, source-drift handling, permissions and error cleanup are preserved. No collection/receipt writer, migration, lockfile or workflow changes.

## Measured effect

Control: immutable #439 head `9881d33c21c4812ae3e18219a8112438d6192a78`. Product file hashes bind the measured implementation in measurement-summary.json.

| Warm statement latency (ms) | n | Errors | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| #439 control | 600 | 0 | 20.275 | 24.513 | 28.187 |
| Optimized | 600 | 0 | 14.742 | 17.836 | 19.220 |

Absolute / relative changes: p50 −5.533ms (−27.3%); p95 −6.677ms (−27.2%); p99 −8.967ms (−31.8%). All three paired blocks improved. This is service-layer evidence on an isolated synthetic fixture, not a Production latency SLA, HTTP timing, or a promise of no slowdown in every workload. The weaker historical baseline is not used as this acceptance comparator.

Method: identical seed clones, 1,000 synthetic patients / 100,000 appointments / 100 statement invoices and receipts / five draft agreements; same PG18.6 container (2 CPUs, 1GiB), Node22.23.3, pool max5, one request at a time. Three paired blocks in control→optimized / optimized→control / control→optimized order; 10 excluded warm-ups and 200 measured calls per side/block. Same 600-sample method as the prior investigation; this repeat isolates statement calls. Database/OS caches warm; no cold-start or saturation claim. Complete warm and cold raw samples, recalculation script and fixture/harness recipe are committed in reproduction/. EXPLAIN trees remain in cloud workspace /workspace/statement-performance-evidence.

## Attribution

The historical statement used multiple independent snapshots in parallel; #439 correctly serializes inputs on one coherent snapshot. That semantic cost cannot be removed by restoring weaker reads. The avoidable work here is five separate plan-source SQL submissions and a redundant plan-currency query. LATERAL batching reuses the exact discovery predicate and shared resolver; it does not assume a draft plan has no invoice evidence.

Six paired EXPLAIN ANALYZE/BUFFERS probes were recorded (first pair excluded from summary). Query planner/executor numbers are small-fixture diagnostics, not application latency: see measurement-summary.json. This reduces planning/submission overhead and allows a combined plan; it is not a claim that underlying work is constant for every plan count.

Collection remains separate and unchanged: prior profiling found one extra similarity-review query required for safety. No receipt correction (#442), collection protection, accounting, commission or cash behavior is modified.

## Regression evidence

- New bounded-query-growth regression: 1→40 empty draft plans returns every plan without one extra SQL submission per plan. Red on immutable #439: 50 calls exceeded the 12-call bound; green on this change.
- Concurrent new-plan commit between snapshot reads cannot split plan details from the currency map; both appear together on the next request.
- Existing payment-between-reads print and portal concurrency tests pass, including rollback-failure cleanup.
- Complete statement plan DTOs/currency maps equal standalone readers across the populated existing source matrix: approved/draft agreements, invoice-backed schedules, all three currencies, classic installments, refunds, invoice/receipt corrections, ambiguous ownership, reclassification and source drift.
- Local typecheck and 28 focused PostgreSQL cases passed. Full hosted CI is required on the final head; no old green run is reused.

Installed system Chromium was reused without download: portal4/4 and basic print pass, but active-agreement PDF label extraction fails identically on base and candidate before the later payment/second-PDF assertions. This remains an acceptance blocker, not an accepted inherited failure. See pdf-diagnosis/ for exact text, runtime, minimal reproduction and separate repair proposal. No local browser latency claim. Run40000981477 on8445d830 completed: PostgreSQL success, audit failure, HTTP/browser skipped, aggregate failure; audit remediation is separately owned. No skipped check counts as success.

## Deployment boundary

This is an independent code-review candidate, not a release. #439/main/source PRs remain frozen. The separate DDL contention proposal concerns bounded lock waits, controlled traffic windows and partial-migration recovery; no DDL or live configuration change is included here.

## Cold probe and scope limitation

All52 fresh-process samples/version are retained. Control→optimized p50 271.888→266.186ms, p95 306.122→342.542ms, p99 326.792→434.562ms, zero errors. Aggregate cold tails are worse; non-regression is inconclusive. First call after module import, DB/OS caches warm; not full app or disk-cold latency. Do not omit the initial slow samples.

Only candidate-discovery submissions are batched. Invoice-backed plans still read invoice settlement and debt repayments; approved agreements resolve individually. The empty-draft query-count test does not prove globally constant total statement SQL.

Additional populated2/10/40-plan probe: total SQL64→63 /643→638 /8533→8513; candidate timing observations were slower in this small single-order run. Full canonical snapshots match. This exposes substantial inherited repeated financial reads and does not establish populated-plan speedup or non-regression. See reproduction/POPULATED-RESULTS.md for full numbers, limitations and proposed separate investigation.
