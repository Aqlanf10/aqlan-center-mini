# Prescription and booking migration extraction — WIP

This branch is an **incomplete schema extraction**, not an integration-ready candidate. It is based on `79de30e0e0f537cc1b59536b84beb0a4e08d9a7c`; sources were copied from #541 `4e88b6a791d859cc9a066888f54c0eddff91dde7`. Do not deploy or merge this branch.

The byte-identical source contracts and runtime schema modules for 0090–0093 are present, and both CLI and runtime migrators invoke their source, registry and catalog guards while holding the existing migration lock. The runtime path registers all four. No source orthodontic migration, UI or writer was imported.

| Version | SHA-256 | Contract |
| --- | --- | --- |
| 0090 | `608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25` | historical booking preferences, request key/hash and partial unique index |
| 0091 | `d075fd6222bf8204c2e7de2ea536b66c8f8db71178eaa70de2294f0dba227044` | prescribing doctor identity |
| 0092 | `587529f146e1bf72fc654cff4fbacb0f233729efaadf26e44fdfde8e802af240` | prescribing doctor name snapshot |
| 0093 | `7bf8a45c76d1a52b0efa0fae0b0427fb33a079b2be1aced8fc2560e8cf8336dc` | immutable issuance command, scope binding and completed-receipt constraints |

Source tests passed on PostgreSQL 18.6 using newly created, identity-checked synthetic databases on the local disposable server: `prescription-migration-lineage` 8/8 (preserved historical booking row and registry, idempotence, conflict, malformed registry and schema drift) and `prescription-issuance-schema` 21/21 (durable receipt binding, rollback, immutability, replay insertion and tamper detection). No patient data was used. These tests do not establish product integration.

The historical prescription reader was separately trialled against this base. Its source PostgreSQL test produced **1 passed / 1 failed**: the base `sanitizeRxItems` drops the saved `selection.amount`, so importing only the reader would silently omit part of historical content. The experimental reader and test were removed from this checkpoint; the failure is evidence for extracting the associated prescription model and provenance as a coherent unit. Do not alter this test to make the partial extraction pass.

Before integration, complete the issuance transaction, command fingerprint/recovery, patient and visit lock and delete/merge protections, durable reset/backup/full-restore behavior, clinical authorization, UI and controlled medication catalog permissions. Reconcile the canonical settings writer and current-authority checks without importing mixed cephalometric changes from `6d9610d4`. The current schema manifests, migration lists, ownership assertions and build preflight also need coherent updates and full test runs. Fresh and historical migration, real concurrent issuance/retry, revoked authority, negative HTTP and UI journeys and backup restoration need independent synthetic evidence. No full unit, build, browser or final-head CI acceptance is claimed.
