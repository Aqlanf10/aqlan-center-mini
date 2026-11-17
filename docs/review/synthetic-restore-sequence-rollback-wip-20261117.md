# Synthetic late-replay rollback witness — WIP

The test uses a writer-shaped duplicate synthetic patient ID near the end of an
archive to exercise a late database constraint failure. It retains checks for
restored rows, the full migration registry, enabled triggers and the separately
queried pool's replication role. It additionally observes the next candidate
for `patients_id_seq` and `patient_number_seq` before and after the failed
replay. It checks the synthetic database identity and ensures the original
candidate is not higher before setting its `patients_id_seq` high-water to
100000 (called) on that owned target only. It asserts that neither next
candidate decreases and emits only a fixed notice
if one advances. PostgreSQL sequence `setval` is not transactional. An observed
advance is a finding, not a policy decision that the change is acceptable; this
test does not establish that all sequences or all target state are unchanged.

The existing replication-role query may use a different pooled connection; it
does not prove the setting on the replay session. The current expected error
checks the `patients_pkey` text on this WIP's base. A separate privacy branch
returns a fixed stage and SQLSTATE instead of raw database error text. Combining
those branches requires preserving a synthetic proof of the exact constraint
failure without re-exposing database messages. PostgreSQL and full CI have not
been run for this amendment; the high-water assertion may expose a regression
and must not be weakened if it fails.

In focused CI retain-only mode, the fixture closes connections without dropping
its owned synthetic databases or removing the witness directory. It records the
creation-time identity for each database in a distinct exclusively-created
file, and checks name/OID/owner again before the sequence mutation and after
replay. Original default cleanup remains for ordinary tests. The application's
`fullBackupBlocks` removes its own internal temporary staging directory while
forming the archive, before the final witness archive is written. Unless a
safe artifact capture succeeds, the retained databases and files still vanish
when the hosted runner and its PostgreSQL service are destroyed. Only a strict
fixed-field report with hashes, counts and statuses is eligible for artifact
upload after the dedicated environment and three recorded identities pass
validation; raw archives, SQL, databases, URLs, environment and logs are never
uploaded. The report cannot reconstruct any database.
Individual input files are opened without following the final symlink and read
through their verified file descriptors. These checks do not establish immunity
to an adversarial process replacing an ancestor directory during capture; the
operation is limited to the isolated synthetic GitHub-hosted runner.

The separate focused CI job provisions its own PostgreSQL 18 service. Its
Vitest setup checks the dedicated loopback URL, CI markers, original aliases
and deployment markers before the existing global setup opens a client. This
guard is intended for the GitHub-hosted job; environment strings alone cannot
prove ownership of a locally spoofed or tunnelled endpoint. The existing full
PostgreSQL job, HTTP jobs and required-completion gate remain unchanged. This
focused job is diagnostic and is not added as a required-completion input.
