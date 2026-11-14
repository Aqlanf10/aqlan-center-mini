# Clinical batch 43–47 — local acceptance complete, exact-head CI and review pending

Frozen product head `930bec71b938d5ecb9470fbd6048011cb0ced4f1`, build `7VhnR7xAAIIUis6j-UgVq`. The final publication commit updates evidence only. No slice48 product source is included.

| Contract | Delivered behavior | Evidence |
|---|---|---|
| 43 case status | Current authority/scope, observed state, original transitions, atomic audit; no reopening terminal native ortho history | [Slice43](work-case-status-slice43-20261101.md) |
| 44 problem status | Independent clinical documentation grant, original six transitions, current observation/scope, rollback | [Slice44](work-problem-status-slice44-20261101.md) |
| 45 problem creation | Strict bounded input, current scope and same-patient optional case with independent ortho visibility; linked-case read privacy regression repaired | [Slice45](work-problem-create-slice45-20261101.md) |
| 46 correction copy | Original draft copy rules, bounded valid copied source, same-patient references, atomic canonical audit and uncertain-response recovery | [Slice46](work-ceph-copy-slice46-20261101.md) |
| 47 observed draft discard | Draft-only soft discard, child-sensitive opaque version, current authority after waiting, atomic audit; proven legacy lease-cleanup defect fixed | [Slice47](work-ceph-discard-slice47-20261101.md) |
| Review correction | Actual string-only dependency requirement, negative array/object parser and HTTP cases | [Requirement fix](work-dependency-requirement-20261101.md) |

Final frozen source: **14,432/14,432 unit tests (855 files)** and **5,168/5,168 PostgreSQL tests (399 files), zero skipped**. Focused built HTTP/Chromium on the final build: **53/53 (five files)**. The preceding 43–45 focused HTTP run passed 74 and 46 passed 50 at their documented builds; these are not described as additional tests rerun on the final build. Full exact-head CI must still close its independent HTTP suite.

Production build and standalone typecheck passed. Full lint has zero errors and 345 existing warnings. Raw-body and money guards, environment contract, and preflight 71 immutable migration assets passed. Final runtime provenance: 10,146 files / 372 traces for braces absence; 741 traces / 86 manifests for lint-tooling inputs. These are map-supported absence witnesses, not proof about opaque code. [Frozen47 manifest, source hashes, raw logs and screenshots](evidence/work-ceph-discard-20261101/manifest.json).

The import/AST development-tracing guard timed out once during an earlier loaded full-unit run. Its unchanged five-test group passed alone; the later complete full-unit runs passed with the original timeout and assertions. Separately, an actual inventory sourceDigest mismatch was regenerated from source without changing classifications, counts, NOT_READY or assertions. Intermediate fixture errors, failed before witnesses, build attempts and a final command-name typo (`ci:scan:money` instead of the existing successfully executed `scan:money`) remain archived. No skipped check is relabelled as passing.

The map has 68 canonical-done / 276 existing ordinary methods in the 344-method conversion cohort. The exhaustive inventory remains NOT_READY (420 methods, 97 pages). These counts are not overall system completion. Publication adds five numbered slices 43–47 to the 17 published slices 26–42; the plan has no fixed final slice total.

Neither current-state guards, observation versions nor tab recovery markers are durable request receipts. Missing storage cannot promise recovery after reload; a 404 is not proof of a specific command outcome. No financial calculation, migration, live data, account setting or deployment changed.

Independent source review of 43–47 is pending. The previous e092 head fully passed CI 41283788092 / 41283783217; its success does not cover this batch. The [remaining integration review ledger](evidence/work-clinical-batch40-42-20261101/remaining-independent-integration-review.json) still distinguishes bounded accepted parts from the remaining sections of the 35 resolved conflict files. Actual WORK Docker proof remains blocked by the previously enforced Alpine CONNECT 403; no mirror, retry or policy bypass occurred. No new CI workflow has been enabled under HANDOFF §1.5.
