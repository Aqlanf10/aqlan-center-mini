# Private prefix-aware cold-start reconciliation

Base `00c74e22a7d1952f4a739836972409a200873489`, isolated private branch.
The normal application `ensureSchema`, legacy registration, official restore,
backup archive, numbered migrations and route wiring are unchanged. This
standalone method provides a candidate seam, not active behavior on Staging
or Production and not a cutover/issuance approval.

In the legacy branch, cold startup strips non-digits across all stored
`patient_number` values when deriving the public P maximum. That behavior is
not redefined implicitly: it has a prior compatibility test for ambiguous
legacy numbers. When using a proven multi-prefix namespace instead, the
unwired reconciliation:

1. Locks patient import exclusively, managed numbering config, then the
   patients table for read stability. It validates the independently witnessed
   canonical sidecar against the exact target namespace under the same lock.
2. Checks surviving file IDs against the corresponding prefix's *consumed*
   high-water (a pending number has not been used), and retired-alias ownership.
   Missing, stale, malformed, ambiguous or incompatible evidence refuses
   without modifying any patient ID or managed counter; it doesn't silently
   advance a managed A sequence from the target's imported rows.
3. Mirrors **only** managed P to `public.patient_number_seq` with the existing
   transactional sequence helper. The independent witness must also include
   source legacy P, not merely a checksum of the managed namespace. If either
   source legacy P or the target's public P is ahead, it holds instead of
   rewinding either counter. There is no new fixed floor for any prefix.
4. Rechecks independent proof before commit; any change rolls back the mirror
   update. A real activation still needs a durable trusted lineage/legacy
   witness, a source-side writer fence held through cutover, and configuration
   that never falls back to legacy during a failed or partial activation. This
   method does not deliver such a provider or fence. A deployment must not
   run the old broad startup reconciliation in the configured mode.

## Executed synthetic checks

The newest eligible A remains A-900001 with A-900000 in history: an attempted
A+1500 rewind is refused, and retained P-00042/P-07000 state is not raised
to A's watermark. The restore-shaped low public P target can be advanced
only to the independently proved P value, idempotently, without renumbering
surviving records. A live A row occupying the proposed next number holds
rather than guessing; a mismatched namespace or stale digest holds even if
apparently newer. Tests also cover independent high/changed P, a target P
that is already too high, revocation on a second witness read, an ambiguous
identifier, and an alias owned by a different patient.

Run only on an owned synthetic PG18 cluster with validated test URL:

```sh
npx vitest run --config vitest.config.postgres.mts \
  __tests__/postgres/patient-numbering-cold-reconciliation.test.ts \
  __tests__/postgres/patient-numbering-adapter.test.ts \
  __tests__/postgres/patient-numbering-recovery-projection.test.ts
```

Tests create random, identity-proven local databases and drop only those
databases after closing pools. No actual clinic data, backups or environments.

Result on Node 22.23.3 / PostgreSQL 18.6: 29 focused tests passed (11 new
cold reconciliation, 18 adapter/projection), targeted ESLint and strict
source TypeScript passed; local cluster stopped.


## Paired audit and exact sequence proof follow-up

An owner reservation can set `is_called=false` again while leaving
`historicalThrough` unchanged. A surviving A-01500 is valid after reserving
A-02000 if canonical, matched pre-reservation audit and receipt prove the
same-prefix previously consumed watermark. The seam includes only that
validated BEFORE state; it never treats an unused pending number or the gap
before it as issued. The owned PostgreSQL regression verifies both the
valid A-01500 and refusal of an unproved A-01501 file.

The independent source witness is stable only when both legacy P
`lastValue` and `isCalled` match exactly across the transaction. Equivalent
effective next values are not equivalent evidence. The resulting locked
public P mirror must also exactly match the managed P pair, and an already
ahead raw state is held, never rolled back just to normalize representation.

A validated numbering sidecar, even with these checks, does not bind to the
exact bytes of its containing/sibling application archive or prove completeness
of the restored patient dataset. Application archive identity, authenticated
source-side fencing and exact cutover binding remain separate open conditions.
This follow-up remains unwired, private, and not a release gate pass.

Follow-up result: 32 focused PostgreSQL 18.6 tests passed (14 reconciliation,
18 adapter/projection), targeted ESLint and strict source TypeScript passed,
and the owned local cluster stopped.
