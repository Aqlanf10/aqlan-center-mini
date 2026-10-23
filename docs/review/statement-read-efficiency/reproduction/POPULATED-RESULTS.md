# Populated-plan scaling: no broad performance acceptance

Same isolated PG18 resources; 2/10/40 plans per synthetic patient, equally split invoice-backed and approved. All have payments; YER invoice plans have invoice corrections;10/40-plan cases mix YER/SAR/USD. Application writers and financial guards intact. One excluded warmup,10 measured serial calls/version/scale, query capture enabled. Control ran first; this small single-order probe is diagnostic, not a repeatable latency improvement claim.

| Plans | SQL calls base→candidate | p50 ms base→candidate | p95/p99 ms base→candidate |
|---:|---:|---:|---:|
|2|64→63|54.842→56.014|76.519→108.704|
|10|643→638|360.248→470.762|416.304→594.284|
|40|8533→8513|4670.014→5069.141|5784.381→5920.992|

Zero execution errors. At n10 nearest-rank p95 and p99 are both the maximum. Candidate observations are slower in this run; no populated-plan no-regression or speedup is established. Saving1/5/20 submissions does not address the dominant repeated financial reads.40-plan latency is already multi-second on the base and remains so on the candidate.

Full canonical snapshots (ledger, plan DTOs, currency mapping) match exactly between base/candidate at all three scales. Map insertion order and object key order are canonicalized; arrays and Date values are retained. Initial raw serialization hashes differ because insertion order is not semantic Map equality; no financial difference was found. Each read also matches the corresponding standalone plan reader. Captured transactions contain exactly one BEGIN REPEATABLE READ READ ONLY and one COMMIT. Existing dedicated interleaving tests remain the concurrent-snapshot evidence; this scale probe is not a new concurrency stress test.

Raw timings, plan progress, call counts and lossless query-frequency tables are included in populated-scale-control/opt.json; full canonical synthetic snapshots and hashes are included. The separate parity reader emits full snapshots for comparison; run it against both roots on the same synthetic DB. It does one excluded warmup and one captured read per scale. Do not merge its diagnostic timing into the original10 samples.

At40 plans the candidate repeats two reclassification-evidence queries1121 times each, and several invoice/lineage/settlement queries580 times each. Per-plan readDebtRepayments and approved-source resolution remain. Proposed separate investigation: reuse patient-wide debt-repayment results and invoice settlement evidence **only within the same RR snapshot/client**, with keys covering patient/currency/lineage and exact DTO/error/concurrency regressions. Do not cache across transactions or bypass reclassification/source-drift/ownership checks. No such optimization is implemented here; do not enlarge #444's performance claim.
