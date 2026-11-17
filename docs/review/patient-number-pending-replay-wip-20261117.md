# Pending patient-number allocation during legacy replay — WIP witness

This test-only branch starts from `0e614d46b4e2095a41bc20cc42978f3737ed84b2`.
It adds a synthetic PostgreSQL CI witness; it is not a product fix, a policy
change, or evidence about a real database. The existing allocator witnesses
remain unchanged, and this branch does not combine or prove the 0090 guard.

The standalone environment guard runs before connection. Global setup requires
the exact dedicated CI `TEST_DATABASE_URL` and `DATABASE_URL` and connects to
that service; the fixture additionally rejects alternate POSTGRES/SOURCE alias
URLs unless absent or exactly equal before its own first connection. A loopback
address and environment variables are not a cryptographic proof against a
local tunnel; the witness must run only on its dedicated GitHub CI service.
The fixture connects to its
maintenance `postgres` database only to create fresh, randomly named databases.
Intent files are retained before creation; after creation OID and owner are
saved, compared with the creating role and verified from each target connection
before either explicit `setval`. Both databases are migrated while empty before
test data are inserted. A fixed timeout is set only on the new owned target.
The witness never drops a database or removes its archives, marker or identity
files. The backup writer does remove its private temporary working directory;
the runner and databases themselves are ephemeral after CI ends.

The source has migration 0080 but no policy or retired rows. Its archive is
required to be noncanonical before the test explicitly enables the legacy
nonempty-target path, and must contain the patient-number sequence writer
statement and synthetic source patient. The target policy and retired alias
both exceed its starting sequence. An actor on a separately verified connection
opens a READ COMMITTED transaction, calls the real patient-number allocator and
holds the transaction open during replay. The allocated number and all data are
synthetic and are not printed.

The observer identifies the replay connection by a fixed synthetic
`application_name` and checks whether the actual actor PID blocks it using
`pg_blocking_pids`; it does not mistake an unrelated wait for this race. It
rolls back the actor **before** waiting for a blocked replay. A fixed known
numbering-busy error or the existing exact nonempty guard may be classified as
refusal; any other error, unexpected early success, timeout or thrown error is
an unclassified failure. A successful replay is accepted only after the actor
rollback and an observed wait, with the selected source/target patients
verified. This deliberately does not assume that a generic SQLSTATE or every
lock timeout means the patient-number guard fired. For a waiting replay, the
test records whether it had already finished *before issuing* actor rollback;
it does not infer server lock state from the order of JavaScript callbacks
relative to the rollback response. An observed wait is bounded to the named
synthetic replay and the verified actor PID; it does not identify which table
or advisory lock caused the wait.

The test checks that neither the already allocated number nor the retired
number is allocated again, that the target next candidate and policy-derived
floor do not move backward, and that the target policy, retired rows, old
patient row and registry remain unchanged. It also checks the selected source
patients, policy, retired rows, registry and source sequence, plus archive,
stage marker and both database identities. It does not assert identical target
`last_value`/`is_called` after the deliberately rolled-back allocation: 0080
documents gaps after rollback and forbids reuse. It does not compare every
application table or every target metadata field. An unexpected timeout may
leave the replay result and complete target state unconfirmed; it fails closed
and never reports a pass.

Compatibility note: this base returns a bounded *match* against its existing
raw busy message without printing it. The independent error-privacy branch
changes error presentation; composing the branches requires a reviewed stable
reason that distinguishes this specific guard from unrelated PostgreSQL lock
errors. The witness does not authorize restoring raw error messages.

No PostgreSQL, HTTP endpoint, Next build or CI ran on this new witness yet.
Its actor rollback and subsequent allocation are intentional mutations only to
the freshly created synthetic target. They do not prove recovery, policy or
concurrency safety for other paths, all caches, external sessions, 0090, or
real data. Independent review and synthetic CI are required before drawing a
conclusion.
