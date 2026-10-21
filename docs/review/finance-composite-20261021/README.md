# Composed financial acceptance candidate — awaiting parent review

This is a new isolated validation branch, not a merge to main or a production
release. Existing PR heads/runs were not modified. Parent owns final composition
review, exact-head hosted CI acceptance and integration.

## Source composition

Start: #379 `80a8bea3bc9a4acdb5affa3b5b9876bf35a8788d`, tree
`af909d9b0195be626fcd78454ee9151a90021321`. That base already contains the
reviewed #370/#371, expense atomicity #376, supplier #378, purchase readiness
#379 and shared #377 test repairs. #367 head `f00061b60f297f16be6d90374077d8d509903064`
is an ancestor of this base and was not applied twice.

Only incremental source patches were applied, each in its own provenance commit:

| Source | Exact source head | Delta base |
| --- | --- | --- |
| #372 monthly measurement | `725fe0de44f2d35b13b650df17d130215fd76970` | `af709ae57c5efbb52d70998dac751f3c07df0d7c` |
| #373 invoice/debt HTTP acceptance | `0a3e8dbf641287c66b9ddcf7fe61df4cec2ee283` | `af709ae57c5efbb52d70998dac751f3c07df0d7c` |
| #374 commission lineage | `b067e04385c34223c8d3648b7203d3f284255098` | `af709ae57c5efbb52d70998dac751f3c07df0d7c` |
| #381 consent audit atomicity | `f596c019cc7f40b5f6b05d8b7512bd3c6cf9dc38` | `4b4e12db484833cbedbc39c816b7324fa054eafa` |
| #369 security source from main | `3f7b02b5a6cd31764543f466e3e58a1285f9efc5` | `13bfa0655dd69e75048c3d5698b861c7550010a2` |
| #375 security source from main | `018a94127cbc475031ca00034f31f35ce4b92515` | `3f7b02b5a6cd31764543f466e3e58a1285f9efc5` |
| #382 reviewed prescription/checklist | `2b52888a06a9ea23a014a8913d4a3147a64f0c56` | `af709ae57c5efbb52d70998dac751f3c07df0d7c` |
| Reviewed commission HTTP fixture | `5fbe96fd381443aa912933a1796f06145078da97` | `b067e04385c34223c8d3648b7203d3f284255098` |

The last two increments were applied only after the parent's explicit independent
review approvals. #380 / new visit context remains excluded. No child-PR ancestry
was merged into this branch by the composition; no main merge was performed.

`manifest.json` records every source/tree, patch SHA256, stable patch ID, affected
paths, composed commit/tree and final source blob. Each applied patch ID equals
its source patch ID. Latest exclusive-path blobs match their source commits.
All incremental patches reverse-check on the final source tree except the original
#374 test-file hunk deliberately superseded by the approved fixture increment.
There were no application conflicts or improvised resolutions.

The shared `recordExpense`, `settledOnPayableSql`, `commissionReport`,
`recordPlanConsent` and `monthlyReport` sections were compared byte-for-byte with
their respective reviewed sources; their SHA256 values are recorded. Consent,
expense, supplier and commission changes coexist without replacing one another.
No migrations, workflow settings, permissions or production configuration changed.

## Validation identity and scope

Final executable/test source freeze: `85ebfc60eb56f7f189ae0463460571148e4bc0a9`,
tree `3f34dbe1d9c59cdb5e8cec571573f46afcee1237`. The subsequent manifest/evidence
commit changes only this documentation directory. Hosted CI must validate the
published final head; older passing heads or cancelled runs are not substitutes.

Node 22.23.3, real PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2),
`server_version_num=180006`. Isolated container
`aqlan-composite-finance-pg18-synthetic`, ID
`5a9bb5605ac326512ea96ee7dff9317efd6a7968e820b8deb70b9eafc9ca625f`,
label `aqlan.purpose=finance-composite-acceptance`, bound only to 127.0.0.1:55443.
The database target and version were verified before setup; disposable databases
were `aqlan_p1_test` and `aqlan_finance_test`. HTTP harness database `aqlan_sec_http`
was absent before each run and dropped afterward. No real patient data or sessions.

The fresh default Next build passed on the pre-fixture tree. The approved final
increment changes one HTTP fixture only; all build/application inputs are identical.
The combined HTTP check reused that build with the exact final test sources.
A temporary local runner retained the project's target/classification/version
preflight and only added the three reviewed HTTP filenames to the lifecycle test
selection; it was removed, not committed. No browser was launched locally.

Final source checks passed: 10,745 unit tests across 613 files (287.82s),
17 combined HTTP tests across four files (11.81s), 21 focused PostgreSQL tests
across three files (8.98s), full TypeScript and fixture ESLint (exit 0).
Before the fixture increment: 86 guard tests, 55 PostgreSQL tests, fresh build,
money-aggregation guard and 10,745 units passed; scoped lint had 0 errors and
15 existing warnings. See manifest and logs for separately identified results.
The nine lifecycle tests found no new financial defect. Lost acknowledgement is
simulated by discarding an already committed response then replaying the same
request key; no real network outage is claimed.

## Remaining gates and limitations

- New branch name `review/finance-composed-acceptance-20261021` is outside the
  workflow push filters (`main`, `feat/**`, `hardening/**`). Opening one Draft PR
  to main is the sole full CI trigger. No mirror branch or manual dispatch is used.
  Existing focused workflows may independently respond to that same PR event.
- Full hosted CI and browser acceptance remain mandatory after source freeze,
  followed by independent parent review of the exact published composition.
- The approved commission fixture asserts hostname 127.0.0.1 and fits the current
  serialized harness; this is not universal localhost/container-host portability.
- #382 preserves strict 390/1280 geometry and nonmutation checks. It does not
  claim that the whole expanded financial panel fits within one viewport.
- Five inherited evidence logs contain an extra final blank line. Those source
  bytes were preserved rather than altering reviewed patches; no source-code
  whitespace errors were introduced. Scoped lint has existing warnings, not errors.
- No skips, timeout increases, assertion weakening, closed-period race, denied raw
  log retrieval, Production operation, credentials change, main merge or deployment.
