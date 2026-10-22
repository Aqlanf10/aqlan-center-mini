# Patient appointment history index (0067)

## Scope and ownership

This additive optimization creates exactly one ordinary B-tree index:

`appointments_patient_history_idx (patient_id, scheduled_date, scheduled_time, id)`.

There are no predicate, uniqueness, included-column, table, row, reader, reminder, or financial-write changes. Existing indexes remain. The numbered file and runtime SQL must be byte-identical; both use the existing migration advisory lock, checksum checks, and per-file transaction. An unregistered same-name object fails closed rather than being adopted with `IF NOT EXISTS`.

0067 is owned by this slice. 0066 and 0068 remain owned by the separate finance work in PR #408; this integration includes their unchanged files and runtime registrations. Other reserved gaps remain unused. The migrator tests exact version membership, not a maximum-version watermark: the composed verification must cover both 0065 → 0067 → 0066 → 0068 and 0065 → 0066 → 0068 → 0067 using the actual reviewed #408 SQL. Those compatibility tests are not authority to deploy #408. Re-run the order proof if either migration's bytes change.

No reset table classification or backup policy changes are needed for an index on an existing table. Schema ownership must retain the same 16 reviewed pre-existing convergence findings, without new findings. The source-generated current-schema contract gains only this index; the source-generated preflight disclosure covers columns, constraints, and internal triggers, so its bytes should remain unchanged. Neither baseline adoption nor existing runtime registration debt is claimed resolved.

## Measurement, not a latency promise

A reproducible synthetic 100,000-appointment benchmark motivated the index. A recurring patient's first history page used 42,412 buffer events before and 73 after; warm local projection-query median was 19.547 ms versus 0.746 ms. All 126 pages containing 2,390 targeted records were identical. This is an optimization, not a reader correctness fix, and not a Production/API/browser latency promise.

The index does not give a universal 21-row scan bound. History still rejects active future rows for the selected patient; a planner may use a bitmap scan and top-N sort. Synthetic distributions, warm cache, 100k scale, shared local hardware, and no concurrent writes limit the measurements. Additional write/storage cost was not benchmarked. The measured synthetic index occupied about 3.88 MiB, which is not a sizing estimate for Production.

## Deployment implications

This migration uses normal `CREATE INDEX`, not `CREATE INDEX CONCURRENTLY`. Its transaction holds a table SHARE lock for the index build: ordinary reads can continue, but writes can wait, and existing writers can delay the build. The application startup path awaits the migration while holding the existing migration advisory lock, so startup/readiness can also be delayed. There is no zero-downtime claim.

Before any separately approved Production rollout, review the actual table size, write traffic, active transactions, available storage, operational lock/statement limits, deployment readiness limits, and a suitable maintenance window. Keep all existing target-classification, backup, reset, checksum, and migration-lock safeguards. Do not disable timeouts, remove guards, or alter applied checksums to force a rollout. The repository CLI continues to prohibit Production/unknown-remote apply. A lock timeout or SQL error must roll back both index and registry row; a later controlled retry uses the same bytes.

A concurrent build would require a separately reviewed non-transactional migration/registration design; simply adding `CONCURRENTLY` to this transactional engine is invalid. Do not pre-create an index and fabricate its registration. This slice neither selects nor executes an actual Production deployment procedure. Application rollback does not require dropping this additive index; any removal is a separate reviewed operation.

## Original branch-only migration-order evidence

The original 0065 → 0067 → 0066 and 0065 → 0066 → 0067 orders passed on disposable PostgreSQL 18.6 databases using #408 commit `ee10eb1544b3e9027db5110e886241650f0fcad9`, SQL blob `291d11d896f5cdd5d1bd6f9e5cdbc1ac5b4d01eb` (SHA-256 `28bd13b5ca9f34d9a9010aade759d91fb398b47f30a78433e5e663ce90464dac`). The finance bytes were supplied only to the ephemeral test, never copied into this branch's application migration set.

Each order preserved every existing application table's row snapshot, including synthetic patients, appointments, invoices, invoice items, payments, and cashier shifts. Both ended with identical detailed catalogs, all 61 exact registration rows, a valid/ready nonunique unfiltered index, consistent migration status, and empty idempotent reruns. The index migration SHA-256 was `4717e0a68ee8ba9aee745000c8561d4b9d6481f48f41c094518fac76c1bdacc6`. This does not approve or validate all business behavior of the separate finance feature.

## Composed local integration evidence

The isolated candidate combines nonfinancial `e6bf8c179eb49723392aa843b2101c4b9f755f79`
with finance `60abcd95e9b25a89ce743252687a45cb24f2ff74`, preserving both ancestries.
On disposable PostgreSQL 18.6, both `0065 → 0067 → 0066 → 0068` and
`0065 → 0066 → 0068 → 0067` preserved every existing application-table row
snapshot, produced identical detailed catalogs and 62 exact registry entries,
and reran idempotently. The 0068 SHA-256 is
`07864df6fb6fb98742fd35efebcd2f33f23a1b26c90fb7df16f54605cf62aa42`;
0066 and 0067 retain the hashes reported above. All four newly added finance
tables remained empty during this migration-order proof.

Canonical schema regeneration and ownership characterization retained exactly
16 pre-existing open convergence findings and zero unexpected differences.
This compatibility proof does not establish financial business acceptance,
Docker/full CI, release approval, or Production readiness of either input.
