# Historical 0090 standalone restore witness — WIP

This local test-only branch is based on `71b3384193a80eb8d0a122eb439e51973508356a`.
The [historical PR #490](https://github.com/Aqlanf10/aqlan-center-mini/pull/490)
reported a synthetic application archive with historical 0090 being restored
without its history when bookings were empty and failing on missing columns
when bookings were populated. Its reported head was
`7377434dea25cd52ae2540c7e56ec8363a31a5de`. This witness does not claim to
reproduce that historical run or independently establish its SQLSTATE.

The existing 0079 witness is unchanged. A second, separate witness uses four
new identity-checked databases on the existing disposable synthetic CI service:
one source, one pre-0090 positive-control target and two independent 0090
targets. The source starts with the candidate
catalog, then applies a test-only byte-identical copy of published migration
0090 with SHA-256 `608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25`
and its exact non-adopted registry record. The fixture is outside runtime
`migrations` and does not register or renumber a production migration. Actual
`fullBackupBlocks` output is used to create a pre-0090 control archive, an
archive with 0090 and no booking rows, and another after inserting one
synthetic booking. The control must restore successfully to its own target;
this helps distinguish a general setup failure from rejection of 0090. Before
either request, the witness verifies that the empty-booking archive's SQL,
after removing its exact 0090 registry row and the unchanged registry rows,
matches the control's corresponding application SQL by SHA-256. Only the
single generated schema-migration count comment is normalized, after its count
is checked against the source registry; all other content remains compared.
The public endpoint's
error reason remains generic, so the test does not expose a private diagnostic
or independently identify every possible earlier rejection cause.

Each case checks archive structure, the exact 0090 name and checksum, and the
presence or absence of booking INSERTs. It then calls the built standalone
restore endpoint on its own newly owned target and stage, requiring rejection
before the synthetic database sentinel and staged document are touched. Each
case is separately reported, so failure in one does not skip the other.
Databases and evidence are retained during the CI runner's lifetime only; no
database, archive, cookies or raw logs are uploaded by this change.

The current candidate lacks 0090. Both assertions may fail on it; a red CI run
would be diagnostic evidence requiring investigation, not a successful CI
result. This test-only branch does not fix restore behavior, alter 0079 or the
daily adjustment flow, and is not approval to merge or deploy. The witness has
not been run against PostgreSQL, the built endpoint, or hosted CI on this
revision. Local checks at this checkpoint are limited to test discovery,
targeted lint, the existing environment guard and fixture SHA comparison.

Hosted run `44079238701` on `a4bae51a` failed in the witness setup before any
HTTP case: the SQL generator's migration-row count comment changed after the
0090 registry row was added. This follow-up checks both actual source counts,
normalizes that single comment and compares SHA-256 digests of all remaining
SQL; its focused unit tests include a changed-row negative control. The updated
witness itself has not yet been run against PostgreSQL or CI.

Hosted run `44080733511` on `08ba2ac7` passed the 0079 witness and the
pre-0090 control. The empty-booking case returned 200 and lost its synthetic
sentinel and stage; the populated case returned `restore-failed`, lost both,
and reported a missing `request_key`. That endpoint result did not expose
SQLSTATE 42703. This follow-up adds a bounded, read-only column probe on the
identity-checked populated target after rejection, only if the booking table
exists; 42703 would be the subsequent probe's code, not the endpoint's. A
correct pre-reset refusal leaves this newly created target without that table,
so the probe is not a requirement to create a table after rejection. The
updated probe has not yet been run against PostgreSQL or CI.
