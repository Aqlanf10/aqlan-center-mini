# Local phase2 handoff status

Continuation base: main `482cbed4a434407514cdf73221e96cde7aaaadbb` (merged PR343).
The original branch at `187af34b` is preserved. The single continuation branch is
`fix/invoice-currency-reclassification`; checkpoint `47b578e3` has the identical
product tree; final review fixes are committed at `ed425918`. No continuation
code has been pushed yet. Parent authorized0063 and a Draft PR after the local
verification gate; review, merge and deployment remain with the parent.
HR0062/PR342 are excluded.

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

Verified:10053 unit tests,2329 PostgreSQL tests,36 final failure/restore/feature
cases, typecheck, lint without errors, money scan, final-cleanup production build,
29 focused financial HTTP tests and2 Arabic viewport/paper-bounds tests.
Full HTTP completed:215 passing files,9 failing,3 skipped;1554 tests passed.
Setup/environment failures and one migration-list fixture were isolated and
rerun:75 final-build tests pass, with1 baseline lab-PDF failure. See the verification
document for exact results. Receipt-PDF failure reproduces on
unmodified main482c with identical coordinates: local Chromium151 renders a
1.832742pt gap where the oracle allows0.5pt. Playwright's Chromium153 download was
blocked by network403. A separate lab PDF failure also reproduces on main482c.
No oracle was relaxed. See the baseline comparison evidence.
Final review added a payroll-run fence before correction can race a newly
started payroll calculation, and preserves new SAR receipt allocation after a
later ordinary invoice correction. Both regressions fail on the previous code
and pass after the fixes (39 focused PostgreSQL cases). Final unit/PostgreSQL/build/typecheck/lint/money checks pass at ed425918. The migration-list HTTP fixture update is128831ce.
[Phase2 verification](phase2-verification.md) carries the current results.

Publication remains pending the parent’s decision about the two baseline PDF
failures; no continuation push or Draft PR was made. The reviewable PR body is
saved locally at /tmp/currency-continuation-pr-body.md.

No production/staging operation or real patient/receipt/permission edit occurred.
The user will correct their own real record after parent-reviewed deployment.
