# Strict dependency requirement — bounded review correction

Independent review of `e09263fa` identified coercion in `parseCanonicalPlanDependency`. A JSON array such as `["completed"]` passed the parser and failed later at the database; an object with a non-callable `toString` raised a conversion error. This was fail-closed input handling, not a demonstrated authorization or financial bypass.

The parser now requires a real string before testing the unchanged `completed` / `clearance` values. The command, authority checks, locks, graph rules and audit body are byte-identical to the published version. Both allowed values remain positively asserted.

- Before: 21 unit tests passed, the two new negative tests failed. Real built HTTP returned 500 for both malformed JSON values instead of the expected400.
- After: 23/23 unit tests; 74/74 built HTTP/browser tests across six related files, including all15 dependency journeys and both new400/no-graph-effect/no-audit-effect assertions. Build `DyLznC2ConMfswaBdRqwY` also contains the local slice45 changes; it is not presented as an isolated full-build acceptance of this commit.
- The first HTTP attempt stopped at the local test-target guard because TEST_DATABASE_URL was omitted; all15 cases were skipped, and that attempt is not evidence of the defect. The corrected explicit disposable local target produced the two intended failures. No guard was weakened.

[Manifest, source hashes and raw evidence](evidence/work-dependency-requirement-20261101/manifest.json). Exact-head CI and independent review of the final combined batch remain pending. No migration, data, CI setting or deployment changed.
