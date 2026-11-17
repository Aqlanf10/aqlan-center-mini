# Restore source provenance — WIP

This isolated candidate is based on `71b3384193a80eb8d0a122eb439e51973508356a`.
It rejects an unknown, duplicate or checksum-mismatched archived migration
before the admin drill resets its dedicated target, before staged restore opens
a target, and before the raw SQL CLI connects. Unknown historical 0090 is not
installed or adopted. The separately pinned 0079 name, checksum, adoption,
source footprint and timestamp checks remain in force; a fresh target does not
install it without its validated historical record.
The admin drill passes a locally loaded, frozen and internally branded
catalogue to staged restore; caller-constructed replacement arrays are refused.
Historical 0079 timestamps are checked as finite calendar/time/offset values
before reset, without Date normalization, and the accepted text is preserved
at microsecond precision. Non-writer forms, including precision beyond six
fractional digits, are conservatively refused.

The guarded parser accepts the application's writer-style literal `INSERT`
tuples, its three numeric relationship-fixup `UPDATE` forms, and its two
documented sequence `setval` forms. It rejects executable expressions in VALUES
and non-writer commands such as `DO`, `COPY` and `SELECT set_config`. This is a
writer compatibility boundary, not a general-purpose SQL sanitizer. Other SQL
spellings, even safe ones, are conservatively refused until their historical
writer origin is reviewed; no claim is made that every older backup uses these
exact forms. A backup without a migration ledger cannot prove that its schema
has no unrecorded history. Rejection preserves the source archive and target;
it does not reconstruct an unknown 0090 schema. Native full-schema recovery
and independently protected assets require separate verification.

Synthetic unit and mocked-target tests on Node 22 passed **90/90** across seven
files. Their target connection is mocked; they do not prove PostgreSQL target
preservation. The initial adversarial tests for `DO`, `COPY`, `set_config`, and
`pg_sleep` were observed failing against the prior parser, and the executable
VALUES example was confirmed accepted by that parser, before tightening.
An impossible 0079 timestamp and multiple calendar/offset overflow cases were
also observed accepted by the previous parser before the timestamp check.

The independent PostgreSQL witness creates new uniquely named source and
target databases after a loopback guard, records and checks OID/owner, and
intentionally retains the databases and synthetic evidence files. It covers
empty and populated unknown-0090 source archives, and separately exercises the
12-case numbering high-water matrix including both called states and replay
twice with source/target patient-document links and bytes. The allocator
matrix calls the SQL generator directly; it is not a full archive round trip.
**Neither PostgreSQL witness nor built HTTP, full typecheck, inventory refresh,
build, or CI has been run on this head.** Never substitute an existing or
preserved database for these disposable synthetic owned targets.
