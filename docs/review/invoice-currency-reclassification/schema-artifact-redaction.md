# CI39079806555 schema ownership artifact failure

Head329c64df passed PostgreSQL integration and current schema contract generation.
The ownership CLI then rejected its serialized artifact with
SCHEMA_OWNERSHIP_ARTIFACT_REDACTION. Reproduced locally on disposable PostgreSQL18.
Safe diagnostics emitted only a function key, digest and booleans: the sole
match was INSERT INTO in aqlan_reclassification_follow_refund(), with no other
sensitive pattern. Both catalogs have the same canonical function-value SHA256:
273166a6d2034278cad975e5bde554dd4e2bb2075f544ab8df1a11fc03f328d0.
No connection strings, credentials or application data were output in diagnosis.

The artifact projection now fingerprints only the exact reviewed function name,
identity and full canonical definition+semantic metadata digest. Unknown or
modified definitions remain untouched and subject to the strict scanner. Actual
schema comparisons still run on the original full catalogs before projection.
The INSERT INTO rule, migration checksums and16 open convergence findings remain.
A negative test also exposed nested-JSON credential keys missed by the existing
scanner; closing escaped quotes are now recognized, strengthening that check.

Evidence: initial CLI red; new serialization-gate PostgreSQL test red (1 fail,
5 pass); projection green (6 PostgreSQL pass);50 scanner/comparator unit tests
pass including unknown function INSERT/credentials and nested JSON; the actual
CLI writes its artifact and exits0, with0 unexpected differences and16 existing
open findings. Typecheck passes; targeted lint has0 errors and1 prior warning.
Later CI artifact-upload failures followed skipped build/HTTP steps; no CI rerun
or push was performed for this diagnosis. Full unit/HTTP suites are not claimed
for this tooling-only patch. No live database or schema change was made.
