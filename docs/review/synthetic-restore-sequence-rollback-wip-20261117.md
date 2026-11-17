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

The inherited CI-only fixture destroys its own identity-checked synthetic
databases and staging directory during cleanup. Its temporary databases and
files are therefore not retained as evidence after runner teardown. The
creation-time name/OID/owner are checked again before the sequence mutation and
after replay; existing external databases and evidence are not selected.

The separate focused CI job provisions its own PostgreSQL 18 service. Its
Vitest setup checks the dedicated loopback URL, CI markers, original aliases
and deployment markers before the existing global setup opens a client. This
guard is intended for the GitHub-hosted job; environment strings alone cannot
prove ownership of a locally spoofed or tunnelled endpoint. The existing full
PostgreSQL job, HTTP jobs and required-completion gate remain unchanged. This
focused job is diagnostic and is not added as a required-completion input.
