# Isolated v2 physical recovery witness (not installed)

Extends the managed V2 codec's synthetic attachment proof with real
PostgreSQL 18 custom-format pg_dump bytes. Both source and target are
disposable. The two newly provisioned fixture schemas are quiet between
matching pre/post-capture V2 projections. An intentionally independent
in-process witness pins both archive and state digest. Only the bytes from
the admitted immutable TAR are sent over stdin to pg_restore, into a
new target verified by database name, OID and owner. No supplied external
archive or hosted database is used.

A fresh pool to the restored target re-exports the exact V2 bytes.
Two synthetic patient identity rows stay attached to their old file numbers,
the retired P alias and P pending sequence are intact in the fixture, a
committed A-01500 receipt comes back, the retired competing request cannot
save or be read by a foreign enrollment, and the next issued A is A-01501.
The source projection and identity rows remain unchanged. A physically real
but older archive from before retirement is refused against the newer
independent witness before any restore target is created.

Scope: the fixture patient table contains only synthetic ID/file-number
pairs and is not the product's full patient schema. This is a fresh pool
after native restore, not a mounting or startup change. The physical backup
tool is not the application's streaming backup. Quiescence is controlled
by the fixture; a real operational writer fence, real custody/migration
registry, protected owner identity, app backup coupling, browser and
rollback proof remain separate gates. The fixture P counter is not the
distinct public legacy sequence.

Opt-in: `NUMBERING_V2_OWNED_PHYSICAL_WITNESS=1` with an existing approved
local test environment and `NUMBERING_PG_BIN` matching PostgreSQL 18.
