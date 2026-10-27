# Authority writer closure audit and bounded CLI repair

Audited source: `140e751`, 2026-10-27. Source-only evidence, not live schema
inspection. No database, credential changes, activation or Production operation.
Canonical readiness remains **NOT_READY**.

## Matrix (baseline line references)

| Field / writer | Source | Boundary and disposition |
| --- | --- | --- |
| User password/role/status/permissions | `lib/db.ts:15520–15578`; users PATCH, auth/password | Shared legacy fence before user locks, marker-held; no canonical writer. |
| User creation / provider association | `lib/db.ts:3175–3210,15294–15339`; users POST/PATCH | Shared legacy fence and signed proof; marker-held. |
| First admin | `lib/db.ts:3157–3172`; auth/setup | Exclusive fence and marker refusal before insert; not canonical owner appointment. Preliminary initialization is separate. |
| Password CLI | `scripts/reset-password.mjs:155–193` | Baseline direct update lacked marker/fence/transaction. This patch closes that path only, refusing canonical footprints. |
| Username / epoch-only revocation | No dedicated canonical command | Unsupported; frozen trigger overrides direct epoch assignment. |
| Canonical permission revision | `lib/staff-capabilities.ts:162–184` | Pure validator, not writer. Runtime `staff.permissions.edit` admits but does not implement editor. |
| Provider status/existence | `lib/db.ts:11384–11468`; parties POST/PATCH | HTTP legacy session held; direct helpers lack canonical fence. Do not reuse as canonical writers. |
| Implicit provider creation/link and role normalization | `lib/db.ts:1782–1791,2228–2251` | `ensureSchema` has no global marker guard; auto-link precedes SKIP_SEED. Demo seed requires allowLocalDemoData. |
| Account/provider/control epochs | frozen fixture `__tests__/fixtures/staff-identity/frozen-0076.sql:31–128` | No exclusive advisory fence. Account trigger locks control after target-row lock; control trigger locks owner. Fixture is not installation evidence. |
| Subjects/bindings/registry revision | `lib/staff-identity-substrate.mjs:78–107` | Exclusive-first, quarantine-only, CAS. No application or script caller found. |
| Generation/state/history initialization | same file `:60–71,110–124` | Exclusive-first quarantine operations; source restore always refused. |
| Owner/control/readiness | frozen fixture; `lib/staff-runtime-schema.mjs:6–41` | No supported preparation/seal service. Every UPDATE from ready refused. |
| Old realm/execution epoch | `lib/staff-authority-lifecycle.mjs:75–130` | Different obsolete proposal, table/row locks not canonical fence. Restore/reset call after domain writes; not durable generation revocation. |

Frozen account epoch increments on username/password/role/active/provider link/
permissions/mode changes; provider epoch increments on kind/active changes.
Permission revision lives inside JSON and is not automatically incremented.
Runtime explicitly compares current anchors, subject, username, credential HMAC,
account epoch, provider tuple and permission revision (`staff-operation-runtime.ts:
36–71`). Subsequent stale admission denial does not prove exclusion of an already
admitted read against an unfenced writer.

Ordinary staff request admission is marker-held, not universal writer closure.
The pre-auth initialization gap is a **previously documented gate**, now traced:
login limiters run before user lookup (`app/api/auth/login/route.ts:92–105`), and
both call ensureSchema (`lib/db.ts:15147,15188`). On cold initialization this can
reach the implicit writes above before eventual auth refusal. Do not claim this
patch fixes it. A bounded future repair should provide non-initializing installed
limiter primitives plus preflight ordering, preserve both limits and marker-free
bootstrap, and prove cold marker-bearing HTTP requests perform no DDL/authority
writes. Maintenance drain remains necessary; a preflight alone is not atomic
installer exclusion.

Restore is separately target-guarded and is not canonical restore support.
`verify-plans.mjs:45` and `verify-identity.mjs:52` create providers in explicit
new temporary databases. `verify-workflow.mjs:40–65,484` uses configured pool and
also writes providers: operational disposition is still required.

## Bounded repair contract

Plain-Node schema inspection is extracted without changing the exact application
marker list/query/refusals. It inspects the explicit public (or validated synthetic)
schema in pg_catalog; all reset data SQL is schema-qualified, so search_path cannot
redirect the credential write. The CLI never installs missing schema. Missing
permissions column/query errors fail closed. The inert raw permission classifier (including reserved keys, prototype and depth
rejection) is shared with the application; partial/mixed/future target documents refuse.

Dedicated reset connection: BEGIN READ COMMITTED → shared lifecycle fence → exact
schema marker/base check → locked target and legacy permission envelope → hash,
update, readback verification → COMMIT. Any failure attempts ROLLBACK; the CLI
always closes its connection. COMMIT transport failure is uncertain: never print
success, never retry, never claim rollback undid an already committed transaction.
Raw driver errors, credentials and account listings are not printed. Existing
argument parsing/routing remain unchanged; malformed URL errors are sanitized.
No canonical credential mutation is added. Arbitrary DBA writes remain outside
application fence guarantees.

## Validation checkpoint

Source-only Node tests cover ordering, marker/base refusal before credential work,
canonical/mixed target envelope refusal, marker-free legacy envelopes, rollback,
readback failure and uncertain commit without retry. Existing application unit
regressions must remain passing for the extracted boundary and marker constant.

`__tests__/legacy-password-reset.test.mjs` runs in ordinary unit CI.
`__tests__/postgres/legacy-password-reset.test.ts` runs in ordinary PostgreSQL CI,
with no opt-in or skip path. It uses the existing `_safe-target` guard and normal
PG18 global setup. It creates random owned schemas only; cleanup drops only those
schemas. Cases include real verification rollback, catalog relation/function/index/
column/trigger markers, malformed envelopes, missing permissions column, explicit
search_path independence and both shared/exclusive fence blocking directions with
observed backend blocker IDs. No CLI execution. The independently reviewed new test and existing legacy regressions passed via
the unchanged owned runner; see evidence below. Never manually execute against
an ambient or real target.

Next directory/editor slice remains synthetic: one exclusive-first permission
command with fresh actor/target proof, sorted locks, revision CAS and atomic audit;
no shared-to-exclusive upgrade, password/provider/control/history mutation or
activation. Issuer/read-snapshot prerequisites and built HTTP journeys remain gates.

## Reviewed synthetic evidence (code checkpoint `333ef49`)

- Normal unit regressions: four files, **161 passing tests** (reset, raw envelopes,
  staff capabilities, legacy evidence). New reset unit fixture contributes 31.
- Full TypeScript check: Node 22.23.3, 4 GiB heap, **exit 0**. Initial default Node
  24/2 GiB attempt exhausted heap; it was not a successful typecheck. Logs retained
  in task execution history and `/tmp/reset-boundary-tsc-v2.log` for the successful
  final code check.
- New PostgreSQL fixture: **15/15 passing** in owned run
  `recovery-evidence-20261027/pg18-2cehT1mn`.
- Existing PostgreSQL regressions: **28/28 passing**, three files
  (`legacy-staff-boundary`, `legacy-staff-writers`, `legacy-session-boundary`) in
  owned run `recovery-evidence-20261027/pg18-SidAHvIb`.
- Each run records source checkpoint/status, PG **18.6**, fresh empty public schema,
  unique cluster identity and owned data-directory proof. Both lifecycle logs show
  server stopped and `RUN_EXIT=0`. Only synthetic local credentials/data were used;
  the maintenance CLI was never executed.
- Node syntax checks pass for all changed `.mjs` files. Repository ESLint ignores
  `.mjs`/`.d.mts`; targeted ESLint exit 0 with ignored-file warnings is **not** a lint
  validation of those files. Their evidence is syntax, unit/PG behavior and typed
  consumer compilation. Full repository lint result is recorded separately.
- Source scanner regenerated only the inventory digest; **411 route methods,
  95 pages, 248 legacy-reference files, zero canonical-ready routes** are unchanged.
  Read-only drift check and all six scanner tests pass; explicit readiness remains
  **NOT_READY**. No runtime semantics changed in this documentation/digest refresh.

This is a local reviewed patch checkpoint, not publication, merge, deployment,
canonical password support, pre-auth initialization closure or activation approval.

## Combined local validation

At `7482037aa0e3ff813f7bf16cd8cb1db553f57231`, the combined reset repair,
standalone read-only probe and readiness inventory passed **784 unit files /
13,176 assertions** with Node 22 (`entry-safety-final-unit-FdSHtGvv`, exit 0).
The prior combined run at `7c7511b` had two failures, retained in
`entry-safety-unit-R3z0X0zy`: the scanner used Node test registration instead of
Vitest, and the standalone probe imported a Docker-excluded test helper.
Both were fixed without exclusions or weakened assertions. The probe now calls
the same ownership validator directly, with no database-URL fallback.

The exact final code also passed the seven focused scanner/production-context
assertions and full 4 GiB Node 22 TypeScript check (`entry-safety-focused-rOhAL8ZU`),
plus the three owned PostgreSQL 18.6 probe tests (`pg18-3yY5QKrf`), whose cluster
shutdown was confirmed. Earlier reset PostgreSQL acceptance above remains tied
to its recorded code checkpoint. No full PostgreSQL suite, browser acceptance,
Staging test or live activation is implied by the unit-suite result.
