# TD-00 — Technical Debt Master Register

**Repository:** `Aqlanf10/aqlan-center-mini`
**Audit baseline commit:** `5308418d3ae6f77a7c4520e7fc6e1eed59946961` (`main`, merge of PR #41)
**Audit date:** 2026-09-17
**Methodology:** AUDIT → REUSE → EXTEND → TEST → DOCUMENT
**Scope:** AUDIT ONLY. No product behavior, migration, database schema, Railway configuration, or production data was changed by this document. This register is evidence-based; every claim cites a file and line at the baseline commit.

---

## 1. Baseline Snapshot (as verified from the repository)

| Item | Recorded state |
|---|---|
| `main` HEAD | `5308418d3ae6f77a7c4520e7fc6e1eed59946961` (merge of PR #41 `feat/appointment-reschedule`) |
| Open pull requests | #35 `docs/repository-governance` → `main` (unmerged at audit time) |
| CI | Single workflow `.github/workflows/ci.yml` (job: *Typecheck, Lint, Test, Postgres, Audit, Build*). Latest run on `main` (5308418): `completed / success` at 2026-09-16T20:28:36Z |
| Deployment | Railway builds from `main` via Dockerfile (`railway.json`: healthcheck `/api/health`, timeout 120s, restart ON_FAILURE, 1 replica). Deployment state is visible only on the Railway dashboard; from the repository side, the merge-to-deploy chain is confirmed by `docs/REPOSITORY_GOVERNANCE.md` (open PR #35) and `railway.json` |
| Migrations | 11 numbered SQL files `migrations/0001..0011` (baseline `0001` = 55 tables). Registry `schema_migrations` with SHA-256 checksums, advisory lock, baseline-adoption probe (`lib/baseline-probe.ts`). **No migration has been applied to production — documented historical state, not a fresh fact** (source: `docs/DATABASE_MIGRATIONS.md` §"حدود معروفة"; the production database was not accessed by this audit — fresh read-only verification is scheduled as TD-01B step 1) |
| Test suite | 189 test files (150 unit on PGlite + 22 PostgreSQL integration + 17 HTTP-security with Playwright/Chromium; ~2,137 unit test cases), 18 operational verification journeys (`npm run verify:ci`, `scripts/verify-ci-journeys.mjs`), plus typecheck, lint, dependency audit, raw-body scanner, build |
| API surface | 134 `route.ts` files under `app/api/**` (97 expose POST/PUT/PATCH/DELETE) |
| Screens | 67 `page.tsx` files under `app/**` (including 13 print screens) |
| Schema ownership mechanisms | (1) numbered SQL migrations; (2) `ensureSchema()` runtime DDL in `lib/db.ts`; (3) provisioning/restore scripts (`scripts/provision-mini-database.ts`, `scripts/restore-full.ts` + `lib/restore/`); (4) generated schema artifacts (`schema/current-schema-contract.pg18.json` from `ensureSchema`; `schema/baseline-schema-manifest.pg18.json` from migration `0001`) with CI regeneration gates |
| Code hygiene markers | 0 `TODO`/`FIXME`/`HACK`/`XXX` in source; 10 `eslint-disable` directives; ~40 `as any` casts; no `console.log` in `lib/` or `app/` |

---

## 2. Severity Framework

| Level | Meaning (as defined for this audit) |
|---|---|
| **P0** | Threatens data/financial integrity, a security boundary, or recovery/schema integrity. Must be scheduled before feature work. |
| **P1** | Affects daily clinic-operations correctness or owner trust in a visible way. |
| **P2** | Architectural duplication, environment inconsistency, or drift risk that raises the cost/correctness of every future change. |
| **P3** | Cleanliness, readability, documentation currency, minor tooling. |

---

## 3. Register Summary

| ID | Sev | Title |
|---|---|---|
| TD-REG-001 | P0 | Schema ownership split: production migration adoption state is not independently proven; the current deployment image cannot execute the numbered migration runner |
| TD-REG-002 | P1 | `ensureSchema()` executes DDL on the first request of every cold process (285 call sites) |
| TD-REG-003 | P1 | Seed data (staff accounts, service catalog, expense categories) lives inside `ensureSchema()`, not in a governed artifact |
| TD-REG-004 | P1 | `finance.base_currency` setting is a dead control in the running app; money code uses the hardcoded `CLINIC_BASE_CURRENCY = "YER"` |
| TD-REG-005 | P2 | No automated cross-check that migrations 0002+ stay equivalent to the `ensureSchema` additions they mirror |
| TD-REG-006 | P2 | Authorization policy is scattered across 91 route files (151 inline checks); no central HTTP permission matrix |
| TD-REG-007 | P2 | `lib/db.ts` is a 17,729-line monolith holding every domain |
| TD-REG-008 | P2 | Environment drift: local PostgreSQL 16.13 vs CI/production PostgreSQL 18; committed schema artifacts may be generated on either |
| TD-REG-009 | P2 | Audit-write responsibility is split between route and lib layers with no per-mutation coverage matrix |
| TD-REG-010 | P2 | No staging environment in the deploy story (`main` → production only) |
| TD-REG-011 | P2 | Three scheduling entry points share capacity judges by convention, not by a single enforced service boundary |
| TD-REG-012 | P2 | Patient duplicate detection is heuristic-only; no blocking constraint or production duplicate census |
| TD-REG-013 | P2 | `test:postgres` and `test:security-http` are outside the default `npm test` (local parity requires explicit setup) |
| TD-REG-014 | P3 | `docs/DATABASE_MIGRATIONS.md` is stale: documents migrations 0001–0005 while the repo carries 11 |
| TD-REG-015 | P3 | ~40 `as any` casts concentrated in AI tool registry and UI select handlers |
| TD-REG-016 | P3 | 10 `eslint-disable` directives (2 `react-hooks/exhaustive-deps` need justified review) |
| TD-REG-017 | P3 | Legacy compatibility bridges catalogued (settings validator, proxy origin trust, `legacy_type`, tab maps, identity fixes, announcements migration) |
| TD-REG-018 | P3 | Silent-catch inventory: a few AI-provider paths degrade silently (`catch(() => []`, `catch(() => ({} as any))`) |
| TD-REG-019 | P3 | Node version unpinned for local development (no `.nvmrc` / `engines`) |
| TD-REG-020 | P3 | `README.md` is a 71 KB monolith mixing operator manual, user guide, and dev guide |
| TD-REG-021 | P3 | Backup subsystem spans 15+ modules — intentional layering, but high onboarding cost |
| TD-REG-022 | P3 | `docs/TECHNICAL_DEBT_REPORT.md` (v1.0.0) is a narrow point-in-time closure report, superseded by this register |
| TD-REG-023 | P3 | PGlite/pg driver divergence shim `(res as any).affectedRows` in `lib/db.ts:156` |
| TD-REG-024 | P3 | Open PR #35 (repository governance) awaiting owner review — governance doc not yet on `main` |

**Positive findings (no action):** zero TODO/FIXME markers; zero `console.log` in production code paths; `.env.example` documentation covers all env vars read by code (limits/rate vars are read dynamically via `envNumber()` in `lib/security-limits.ts:13`); secrets are not committed (secret scanning + push protection enabled per PR #35).

---

## 4. Detailed Register Entries

### TD-REG-001 — P0 — Schema ownership split

> **Corrected statement (owner review of PR #42, 2026-09-17):** Production
> migration adoption state is not independently proven; the current deployment
> image cannot execute the numbered migration runner. The evidence below is
> separated into (A) a **proven deployment-image limitation**, (B) **documented
> historical state**, and (C) **production DB state requiring fresh read-only
> verification**. No production-database claim in this entry is asserted as a
> fresh fact.

| Field | Value |
|---|---|
| Category | Schema ownership / recovery & schema integrity |
| Evidence A — proven deployment-image limitation (verified from the repository at the baseline commit) | `Dockerfile` runner stage copies only `.next/standalone` + `static`; `migrations/` is not carried into the image and `tsx` is a devDependency (`package.json`); `docker-entrypoint.sh` invokes no `db:migrate`. **The current deployment image cannot execute the numbered migration runner** — a repository-proven fact, independent of any database state |
| Evidence B — documented historical state (repository documentation; not independently verified by this audit) | `docs/DATABASE_MIGRATIONS.md` §"فترة الانتقال المزدوجة" and §"حدود معروفة": *"لم يُطبَّق النظام على قاعدة الإنتاج بعد"* (the migration system has not been applied to the production database) and *"ensureSchema ما زال يركض عند أول طلب لكل عملية"* (`ensureSchema` still runs on the first request of every process). `lib/schema-preflight.ts:9-15` confirms the retirement of `ensureSchema` was deliberately deferred. These are documentation claims recorded at the baseline commit; this audit performed no production access and did not verify them against the live database |
| Evidence C — production DB state (unverified; requires fresh read-only verification) | The actual contents of `schema_migrations` in the production database — and whether the live production schema matches the migration chain, the `ensureSchema` contract, or neither — is **not independently proven by this audit**. TD-01B step 1 is a read-only production preflight (SELECT-only, zero DDL, zero writes) that converts A/B/C into proven fact before any adoption decision |
| Code-mechanism evidence | `lib/db.ts:278` (`ensureSchema()`), full DDL 281–2300 incl. hand-mirrored equivalents of migrations 0002–0011 (e.g. payment idempotency cols at `lib/db.ts:1809-1813` = `migrations/0003`; `material_rate_history` at `lib/db.ts:1824` = `0004`; `waiting_list_id` at `lib/db.ts:780-783` = `0011`) — both schema paths exist in code and are maintained by hand |
| Affected files | `lib/db.ts`, `migrations/*`, `Dockerfile`, `docker-entrypoint.sh`, `lib/migrations.ts`, `scripts/db-migrate.ts`, `schema/*` |
| Runtime impact | Proven: the only schema mechanism reachable from a running deployment is `ensureSchema()` runtime DDL on the first request after each cold start. Documented (not independently verified): the numbered migration chain — the intended source of truth — has not been applied to production and is exercised only in CI/tests |
| Data/financial/security impact | Schema integrity risk conditional on the A/B/C facts above: the two paths are maintained by hand and nothing enforces their equality (see TD-REG-005). A missed `ensureSchema` mirror silently changes what fresh/restored databases look like versus migrated ones; a missed migration changes what production will look like on the day of adoption. The production-side share of this risk cannot be sized until the TD-01B read-only preflight runs |
| Canonical owner | `migrations/` chain + `schema_migrations` registry (intended, per `lib/migrations.ts:9` header) |
| Suggested fix | TD-01A first (ship a runnable migration runner into the deployment path; rehearse baseline adoption + migrations 0002–0011 on a staging clone; prove fresh-DB/restored-DB equivalence); then TD-01B (read-only production preflight → owner-approved adoption → staged `ensureSchema` retirement: kill-switch env first, removal after a production soak). No production step before the preflight and the owner's explicit approval |
| Dependencies | TD-REG-002, TD-REG-003, TD-REG-005; sequenced after the TD-08A pre-adoption backup/restore proof |
| Required regression tests | Existing: `__tests__/migrations.test.ts` (14), `__tests__/postgres/baseline-adoption.test.ts` (10), `migration-advisory-lock.test.ts` (4), `scripts/verify-schema.mjs` journey, CI baseline-manifest verify. To add: TD-01A — deployment-path test proving the shipped image can execute `db:migrate` against a fresh PG18; TD-01B — the read-only preflight report as a reviewed artifact |
| Independently fixable | No — it is the anchor item for TD-01A/TD-01B and must be sequenced with the TD-08A backup/restore proof |

---

### TD-REG-002 — P1 — `ensureSchema()` DDL on every cold start

| Field | Value |
|---|---|
| Category | Runtime behavior / performance / schema integrity |
| Evidence | `lib/db.ts:278-279` (memoized promise per process); 272 `await ensureSchema()` call sites inside `lib/db.ts` alone and 285 across `lib/`+`app/` (rg count). `lib/db.ts:243-254` (`schemaReady` promise, `schemaReadyReset`). `docs/DATABASE_MIGRATIONS.md` §"حدود معروفة": *"ensureSchema ما زال يركض عند أول طلب لكل عملية (بارد) — إبطاء أول طلب يُعالَج في P2"* |
| Affected files | `lib/db.ts` (all call sites), every API route that transitively triggers it on cold start |
| Runtime impact | First request after every deploy pays a large idempotent DDL run (hundreds of `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` statements, 343 DDL statements counted in `lib/db.ts`); Railway healthcheck (120s timeout) races this |
| Data/financial/security impact | No direct corruption (idempotent), but DDL-under-request extends the window where a slow/statement-heavy cold start can time out the healthcheck and trigger restart loops (restart policy ON_FAILURE, 10 retries) |
| Canonical owner | Deployment-time migration (after TD-01A/TD-01B), not per-request code |
| Suggested fix | Covered by TD-01A/TD-01B: move DDL to the deploy step (staging first, production only after the read-only preflight and owner approval); `ensureSchema` becomes a no-op guard or is removed |
| Dependencies | TD-REG-001 |
| Required regression tests | `__tests__/database-runtime.test.ts`, `scripts/verify-schema.mjs` journey (already builds from scratch) |
| Independently fixable | No |

---

### TD-REG-003 — P1 — Seeds inside `ensureSchema()`

| Field | Value |
|---|---|
| Category | Data governance / schema ownership |
| Evidence | Staff defaults, starter services (`STARTER_SERVICES` `lib/appointment-services.ts:176`), expense categories with budget figures (`lib/db.ts:2196-2208`), announcements legacy migration (`migrateAnnouncementsFromLegacy` `lib/db.ts:6448`), `LEGACY_IDENTITY_FIXES` (`lib/db.ts:6093`, applied at `lib/db.ts:2136`). `docs/DATABASE_MIGRATIONS.md` §"بذور البيانات ليست هجرات": seeds deliberately stay in `ensureSchema` with `SKIP_SEED=true` on restore |
| Affected files | `lib/db.ts`, `lib/appointment-services.ts`, restore path (`scripts/restore-full.ts`, `lib/restore/`) |
| Runtime impact | First-boot behavior of any new/restored database depends on code constants; `SKIP_SEED` flag is a hidden coupling between restore and seed logic |
| Data/financial/security impact | Budget/category figures are clinic-financial data living in code, not in a reviewable data artifact; a code change silently changes future fresh installs' starting books |
| Canonical owner | Seed/provisioning script governed by review (e.g. `scripts/provision-mini-database.ts` extended), distinct from schema migration |
| Suggested fix | TD-01A stage 2: extract seeds into an explicit provisioning path invoked deliberately (setup/restore), keeping `SKIP_SEED` semantics |
| Dependencies | TD-REG-001 |
| Required regression tests | `__tests__/postgres/restore-drill.test.ts` (8 tests), `__tests__/services-catalog.test.ts`, `__tests__/announcements.test.ts` |
| Independently fixable | No |

---

### TD-REG-004 — P1 — `finance.base_currency` is a dead control

| Field | Value |
|---|---|
| Category | Finance / source-of-truth conflict |
| Evidence | Setting defined and editable: `lib/settings.ts:24` (`"finance.base_currency"` key), default `lib/settings.ts:78`, metadata `lib/settings-definitions.ts:195-198`, label *"العملة الأساسية — كل التقارير تُحسب بها"*. Actual money code uses the compile-time constant: `lib/money.ts:25` `CLINIC_BASE_CURRENCY: Currency = "YER"`, consumed by `lib/accounting.ts` (chart codes 1101/1102/1103), `lib/fx.ts`, `lib/assistant-knowledge.ts`, `lib/ai-tools/*`, `app/api/finance/expense-categories/route.ts`. The only reader of the setting is the dev agent script `scripts/dental-ai-agent.ts:108` |
| Affected files | `lib/settings.ts`, `lib/settings-definitions.ts`, `lib/money.ts`, `lib/accounting.ts`, `lib/fx.ts` |
| Runtime impact | Owner can change "base currency" in `/settings`; nothing in the running app changes — reports, ledger, and accounting keep YER |
| Data/financial/security impact | Governance-level financial misrepresentation: an editable control that promises "كل التقارير تُحسب بها" and does nothing. Also a latent invariant break for any future multi-currency base switch |
| Canonical owner | Decide ONE: either (a) the setting becomes real and all money code resolves base currency through it (major migration of stored amounts implied — likely rejected), or (b) the setting is removed/locked from the UI and `CLINIC_BASE_CURRENCY` is declared the constitution-level invariant |
| Suggested fix | TD-05: prefer (b) — mark the key as locked/hidden with an explanatory hint, or remove it; keep the constant as the single owner; document in CONSTITUTION terms |
| Dependencies | None (can run early) |
| Required regression tests | `__tests__/settings.test.ts`, `__tests__/money.test.ts`, `__tests__/money-currency-integrity.test.ts`, `__tests__/security-http/settings-write-contract.test.ts` |
| Independently fixable | Yes (UI/definitions change only) |

---

### TD-REG-005 — P2 — No automated migrations ↔ `ensureSchema` equivalence check

| Field | Value |
|---|---|
| Category | Schema ownership / CI gap |
| Evidence | `scripts/verify-schema.mjs` header: contract = what `ensureSchema` builds; the difference between contract and baseline manifest (e.g. `material_rate_history`, 0005 guards) is *"تعريفٌ لا خلل"* — i.e. accepted, unverified as a whole. `scripts/build-current-schema.ts:43` builds via `db.ensureSchema()`. `scripts/generate-baseline-manifest.ts` builds from `0001` only. Spot-check at audit time found 0003/0004/0007/0008/0009/0010/0011 mirrored in `lib/db.ts`, but only by manual inspection |
| Affected files | `scripts/verify-schema.mjs`, `scripts/build-current-schema.ts`, `scripts/generate-current-schema-contract.ts`, `lib/migrations.ts`, CI workflow |
| Runtime impact | None directly; risk is future drift between a new migration and its hand-mirrored `ensureSchema` block |
| Data/financial/security impact | Indirect (via TD-REG-001): a drifted pair silently produces two different "truths" depending on which path built the database |
| Canonical owner | CI gate that builds BOTH paths on PG18 and diffs them (or: one path removed after TD-01B) |
| Suggested fix | TD-01A stage 1: add CI step `db:migrate` on fresh PG18 → compare against `ensureSchema`-built schema (both directions: expected ⊆ actual) — reusing the existing introspection in `lib/schema-manifest.ts` / `scripts/schema-introspect.ts` |
| Dependencies | TD-REG-001 |
| Required regression tests | The new CI diff step itself; `__tests__/postgres/schema-manifest.test.ts` |
| Independently fixable | Yes (as a CI-only addition) |

---

### TD-REG-006 — P2 — Authorization scattered across routes

| Field | Value |
|---|---|
| Category | Security / architecture |
| Evidence | 91 of ~134 route files contain inline role checks (151 expressions of `isAdmin(...)` / `canHandleMoney(...)` / `role !== "..."` / `.role ===`), e.g. `app/api/patients/route.ts:50-59`. No central HTTP route→permission table exists; the AI tool layer DOES have one (`lib/ai-tools/permission-matrix.ts`). Defense-in-depth exists: the 17-file security-http suite (`__tests__/security-http/rbac.test.ts`, `operational-resource-rbac.test.ts`, `waiting-list-rbac.test.ts`, `settings-authorization.test.ts`) |
| Affected files | 91 files under `app/api/**` |
| Runtime impact | None today; every new route must remember its checks — one forgotten check is a silent gap discovered only if the RBAC test matrix happens to cover it |
| Data/financial/security impact | Security-boundary consistency risk (BOLA/RBAC regressions on new routes) |
| Canonical owner | A single declarative permission map for HTTP routes (mirroring `lib/ai-tools/permission-matrix.ts`), enforced in `proxy.ts` or a shared route wrapper |
| Suggested fix | TD-04: inventory every route's required role(s) from the existing security-http tests, encode them in one matrix, enforce centrally, keep per-route checks as defense-in-depth |
| Dependencies | None |
| Required regression tests | Existing security-http suite (17 files); add a meta-test asserting every `app/api/**/route.ts` has an entry in the matrix |
| Independently fixable | Yes |

---

### TD-REG-007 — P2 — `lib/db.ts` monolith

| Field | Value |
|---|---|
| Category | Architecture / maintainability |
| Evidence | `lib/db.ts`: 17,729 lines / 831 KB — the largest file in the repo by an order of magnitude (next: `lib/reports.ts` 1,854; `lib/ceph.ts` 1,630). Contains every domain's data access + all DDL + seeds |
| Affected files | `lib/db.ts` and everything importing it |
| Runtime impact | None (bundled fine); review/merge-conflict/navigation cost is the impact |
| Data/financial/security impact | None direct; raises the risk of contradictory edits in concurrent phases (exactly the debt this series exists to close) |
| Canonical owner | Domain modules (`lib/patient.ts`, `lib/lab.ts`, `lib/accounting.ts`, …) already exist beside it — the register recommends a mechanical, test-preserving split AFTER TD-01A/TD-01B settle schema ownership |
| Suggested fix | TD-07: split `lib/db.ts` along existing domain seams (keep `getPool`/`ensureSchema` in a small `lib/db/` core); re-export shims to avoid touching 134 routes at once |
| Dependencies | TD-REG-001 (do not refactor the DDL while it's the production owner) |
| Required regression tests | Full existing suite; no behavior change expected (pure moves verified by `npm test` + `verify:ci`) |
| Independently fixable | Yes, but sequenced late deliberately |

---

### TD-REG-008 — P2 — PostgreSQL version drift (local 16 vs CI/prod 18)

| Field | Value |
|---|---|
| Category | Environment consistency |
| Evidence | `docs/CLINIC_OPERATIONS_IMPLEMENTATION_PLAN.md:34` — *"القاعدة: PostgreSQL 18 (إنتاج) | محلّيًّا 16.13"*; `docs/SETTINGS_PHASE1_IMPLEMENTATION.md:49-54` (schema-manifest tests require real PG18; dev container has 16.13; CI runs `postgres:18-alpine`); CI compensates by regenerating the contract on PG18 and uploading it as an artifact (`ci.yml:97-111`). Related documented debt: contract previously committed from PG16 (`docs/PHASE_4B_CLOSURE_AUDIT.md:29`, debt #84) |
| Affected files | Developer machines (environment), `schema/*.pg18.json` provenance, CI |
| Runtime impact | None in production; local schema artifacts may silently differ from CI-generated ones |
| Data/financial/security impact | Indirect: schema decisions verified locally on PG16 may behave differently on PG18 |
| Canonical owner | CI (PG18) — already the authoritative generator |
| Suggested fix | TD-02: document/automate a local PG18 path (docker-compose or devcontainer), and consider making `schema:contract` warn when generated on a non-18 server |
| Dependencies | None |
| Required regression tests | Existing `db:baseline:manifest:verify` CI step |
| Independently fixable | Yes |

---

### TD-REG-009 — P2 — Audit coverage responsibility split

| Field | Value |
|---|---|
| Category | Auditability / contracts |
| Evidence | 97 mutation routes; 42 reference audit directly (`recordAudit` / `AuditAction`), the rest rely on lib-layer audit writes (e.g. `bookAppointment` records `appointment.create` internally, `lib/book-appointment.ts`). Closed action vocabulary in `lib/audit.ts:17-70`; single writer `recordAudit` at `lib/db.ts:10457`; journey `scripts/verify-audit.mjs` proves append-only on real PG |
| Affected files | `app/api/**`, `lib/db.ts`, domain libs |
| Runtime impact | None |
| Data/financial/security impact | A mutation added in a route without an audit call is invisible to the "One Auditable History" pillar; currently prevented by convention + partial tests, not by contract |
| Canonical owner | `lib/audit.ts` action vocabulary + a per-mutation coverage map |
| Suggested fix | TD-06: build the mutation→audit-action matrix (mechanically derivable from routes + `recordAudit` call sites), assert it in a meta-test, route all writes through domain functions that own their audit events |
| Dependencies | None |
| Required regression tests | `__tests__/audit.test.ts`, `scripts/verify-audit.mjs` journey, new matrix meta-test |
| Independently fixable | Yes |

---

### TD-REG-010 — P2 — No staging environment

| Field | Value |
|---|---|
| Category | Environment / release safety |
| Evidence | `railway.json` deploys `main` only; `lib/db-target.ts` supports `DATABASE_ENVIRONMENT=staging` classification for CLI safety (refuses `--apply` on production/unknown-remote), but no staging service/deploy exists in the repository story. `docs/REPOSITORY_GOVERNANCE.md` (open PR #35) records a single-owner, main→production pipeline |
| Affected files | Deployment config (outside repo), `lib/db-target.ts` |
| Runtime impact | Every merge to `main` is a production release; the only pre-production proof is CI (which is strong: PG18 + journeys + security-http) |
| Data/financial/security impact | Release risk concentration; migration adoption must rehearse on a staging clone first (TD-01A before TD-01B, per the owner-fixed sequence) |
| Canonical owner | Deployment platform (Railway environment) + `lib/db-target.ts` classification |
| Suggested fix | TD-02/TD-08A: staging Railway environment (same image, classified `staging`, `DATABASE_ENVIRONMENT=staging`) used at minimum to rehearse baseline adoption and restores before production |
| Dependencies | None (but prerequisite for the TD-08A drill and safe TD-01A/TD-01B execution) |
| Required regression tests | `__tests__/db-target.test.ts` |
| Independently fixable | Yes |

---

### TD-REG-011 — P2 — Three scheduling entry points, one convention

| Field | Value |
|---|---|
| Category | Domain logic unification |
| Evidence | `bookAppointment` (`lib/book-appointment.ts:220`), `rescheduleAppointment` (`lib/book-appointment.ts:382`), `convertWaitingToAppointment` (`lib/waiting-list-booking.ts:51`); all must respect `judgeBookingInDay` (`lib/book-appointment.ts:148`), capacity judges (`lib/capacity.ts:66,263`), and provider blocks (`lib/schedule.ts`). Concurrency proven per path: `__tests__/postgres/booking-capacity-concurrency.test.ts`, `waiting-list-booking-concurrency.test.ts`, `appointment-reschedule.test.ts` |
| Affected files | `lib/book-appointment.ts`, `lib/waiting-list-booking.ts`, `lib/capacity.ts`, `lib/schedule.ts` |
| Runtime impact | None today (tests green) |
| Data/financial/security impact | Double-booking / capacity-bypass risk if a future entry point (e.g. AI booking or Today's Clinic) forgets a judge |
| Canonical owner | One scheduling service boundary that every writer goes through |
| Suggested fix | TD-03: extract a single `scheduleAppointment()` core used by all three paths; keep the public functions as thin wrappers |
| Dependencies | None |
| Required regression tests | The three existing concurrency suites (unchanged must-pass) |
| Independently fixable | Yes |

---

### TD-REG-012 — P2 — Heuristic-only duplicate detection

| Field | Value |
|---|---|
| Category | Data quality / patient identity |
| Evidence | `lib/duplicates.ts` (pure heuristics: `normalizeName`, `nameTokens`, `samePhone`, `nameOverlap`, `findDuplicates`); patient number from sequence (`lib/db.ts:1411-1421, 2603-2604`); merge tooling exists (`scripts/verify-merge.mts`); no DB-level constraint can enforce human identity |
| Affected files | `lib/duplicates.ts`, `lib/patient.ts`, patient creation routes |
| Runtime impact | Duplicate patients can be created; detection is advisory (warning string) |
| Data/financial/security impact | Splits a patient's financial/clinical footprint across records — violates "One Patient — One Record" silently; reconciliation (ledger, commission) attributes to the wrong chart |
| Canonical owner | `lib/duplicates.ts` as the single detector + a documented merge procedure |
| Suggested fix | TD-03: run the existing duplicate census tooling against production (read-only), document the merge SOP, and add a blocking confirm-on-warning in the creation path if not already present |
| Dependencies | None |
| Required regression tests | `__tests__/duplicates.test.ts`, `scripts/verify-merge.mts` |
| Independently fixable | Yes |

---

### TD-REG-013 — P2 — Non-default test tiers easy to skip locally

| Field | Value |
|---|---|
| Category | Test & environment |
| Evidence | `vitest.config.mts` excludes `__tests__/postgres/**` and `__tests__/security-http/**` from `npm test` (documented intent: they need real PG / built app); CI runs all tiers (`ci.yml:79-82,161-162`). Local parity requires Docker PG + Chromium |
| Affected files | `vitest.config.mts`, `vitest.config.postgres.mts`, `vitest.config.security.mts`, developer workflow docs |
| Runtime impact | A developer iterating locally sees green while a concurrency/security regression sits in the excluded tiers until CI catches it (slower feedback loop) |
| Data/financial/security impact | Indirect quality risk |
| Canonical owner | CI (already authoritative) |
| Suggested fix | TD-02: one documented local command (docker-compose or script) that brings up PG18 + runs all three tiers; optional git hook |
| Dependencies | TD-REG-008 |
| Required regression tests | N/A (tooling) |
| Independently fixable | Yes |

---

### TD-REG-014 — P3 — Stale `docs/DATABASE_MIGRATIONS.md`

| Field | Value |
|---|---|
| Category | Documentation currency |
| Evidence | Document lists migrations 0001–0005 (`docs/DATABASE_MIGRATIONS.md` structure block, lines 16-22) while `migrations/` contains 11 files (0006 lifecycle, 0007 services/capacity, 0008 chair/new-patient, 0009/0010 waiting list, 0011 waiting link). Line 3 still describes the system "as placed in P1" |
| Affected files | `docs/DATABASE_MIGRATIONS.md` |
| Runtime impact | None |
| Data/financial/security impact | None; operator/reviewer confusion about the real migration inventory |
| Canonical owner | The doc itself, updated with each migration PR |
| Suggested fix | TD-01A documentation step: refresh the file (list 0001–0011, note adoption status), and add a CI/doc lint that fails when the doc's migration list diverges from the directory |
| Dependencies | TD-REG-001 |
| Required regression tests | None (doc); optional CI list check |
| Independently fixable | Yes |

---

### TD-REG-015 — P3 — `as any` casts (~40)

| Field | Value |
|---|---|
| Category | Type safety |
| Evidence | `lib/ai-tools/registry.ts` (24 casts in `execute: (params, ctx) => fn(params as any, ctx)` — a known registry-signature compromise), `lib/ai-providers/adapters.ts:118,243,367` (JSON parse), `lib/ai-tools/clinical-action-tools.ts:429`, `lib/ortho-tools.ts:61,155`, UI `<select>` handlers (`app/lab/page.tsx:689,714`, `app/settings/lab-pricing/page.tsx:568`, `components/PatientLabOrders.tsx:332`, etc.) |
| Affected files | Listed above |
| Runtime impact | None |
| Data/financial/security impact | None direct; weakens the typecheck guarantee precisely at the AI execution boundary |
| Canonical owner | Typed tool parameter schemas (`lib/ai-tools/types.ts`) |
| Suggested fix | TD-07: parameterize the registry's `execute` signature (`execute: (params: unknown, ctx) => fn(decodeX(params), ctx)` with per-tool validators); UI selects get typed option arrays |
| Dependencies | None |
| Required regression tests | `__tests__/ai-assistant-tools.test.ts`, `__tests__/ai-action-tools.test.ts` |
| Independently fixable | Yes |

---

### TD-REG-016 — P3 — eslint-disable directives (10)

| Field | Value |
|---|---|
| Category | Lint hygiene |
| Evidence | 8 justified `@next/next/no-img-element` (print/display screens using `<img>` deliberately); 2 `react-hooks/exhaustive-deps` needing review: `app/reports/page.tsx:167`, `app/settings/history/page.tsx:153` (both annotated with a reason comment) |
| Affected files | `app/display/page.tsx:286`, `app/reports/page.tsx:167`, `app/print/lab/[id]/page.tsx:168`, `app/print/consent/[id]/page.tsx:361`, `app/settings/history/page.tsx:153`, `components/CephTracer.tsx:1181,1418`, `components/CephCompareView.tsx:172`, `components/LabAccountingAuditReportModal.tsx:330`, `components/WebCephRecordsGrid.tsx:331`, `components/Chat.tsx:352` |
| Runtime impact | None |
| Data/financial/security impact | None |
| Canonical owner | `eslint.config.mjs` policy |
| Suggested fix | TD-07: convert the two `exhaustive-deps` suppressions into `useCallback`/explicit dep arrays or documented waivers; leave `no-img-element` (print screens) as a scoped rule |
| Dependencies | None |
| Required regression tests | `npm run lint` (CI gate) |
| Independently fixable | Yes |

---

### TD-REG-017 — P3 — Legacy compatibility bridges

| Field | Value |
|---|---|
| Category | Dead-code / compatibility |
| Evidence | (a) `lib/settings-validate.ts:11,95` re-exports legacy `validateSetting` from `settings.ts`; (b) `proxy.ts:126,190` `isOriginHostLegacyTrusted` — legacy host-trust path still active in origin policy; (c) appointment `legacy_type` bridge: column `lib/db.ts:444`, resolver `resolveServiceByLegacyType` `lib/db.ts:17004`, starter mapping `lib/appointment-services.ts:176-261`, consumers `capacity-context.ts:70`, `book-appointment.ts:294,478`; (d) `LEGACY_TAB_MAP`/`LEGACY_SUBTAB_MAP` patient-page URL compat `app/patients/[id]/page.tsx:75-94`; (e) `LEGACY_IDENTITY_FIXES` `lib/db.ts:6093`; (f) announcements migration `lib/db.ts:6448` |
| Affected files | As listed |
| Runtime impact | All are live code paths today (not dead) |
| Data/financial/security impact | (b) is security-adjacent: a legacy-trusted-origin path in the CSRF/origin guard should be retired once `APP_ORIGIN`/`TRUSTED_ORIGINS` are proven in production |
| Canonical owner | Each owning module |
| Suggested fix | TD-07: one bridge at a time — verify no production data still needs it (e.g. query `legacy_type IS NOT NULL` usage via appointment records), then remove with a deprecation window |
| Dependencies | None |
| Required regression tests | `__tests__/origin-policy.test.ts`, `__tests__/appointment-services.test.ts`, `__tests__/settings-validate.test.ts` |
| Independently fixable | Yes (per bridge) |

---

### TD-REG-018 — P3 — Silent-catch inventory (AI provider paths)

| Field | Value |
|---|---|
| Category | Error contracts |
| Evidence | Most `catch(() => {})` in the repo are correct best-effort rollback/cleanup patterns (~50 ROLLBACK-on-finally sites). Genuine silent degradations: `lib/ai-providers/registry.ts:93` (`seedGeminiProviderIfMissing(pool).catch(() => null)`), `:133`, `:374` (DDL/seed best-effort in read paths), `:522` (`listAiProviders().catch(() => [])` — DB error yields empty list indistinguishable from "no providers"), `lib/ai-tools/clinical-action-tools.ts:429` (`getSettings().catch(() => ({} as any))` — settings failure treated as empty settings) |
| Affected files | `lib/ai-providers/registry.ts`, `lib/ai-tools/clinical-action-tools.ts` |
| Runtime impact | Provider list silently empty on DB hiccup; clinical AI defaults silently applied |
| Data/financial/security impact | Low direct risk; observability gap in AI paths |
| Canonical owner | `lib/ai-providers/registry.ts` |
| Suggested fix | TD-06: replace with logged, typed failures (error surfaced to the AI settings screen) |
| Dependencies | None |
| Required regression tests | `__tests__/ai-provider-registry.test.ts`, `__tests__/provider-error-hygiene.test.ts` |
| Independently fixable | Yes |

---

### TD-REG-019 — P3 — Node version unpinned locally

| Field | Value |
|---|---|
| Category | Environment |
| Evidence | CI pins Node 22 (`ci.yml:53`), Docker uses `node:22-alpine`; repo has no `.nvmrc`/`.node-version`/`engines` field (`package.json` has none) |
| Affected files | `package.json` (candidate `engines`), new `.nvmrc` |
| Runtime impact | None in production |
| Data/financial/security impact | None; local reproducibility only |
| Canonical owner | `package.json` engines + `.nvmrc` |
| Suggested fix | TD-02: add `"engines": { "node": ">=22 <23" }` and `.nvmrc` (`22`) |
| Dependencies | None |
| Required regression tests | None |
| Independently fixable | Yes |

---

### TD-REG-020 — P3 — README monolith

| Field | Value |
|---|---|
| Category | Documentation |
| Evidence | `README.md` 71 KB / 40+ sections mixing operator manual (backup, Railway), user guide (every screen), and developer checks |
| Affected files | `README.md` |
| Runtime impact | None |
| Data/financial/security impact | None; onboarding/ops lookup cost |
| Canonical owner | `docs/` split: operator vs features vs dev |
| Suggested fix | TD-07 documentation pass: extract `docs/OPERATIONS.md` and `docs/FEATURES.md`, keep README as index |
| Dependencies | None |
| Required regression tests | None |
| Independently fixable | Yes |

---

### TD-REG-021 — P3 — Backup subsystem module sprawl

| Field | Value |
|---|---|
| Category | Architecture (accepted complexity) |
| Evidence | 15 modules: `backup.ts` (full-data snapshot), `backupConfig.ts`, `backupDayClaim.ts`, `backupDestinations.ts`, `backupEncryption.ts`, `backupEngine.ts`, `backupHistory.ts`, `backupReadOnly.ts` (read-only path), `backupRetention.ts`, `backupRetentionTypes.ts`, `backupRuntimeConfig.ts`, `backupSchedule.ts`, `backupVolume.ts`, `fullBackup.ts`, `productionBackup.ts` + `lib/restore/{archive,staging,validate}.ts`. Each header documents a deliberate single responsibility (verified by reading module headers) |
| Affected files | `lib/backup*.ts`, `lib/fullBackup.ts`, `lib/productionBackup.ts`, `lib/restore/*` |
| Runtime impact | None (intentional layering) |
| Data/financial/security impact | None |
| Canonical owner | Already layered; add a `lib/backup/README.md` map |
| Suggested fix | TD-07: one-page module map inside `docs/` (or `lib/backup/` dir move) — no behavior change |
| Dependencies | None |
| Required regression tests | Existing backup suites (untouched) |
| Independently fixable | Yes |

---

### TD-REG-022 — P3 — Superseded tech-debt report

| Field | Value |
|---|---|
| Category | Documentation |
| Evidence | `docs/TECHNICAL_DEBT_REPORT.md` documents exactly two interventions (Turbopack warnings, vitest config ESM) and declares the effort "100%"; it is a closure report, not a register |
| Affected files | `docs/TECHNICAL_DEBT_REPORT.md` |
| Runtime impact | None |
| Data/financial/security impact | None |
| Canonical owner | This register (`docs/TECHNICAL_DEBT_MASTER_REGISTER.md`) |
| Suggested fix | TD-00 delivery: add a banner pointing to this register; keep the historical file |
| Dependencies | None |
| Required regression tests | None |
| Independently fixable | Yes (done as part of this PR) |

---

### TD-REG-023 — P3 — PGlite/pg result-shape shim

| Field | Value |
|---|---|
| Category | Compatibility shim |
| Evidence | `lib/db.ts:156` — `rowCount: (res as any).affectedRows ?? res.rows.length` normalizes PGlite vs node-postgres result shapes; PGlite runs unit tests while PG runs production/integration |
| Affected files | `lib/db.ts` |
| Runtime impact | None (correct in both drivers today) |
| Data/financial/security impact | None |
| Canonical owner | A typed adapter at the pool boundary |
| Suggested fix | TD-07: extract a typed `normalizeResult()` in the db core instead of an inline cast |
| Dependencies | TD-REG-007 (same file) |
| Required regression tests | `__tests__/database-runtime.test.ts` |
| Independently fixable | Yes |

---

### TD-REG-024 — P3 — Open governance PR awaiting owner

| Field | Value |
|---|---|
| Category | Process |
| Evidence | PR #35 `docs/repository-governance` → `main`, open at audit time (branch `origin/docs/repository-governance`, head `a275c37`, +131 lines `docs/REPOSITORY_GOVERNANCE.md`) |
| Affected files | `docs/REPOSITORY_GOVERNANCE.md` (in PR) |
| Runtime impact | None |
| Data/financial/security impact | None (documentation) |
| Canonical owner | Repository owner |
| Suggested fix | Owner review + merge/resolve of PR #35 immediately after PR #42, before TD-01A starts (owner-fixed sequence) |
| Dependencies | None |
| Required regression tests | None |
| Independently fixable | Yes (owner action) |

---

## 5. Severity Roll-up

| Severity | Count | IDs |
|---|---|---|
| P0 | 1 | TD-REG-001 |
| P1 | 3 | TD-REG-002, TD-REG-003, TD-REG-004 |
| P2 | 8 | TD-REG-005 … TD-REG-012, TD-REG-013 |
| P3 | 12 | TD-REG-014 … TD-REG-024 |

## 6. What this audit deliberately did NOT do

- No product feature work (Today's Clinic, Clinical Handoff, Checkout remain untouched and unscheduled here beyond TD-09's E2E scope).
- No edits to any delivered migration (`migrations/0001..0011` untouched).
- No assumption that `ensureSchema()` is removable — the register records that it is the only schema mechanism the current deployment image can execute (proven), that repository documentation describes it as the active production schema owner (documented historical state, not independently verified — see TD-REG-001 evidence A/B/C), and that its retirement is a staged decision (TD-01A → TD-01B) gated on a read-only production preflight and owner approval.
- No changes to Railway, deployment, database, or production data.
