# Local phase2 handoff status

Current runtime checkpoint:53c41e61, on the single branch
`fix/invoice-currency-settlement-recovery`. Remote Draft PR343 remains5910878f;
no phase2 code was pushed. Parent authorized0063 and local checkpoints, and
reserves review, push decision, CI, merge and deployment. HR0062/PR342 are excluded.

The canonical partially paid correction is implemented and tested, not a selector
prototype:2500YER→2500SAR,900SAR settlement,1600SAR remaining, independent100YER
credit, unchanged historical receipts/cash. Append-only proof, refund/correction
routing, treatment ownership/identity, all settlement consumers, noncash journal,
historical report cutoffs and original commission policy/target are integrated.
See [design and explicit support limits](design.md).

Parent debt snapshot cleanup and actual-PGlite detection are integrated with the
two added allocation-proof queries. Report cutoff behavior from PR344 is present
in lib/reports.ts; preserve it when rebasing onto the parent's eventual main.
The additional monetary readers share PostgreSQL snapshots and commission helper
reads use that same connection to avoid pool starvation. Final cleanup discards
an unsafe correction connection rather than returning it to the pool.

Verified:10053 unit tests,2327 PostgreSQL tests,36 final failure/restore/feature
cases, typecheck, lint without errors, money scan and main-workflow build. Full
built HTTP/UI is running; after it finishes, rebuild the final cleanup checkpoint
and rerun the focused currency/recovery HTTP flow. Prior verification.md is phase1
only. [Phase2 verification](phase2-verification.md) carries current results.

No production/staging operation or real patient/receipt/permission edit occurred.
The user will correct their own real record after parent-reviewed deployment.
