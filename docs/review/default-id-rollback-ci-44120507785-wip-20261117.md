# Synthetic DEFAULT ID rollback witness: CI observation

This is a test-only investigation, not a product fix or a release decision.
The published witness is commit `9de64e09f0dcd20c8d59d4d1652abed2a3aad12f` on
`codex-default-id-rollback-config-wip-20261117`. The synthetic standalone job
in [run 44120507785](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/44120507785)
failed; at the time of this report, the complete run was still in progress.

All four cases (empty or nonempty target at restore entry, with the prepared
sequence `is_called` true or false) reached the injected late duplicate. In
each case the separate actor's reservation completed before replay was
released. After replay failed, the observed next ID candidate was below its
pre-replay floor. Each case then performed an actual `INSERT` using the ID
default, checked the returned synthetic fields and persisted row, and checked
the post-insert sequence state. The fixed diagnostic classifications printed
after those checks say the inserted ID was at or below the reserved ID and
below the pre-replay floor. No numeric values are reported here.

Each case failed its first final assertion, the no-regression assertion. The
subsequent assertions comparing the inserted ID with the prior floor and the
reservation were **not executed**; the classifications preceding them are
observations, not passing assertions. The job annotations identify this same
first assertion in all four cases. The standalone job also had five failures
from the inherited sequence-atomicity suite: two files failed, two passed,
with nine failed and five passed tests in total. The standalone build and
runtime-boundary steps succeeded, but this does not establish full CI success.

The actor uses direct, non-cooperating SQL; this does not establish that the
normal `createPatient` path reserves an ID separately from its insertion.
The `afterFailure` reading occurs after both replay and reservation promises
complete. It is therefore not an isolated snapshot at rollback if a future
implementation blocks the reservation until rollback. In this run all four
reservations completed before release. The test checks the supported synthetic
sequence configuration before replay, after failure and after insertion; it
does not establish behavior for other cache or increment configurations or
solve outstanding concurrency and policy questions.

Before the insertion, the test compared selected source patient rows, target
public-table data digests, migration-registry digest, target patient rows,
archive bytes, stage marker and target identity with their snapshots. After
insertion it checked the persisted synthetic actor row, the remaining patient
rows, source patient rows, archive bytes, marker and identity. These are the
checks reached in this witness, not a proof about every database object or
about product data. The CI databases and staging evidence were synthetic;
the writer's internal backup scratch is temporary as described in the witness
documentation. No conclusion about a real database is implied.
