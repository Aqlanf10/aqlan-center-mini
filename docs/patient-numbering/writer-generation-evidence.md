# Private cooperative writer-generation proof

Base: `2f7e8a4629dea8a89c7f9c71a8fbc173529df900`. This is a standalone
synthetic contract, deliberately restricted to generated fixture schemas.
The audit-floor/cold-start seam is unchanged. There is no numbered migration,
product caller, startup toggle, network storage, real owner or account change.

The trusted fixture has one lineage/mode/generation row. Every cooperative
writer must enter its transaction through shared row admission **before**
acquiring domain locks, use its supplied PG client, and keep that
transaction through the write. Never use a pool directly or start/commit a
second transaction from the callback. Matching mode, exact generation
and lineage are checked under the transaction lock; a historical transition
receipt is not an admission token. Unknown or stale state fails closed;
FENCED admits no writer. Rechecking the same transaction ID protects the
contract but cannot undo a callback that deliberately committed outside it.

The transition holds an exclusive lock and permits only monotonic
LEGACY → FENCED → MANAGED. Each transition and its exact idempotency receipt
commit together. A matching retry returns the original receipt and a distinct
current-state readback; reuse with different intent refuses. MANAGED also
requires an explicit handoff proof callback that is unavailable by default.
The test provider is synthetic only; it does not prove a real owner,
authenticated source archive, backup freshness, or an operational fence.

The race test observes PostgreSQL actually blocking a fence behind a
cooperative in-flight legacy transaction. The transition only commits after
the writer finishes; later admissions are refused. Actual managed allocator
calls in 24 concurrent admitted transactions produce unique A-01500 to
A-01523, and old/unknown tokens never reach the allocator. Tests also cover
durable same-key and concurrent replay, exact conflict/stale state, missing
proof/rollback, and malformed or exhausted generations.

## Critical limit: old binary and source activation

An old binary that does not read the gate is not constrained by it. An
explicit owned-PG test shows a direct legacy-like synthetic write still
succeeds during FENCED. Before any real transition, independently demonstrate
a **database-level operational fence** that old binaries, routed tasks,
importers, workers and other writing sessions cannot bypass; drain and verify
those writers first. This change does not issue revocations, modify accounts
or credentials, or propose executing an operational fence automatically.

A restored stale generation row is not a trusted current epoch. Independent
lineage/epoch attestation, exact application archive identity and inspected
recovery completeness, owner/security integration, and a source-side writer
fence through cutover are still required. Do not wire the proof as a mount or
fall back to LEGACY when readiness is unknown.

Run only on owned synthetic PG18:

```sh
npx vitest run --config vitest.config.postgres.mts \
  __tests__/postgres/patient-numbering-writer-generation.test.ts \
  __tests__/postgres/patient-numbering-cold-reconciliation.test.ts
```

Executed on Node 22.23.3 / PostgreSQL 18.6: 22 tests passed (8 new generation
checks, 14 prior cold-reconciliation regressions). Targeted ESLint and strict
source TypeScript passed; the owned local cluster was stopped.
