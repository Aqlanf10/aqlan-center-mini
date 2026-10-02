# Legacy visit-doctor foreign-key compatibility

**Status: characterized compatibility debt; baseline adoption remains blocked for the legacy variant.** No supported doctor-deactivation or account-linking failure is demonstrated by this difference. This is not a schema-convergence decision.

## Why two installed states are possible

Current [`ensureSchema()`](../lib/db.ts) declares `visits.doctor_id` twice with `ADD COLUMN IF NOT EXISTS`: first with `ON DELETE SET NULL`, later with the default `NO ACTION`. The first declaration wins on a fresh database. A preexisting column and FK are left unchanged. Immutable [`0001`](../migrations/0001_baseline_schema.sql) has the same effective ordering; migrations 0002–0039 do not replace this FK.

Source history provides a plausible upgrade mechanism:

- [2026-08-28, `57809e51`](https://github.com/Aqlanf10/aqlan-center-mini/commit/57809e51f5e36a33c331dda4257ad79b40945b64) introduced the default-action declaration
- [2026-09-04, `2b1df781`](https://github.com/Aqlanf10/aqlan-center-mini/commit/2b1df781edac97ef5625bf3c78fa9e69eba17bba) added the earlier `SET NULL` declaration; its immediate parent contained only the original declaration

This proves neither the historical contents nor the upgrade sequence of Production. The legacy test fixture is a deliberately minimal synthetic predecessor, not a Production restore.

## Executable characterization

[`legacy-doctor-fk-compatibility.test.ts`](../__tests__/postgres/legacy-doctor-fk-compatibility.test.ts) runs 12 real-PostgreSQL tests over three paths:

1. Fresh runtime initialization: validated, nondeferrable `SET NULL` FK
2. Fresh complete numbered migration chain: the same FK, retained by subsequent populated runtime starts
3. Synthetic preexisting `NO ACTION` FK and referenced visit: the original constraint OID, definition, and attribution survive current initialization and repeated cold starts

For every path the suite exercises real application database functions for doctor-party deactivation/reactivation, account deactivation/reactivation, refusal to link an inactive doctor, and unlink/relink of an active doctor. Visit attribution and the complete commission-history rows remain unchanged. Party activity and account activity are separate: party deactivation does not disable an active account lookup; account deactivation does. This is existing behavior shared by both FK variants.

Both variants reject orphan assignments and allow an explicit null or valid reassignment. A raw disposable doctor created **after** startup, without commission history, isolates deletion semantics: `SET NULL` deletes the dummy party and nulls the surviving visit reference; `NO ACTION` refuses the deletion. These are database characterization statements, not an application doctor-deletion flow.

The supported [`parties` route](../app/api/parties/[id]/route.ts) exposes a PATCH activity change, with no doctor DELETE export; [`users`](../app/api/users/[id]/route.ts) exposes account activity and doctor linking. Normal `createParty(kind='doctor')` also creates commission history. Its independent [`ON DELETE RESTRICT` FK](../lib/commission-history-schema.ts) rejects deletion on both paths. Tests cover a history-only doctor and a doctor with a visit; rejection preserves the doctor, visit attribution, account reference, and history, including rollback of any earlier `SET NULL` effects. HTTP authorization and browser journeys are not claimed by these database tests.

## Baseline refusal and safety boundary

The unchanged [baseline probe](../lib/baseline-probe.ts) accepts both fresh paths. It rejects the synthetic legacy path solely for the missing expected signature:

`visits|FOREIGN KEY (doctor_id) REFERENCES parties(id) ON DELETE SET NULL`

All other baseline tables, columns, constraints, indexes, and triggers pass. `migrate({apply:false})` likewise refuses the legacy database with `BASELINE_SCHEMA_MISMATCH` and leaves `schema_migrations` absent. Tests compare the complete projected public catalog, registry evidence, and fixture rows before/after the probe and dry run; the temporary probe schema is gone afterward. This probe uses rollback-only temporary DDL. It is **not** the SELECT-only Production preflight and must not be presented as one.

The shared [test-target validator](../__tests__/postgres/_safe-target.ts) wraps the existing ownership environment checks and adds a strict URL-query allowlist: no parameters, or exactly one `sslmode=disable`. This matters because `pg` accepts query keys such as `host` that can override a URL's apparently loopback authority. Encoded override keys, duplicate parameters, other SSL modes, and all other query options are rejected. The [PostgreSQL global setup](../__tests__/postgres/_global-setup.ts) applies this guard before its first client is constructed, and the FK fixture repeats it before its own connections. The unchanged ownership validator alone does not enforce this query allowlist.

Both guarded paths require a loopback `aqlan_p1_test` target and reject Production classifications and known Railway markers from the original environment before any stubbing. Global setup retains a canonical `DATABASE_URL` fallback only when `TEST_DATABASE_URL` is unset; a supplied invalid or empty test URL never falls back. The FK fixture still requires `TEST_DATABASE_URL`. [Unit regressions](../__tests__/postgres-test-target.test.ts) use a fully mocked `pg` client to prove unsafe inputs are rejected without constructing or connecting a client.

Before database creation, the suite checks PostgreSQL major 18 and validates each generated name. It creates unique `aqlan_schema_ownership_fk_…` databases without a preemptive drop, drops only fixtures it successfully created, attempts all cleanup steps, fails on cleanup errors, and verifies each generated database is absent. This test-infrastructure enforcement neither changes application/runtime connection behavior nor weakens existing per-suite guards. No runtime DDL, immutable migrations, baseline manifest, probe acceptance, or ownership open-findings manifest is changed.

Run against the repository's disposable PostgreSQL 18 test service:

```sh
TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable' \
  npm run test:postgres -- __tests__/postgres/legacy-doctor-fk-compatibility.test.ts
```

## Evidence limits and next decision

The preceding bounded #178 Production preflight evidence matched source-known property hashes to a `NO ACTION` candidate. That remains an **inference from exact property hashes**, not a plaintext Production definition or proof of its historical origin. One withheld internal-trigger identity remains unknown. This characterization performs no additional Production query or inference about that identity. The supplied Production version was PostgreSQL 18.6; the local 2026-10-02 focused run used Node 22.23.3 and PostgreSQL 18.4, so minor-version parity is not claimed.

This is legacy-versus-fresh debt. It is not one of the 16 fresh-numbered-versus-fresh-runtime findings in the [ownership manifest](../schema/schema-ownership-open-findings.pg18.json), and no manifest entry is added. Full schema equivalence, restore proof, baseline adoption, and runtime-DDL retirement remain unproven. Future convergence needs an explicit doctor-retention contract and a reviewed migration strategy with synthetic upgrade/restore evidence and Production prerequisites. Do not drop/re-add the FK, weaken action comparison, or rewrite `0001` to make the baseline green.
