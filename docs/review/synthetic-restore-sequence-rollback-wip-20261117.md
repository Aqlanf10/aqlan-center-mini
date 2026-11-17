# Synthetic late-replay rollback witness — WIP

The test uses a writer-shaped duplicate synthetic patient ID near the end of an
archive to exercise a late database constraint failure. It retains checks for
restored rows, the full migration registry, enabled triggers and the separately
queried pool's replication role. It additionally observes the next candidate
for `patients_id_seq` and `patient_number_seq` before and after the failed
replay, asserts that neither candidate decreases and emits only a fixed notice
if one advances. PostgreSQL sequence `setval` is not transactional. An observed
advance is a finding, not a policy decision that the change is acceptable; this
test does not establish that all sequences or all target state are unchanged.

The existing replication-role query may use a different pooled connection; it
does not prove the setting on the replay session. The current expected error
checks the `patients_pkey` text on this WIP's base. A separate privacy branch
returns a fixed stage and SQLSTATE instead of raw database error text. Combining
those branches requires preserving a synthetic proof of the exact constraint
failure without re-exposing database messages. PostgreSQL and full CI have not
been run for this amendment.
