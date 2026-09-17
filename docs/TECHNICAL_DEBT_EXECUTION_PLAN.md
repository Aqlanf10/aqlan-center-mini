# TD-00 — Technical Debt Execution Plan (TD-01A/TD-01B … TD-08A/TD-08B, TD-09, TD-10)

**Repository:** `Aqlanf10/aqlan-center-mini`
**Plan baseline:** register `docs/TECHNICAL_DEBT_MASTER_REGISTER.md` at commit `5308418d3ae6f77a7c4520e7fc6e1eed59946961`
**Methodology:** AUDIT → REUSE → EXTEND → TEST → DOCUMENT. Each phase is a small, independently reviewable PR. **No phase may start before the owner has reviewed and accepted the TD-00 register.** Nothing in this plan authorizes editing a delivered migration, changing production data, or merging without owner review.

**Owner revision (2026-09-17, PR #42 review):**
1. **TD-01 is split** into **TD-01A** (schema unification proven on **staging only** — deployment/staging/fresh-DB/restored-DB/equivalence proof) and **TD-01B** (production **read-only preflight** + **owner-approved adoption** + `ensureSchema` retirement staging).
2. **TD-08 is split** into **TD-08A** (pre-adoption backup/restore proof — runs *before* TD-01A) and **TD-08B** (final backup proof — runs after TD-06).
3. The phase sequence below is **fixed by the owner**, superseding the earlier scheduling recommendation.
4. TD-REG-001's production adoption state is asserted only as far as evidence allows: deployment-image limitation (**proven**), historical documentation (**documented**), production DB state (**pending the TD-01B read-only preflight**).

**Standing rules for every phase**
1. One feature branch per phase: `td/NN-<slug>` (names below). Never work on `main`.
2. Reuse before rewrite: each phase lists the existing modules and tests it must reuse — new abstractions are justified, not assumed.
3. CI must be green including `test:postgres`, `test:security-http`, and `verify:ci` before review is requested.
4. Rollback strategy is mandatory per phase (below). Production changes (TD-01B, TD-08A, TD-08B) additionally require a staging rehearsal, a preceding read-only preflight (TD-01B), a verified backup as the abort point, and explicit owner approval.
5. Every phase ends with a DOCUMENT step updating the register (severity retired or reduced) and, where relevant, `docs/SOURCE_OF_TRUTH_OWNERSHIP_MAP.md`.

**Execution sequence (fixed by the owner during PR #42 review, 2026-09-17):**

```
PR #42 merge
 └► refresh/resolve PR #35 (governance)
     └► TD-05 (base-currency truth)
         └► TD-02 (environment parity)
             └► TD-08A (pre-adoption backup/restore proof)
                 └► TD-01A (schema unification — STAGING ONLY)
                     └► TD-01B (production read-only preflight
                                 + owner-approved adoption
                                 + ensureSchema retirement staging)
                         └► TD-04 (authorization matrix)
                             └► TD-03 (domain consolidation)
                                 └► TD-06 (mutation/audit contracts)
                                     └► TD-08B (final backup proof)
                                         └► TD-09 (full-day E2E)
                                             └► TD-10 (closure gate)
```

---

## TD-01A — Schema Ownership Unification (Staging Proof)

| Field | Plan |
|---|---|
| Resolves | TD-REG-001 (P0) — staging share; TD-REG-002 (P1) — staging share; TD-REG-003 (P1); TD-REG-005 (P2); TD-REG-014 (P3) |
| Exact scope | (a) Ship the migration capability into the deployment path: production image (or a documented sidecar/job) carries `migrations/` and a runnable `db:migrate` (tsx bundled or a compiled runner). (b) Rehearse **baseline adoption** on a staging clone: `DATABASE_ENVIRONMENT=staging npm run db:migrate -- --apply --allow-remote` runs the baseline-adoption probe (reuse `lib/baseline-probe.ts`) — adoption records `0001` with `adopted=TRUE` and zero DDL executed. (c) Apply migrations 0002–0011 on staging, then diff against the `ensureSchema`-built contract (reuse `scripts/build-current-schema.ts` + `lib/schema-manifest.ts` introspection; add the two-direction diff gate from TD-REG-005). (d) Prove the fresh-DB and restored-DB paths both build schemas identical to the migrated staging clone from migrations + provisioning alone (restore side reuses the TD-08A drill procedure). (e) Extract seeds (staff defaults, `STARTER_SERVICES`, expense categories, `LEGACY_IDENTITY_FIXES`, announcements migration) from `ensureSchema` into a deliberate provisioning path invoked at setup/restore (keep `SKIP_SEED` semantics). (f) Refresh `docs/DATABASE_MIGRATIONS.md` to the real 11-migration inventory and the new deployment story. **No production database is touched in this phase.** |
| Dependencies | PR #42 merged; PR #35 governance resolved; TD-02 (environment parity); TD-08A (backup/restore proof — the safety net before any adoption, even on staging) |
| Likely affected files | `Dockerfile`, `docker-entrypoint.sh` (or a deploy job), `lib/migrations.ts`, `scripts/db-migrate.ts`, `scripts/build-current-schema.ts`, `lib/db.ts` (seed extraction only — no DDL semantics change), `scripts/provision-mini-database.ts`, `docs/DATABASE_MIGRATIONS.md`, CI workflow (new diff gate) |
| Acceptance criteria | 1) A deployment-path test proves the shipped image can execute `db:migrate` against a fresh PG18. 2) The staging clone has `schema_migrations` rows 0001(adopted)…0011 applied with zero drift vs the `ensureSchema` contract (two-direction diff gate green). 3) Fresh-DB and restored-DB paths both build identical schemas from migrations + provisioning alone. 4) Seeds run only via the explicit provisioning command |
| Required tests | Reuse: `migrations.test.ts` (14), `postgres/baseline-adoption.test.ts` (10), `migration-advisory-lock.test.ts` (4), `verify-schema.mjs` journey, CI `db:baseline:manifest:verify`. New: deployment-path test (image runs `db:migrate` against fresh PG18); equivalence gate (migrations-built ⊆ ensureSchema-built and vice versa on PG18) |
| Rollback | Staging only: drop the clone and re-provision. Adoption is metadata-only (no DDL); the `ensureSchema` code path is untouched in production until TD-01B |
| Suggested branch | `td/01a-schema-ownership-staging` |
| Suggested PR title | `TD-01A: unify schema ownership on staging — migrations adopted, equivalence proven` |

---

## TD-01B — Production Read-Only Preflight + Owner-Approved Adoption + `ensureSchema` Retirement Staging

| Field | Plan |
|---|---|
| Resolves | TD-REG-001 (P0) — production share; TD-REG-002 (P1) — production share |
| Exact scope | (a) **Read-only production preflight (mandatory step 1):** a SELECT-only probe of the production database (reuse the introspection of `lib/schema-manifest.ts` / `scripts/schema-introspect.ts`; zero DDL, zero writes, no Railway change) that establishes the actual current state: `schema_migrations` contents (if the table exists) and a drift comparison of the live schema against both the migration chain and the `ensureSchema` contract. This converts TD-REG-001 evidence classes B/C into proven fact. (b) Owner reviews the preflight report and gives explicit written approval to proceed — or the findings become new register entries and adoption is re-planned. (c) Owner-executed full verified backup immediately before adoption (reuse the TD-08A procedure) — this is the abort point. (d) Baseline adoption on production via the existing baseline-adoption probe (`0001`, `adopted=TRUE`, zero DDL), then apply migrations 0002–0011 only to the extent the preflight shows they are needed, re-running the drift diff after. (e) Verify a cold production process performs NO DDL. (f) Stage `ensureSchema` retirement: kill-switch env first; removal in a later phase after a production soak. **No production step runs before (a) and (b).** |
| Dependencies | TD-01A fully green; TD-08A backup/restore proof; owner approval after reviewing the preflight report |
| Likely affected files | new read-only preflight script (reusing `lib/schema-manifest.ts`), `lib/db.ts` (kill-switch guard only), runbook + docs (`docs/DATABASE_MIGRATIONS.md`, cross-links in `docs/PRODUCTION_BACKUP_GATE.md`) |
| Acceptance criteria | 1) A dated read-only preflight report exists stating the **proven** production adoption state (no assertion from documentation alone). 2) Adoption executed only after owner approval and a verified backup. 3) Post-adoption: production `schema_migrations` shows the full chain with zero drift vs the contract. 4) A cold production process performs NO DDL (health request latency drop observable). 5) `ensureSchema` reduced to a no-op guard behind a kill-switch env |
| Required tests | The preflight script's own dry-run test against a PG18 fixture; post-adoption drift diff (same gate as TD-01A) executed read-only against production as the final proof |
| Rollback | The pre-adoption verified backup IS the rollback (restore path proven by TD-08A). If the probe reports `BASELINE_SCHEMA_MISMATCH`, adoption halts before any write and the discrepancy is resolved by a new forward migration. Post-removal rollback: revert the deploy commit; `ensureSchema` DDL is still present in the previous image |
| Suggested branch | `td/01b-production-adoption` |
| Suggested PR title | `TD-01B: read-only production preflight, owner-approved migration adoption, ensureSchema retirement staging` |

---

## TD-02 — Environment / CI Consistency

| Field | Plan |
|---|---|
| Resolves | TD-REG-008 (P2), TD-REG-013 (P2), TD-REG-019 (P3) |
| Exact scope | (a) Local dev PostgreSQL 18 path: docker-compose file (or documented script) providing `postgres:18-alpine` with the CI env shape (`TEST_DATABASE_URL` etc.). (b) `schema:contract` warns when generated on a server whose major ≠ 18. (c) Add `.nvmrc` (`22`) + `"engines"` to `package.json`. (d) One documented command that runs the full local tier set (`npm test` + `test:postgres` + `test:security-http` + `verify:ci`) against the compose stack. (e) A staging Railway environment definition (classified `staging`) used by the TD-08A drill and the TD-01A/TD-01B chain — creation itself is a Railway dashboard action performed by the owner |
| Dependencies | None hard; staging environment is a prerequisite for the TD-08A drill and the TD-01A/TD-01B chain |
| Likely affected files | new `docker-compose.dev.yml`, `package.json`, `.nvmrc`, `scripts/generate-current-schema-contract.ts` (version warning), `README.md` (dev section), CI unchanged (already correct) |
| Acceptance criteria | A fresh machine reaches full-tier green (unit + postgres + security-http + journeys) using only documented commands; committed schema artifacts always carry PG18 provenance |
| Required tests | Existing suites unchanged; new compose smoke (`db:status` against the compose DB) |
| Rollback | Pure tooling — revert commits |
| Suggested branch | `td/02-env-consistency` |
| Suggested PR title | `TD-02: pin local parity (PG18 compose, node pin, full-tier command)` |

---

## TD-03 — Domain Source-of-Truth Consolidation

| Field | Plan |
|---|---|
| Resolves | TD-REG-011 (P2), TD-REG-012 (P2); reinforces ownership map sections 1, 2, 6 |
| Exact scope | (a) Extract a single scheduling core (`scheduleAppointment()` — capacity judge + provider-block guard + waiting-list link + audit) and express `bookAppointment`, `rescheduleAppointment`, `convertWaitingToAppointment` as wrappers over it (reuse `judgeBookingInDay`, `judgeCapacity`/`judgeFullCapacity` unchanged). (b) Patient duplicates: run the read-only duplicate census (reuse `lib/duplicates.ts` logic against production data via a SELECT-only script), record results as an operations doc; write the merge SOP (reuse `verify-merge.mts` semantics); ensure creation paths surface the warning as a blocking confirm |
| Dependencies | None (independent of TD-01A/TD-01B; touches `lib/book-appointment.ts` which is stable) |
| Likely affected files | `lib/book-appointment.ts`, `lib/waiting-list-booking.ts`, new `lib/scheduling-core.ts` (or refactored `book-appointment.ts`), `lib/duplicates.ts` (no logic change), patient creation routes |
| Acceptance criteria | All three entry points provably pass the same judge (single call site per rule); concurrency suites unchanged and green; duplicate census documented; SOP published |
| Required tests | Reuse as-is: `booking-capacity-concurrency.test.ts`, `waiting-list-booking-concurrency.test.ts`, `appointment-reschedule.test.ts`, `appointment-lifecycle-concurrency.test.ts`, `duplicates.test.ts` |
| Rollback | Revert (pure refactor with tests as the guard) |
| Suggested branch | `td/03-domain-consolidation` |
| Suggested PR title | `TD-03: single scheduling core + patient duplicate census & merge SOP` |

---

## TD-04 — Authorization / Security Unification

| Field | Plan |
|---|---|
| Resolves | TD-REG-006 (P2); watch-item TD-REG-017b (legacy origin trust) |
| Exact scope | (a) Derive the HTTP route→role matrix from the existing security-http RBAC tests (they already encode expected behavior — reuse them as the source, not new opinion). (b) Encode the matrix in one module (mirror the shape of `lib/ai-tools/permission-matrix.ts`). (c) Enforce centrally: either a shared route wrapper or checks in `proxy.ts`; keep existing per-route checks as defense-in-depth. (d) Meta-test: every `app/api/**/route.ts` has a matrix entry (fail closed on new unlisted routes). (e) Evaluate retiring `isOriginHostLegacyTrusted` in `proxy.ts` once `APP_ORIGIN`/`TRUSTED_ORIGINS` proven in production logs (owner decision) |
| Dependencies | None |
| Likely affected files | new `lib/http-permissions.ts`, `proxy.ts`, 91 route files (additive only), new meta-test |
| Acceptance criteria | Zero behavior change on the existing RBAC suites; new routes cannot ship without a permission entry |
| Required tests | Reuse all 17 `security-http` files; new matrix meta-test |
| Rollback | Revert; per-route checks were never removed |
| Suggested branch | `td/04-authorization-matrix` |
| Suggested PR title | `TD-04: central HTTP permission matrix enforced with per-route defense-in-depth` |

---

## TD-05 — Finance / Currency Unification — **EXECUTED 2026-09-17 (PR pending owner review)**

Executed on branch `td/05-base-currency-truth` from main `ccaec23` per the owner's TD-05 instruction (AUDIT → REUSE → EXTEND → TEST → DOCUMENT). Outcome beyond the original plan scope (the original entry understated the blast radius — see TD-REG-004's corrected evidence): the setting was NOT a dead control but a live second authority read by 53 runtime files; all were unified on the constitutional constant, the key was systemLocked, and patient financial agreements gained explicit YER/SAR/USD agreement currencies end-to-end (plans → installments → invoices → payments → statements → per-currency balances). No migration, no schema change, no production access. TD-02 NOT started.

| Field | Plan (as executed) |
|---|---|
| Resolves | TD-REG-004 (P1); ownership map §9 (the only ❌) |
| Exact scope | (a) Owner decision recorded in docs: base currency is a constitutional constant `YER` (`lib/money.ts`). (b) Remove/lock `finance.base_currency` from the editable settings surface (`settings-definitions.ts` mark non-configurable + UI hides it) with an explanatory hint — OR, if the owner insists on configurability, a separate impact analysis must be scheduled first (stored amounts span money tables; this plan assumes the lock path). (c) Fix the one setting consumer (`scripts/dental-ai-agent.ts:108`) to read the constant. (d) Document the decision beside the currency-isolation pillar in the finance governance doc |
| Dependencies | None |
| Likely affected files | `lib/settings-definitions.ts`, `lib/settings.ts`, `app/settings/**` (hide key), `scripts/dental-ai-agent.ts`, `docs/finance_system_governance.md` |
| Acceptance criteria | MET: Settings UI shows the currency as "محكوم بالنظام" with no edit button; server rejects writes even for admin; all money code paths resolve base currency from exactly one symbol (`CLINIC_BASE_CURRENCY`); patient agreements operate in YER/SAR/USD with persistence, readback, orthodontic coverage, and no silent cross-currency aggregation |
| Required tests (as executed) | NEW `__tests__/td05-base-currency.test.ts` (20), NEW `__tests__/postgres/td05-currency-persistence.test.ts` (9, real PG); UPDATED `settings-platform.test.ts`, `security-http/settings-authorization.test.ts` (lock + reason tests), `security-http/settings-ui-journey.test.ts` (locked card, no edit button); all pre-existing suites green |
| Rollback | Revert (UI/definitions only; no data touched) |
| Suggested branch | `td/05-base-currency-truth` |
| Suggested PR title | `TD-05: unify clinic base currency and enable YER/SAR/USD patient financial accounts` |

---

## TD-06 — Mutation / Audit / Idempotency / Error Contracts

| Field | Plan |
|---|---|
| Resolves | TD-REG-009 (P2), TD-REG-018 (P3) |
| Exact scope | (a) Build the mutation→audit matrix mechanically (enumerate mutating routes + `recordAudit` call sites; mark lib-layer-owned events). (b) Meta-test asserting every mutating route either writes audit at the route layer or delegates to a lib function that does. (c) Replace the silent AI-provider catches (`registry.ts:93,133,374,522`, `clinical-action-tools.ts:429`) with typed, logged failures surfaced to the AI settings screen. (d) Confirm (read-only) that every financial mutation path already satisfies: transaction + `FOR UPDATE` where concurrent, idempotency key where external — document any gap as new register entries rather than fixing inline (scope discipline) |
| Dependencies | Beneficial after TD-04 (matrix tooling shared) but independent |
| Likely affected files | `lib/audit.ts` (matrix types), new meta-test, `lib/ai-providers/registry.ts`, `lib/ai-tools/clinical-action-tools.ts` |
| Acceptance criteria | Audit coverage provably total over mutations; no `catch(() => empty)` on provider/config paths without a logged alternative |
| Required tests | Reuse `audit.test.ts`, `verify-audit.mjs` journey, `ai-provider-registry.test.ts`, `provider-error-hygiene.test.ts`; new matrix meta-test |
| Rollback | Revert |
| Suggested branch | `td/06-mutation-contracts` |
| Suggested PR title | `TD-06: complete audit coverage matrix and de-silent AI provider failures` |

---

## TD-07 — Code Hygiene / Dead Code / Warning Closure

| Field | Plan |
|---|---|
| Resolves | TD-REG-007 (P2), TD-REG-015 (P3), TD-REG-016 (P3), TD-REG-017 (P3), TD-REG-020 (P3), TD-REG-021 (P3), TD-REG-022 (P3), TD-REG-023 (P3) |
| Exact scope | (a) `lib/db.ts` split along domain seams into `lib/db/` core (pool, types, normalize) + domain modules re-exporting existing functions — after TD-01B completes adoption and DDL ownership has moved to the migration runner. (b) `as any` cleanup in `ai-tools/registry.ts` (typed execute signature) and UI selects. (c) Resolve the 2 `exhaustive-deps` suppressions or convert to documented waivers. (d) Legacy bridges: retire `settings-validate` legacy re-export, `LEGACY_TAB_MAP` URL compat (verify usage logs first), `LEGACY_IDENTITY_FIXES` (verify production applied — read-only check), announcements migration (verify empty source). (e) README split into index + `docs/OPERATIONS.md` + `docs/FEATURES.md`. (f) Backup module map doc. (g) Banner on `docs/TECHNICAL_DEBT_REPORT.md` pointing to the master register. (h) Typed `normalizeResult()` replacing the inline PGlite shim |
| Dependencies | TD-01B must land first for (a) |
| Likely affected files | `lib/db.ts` → `lib/db/**`, `lib/ai-tools/registry.ts`, `app/reports/page.tsx`, `app/settings/history/page.tsx`, `lib/settings-validate.ts`, `app/patients/[id]/page.tsx`, `README.md`, new docs |
| Acceptance criteria | No file > ~5k lines; zero unjustified suppressions; every legacy bridge either removed with proof of non-use or documented as load-bearing |
| Required tests | Full suite — the split is verified by zero test change; `verify:ci` journeys |
| Rollback | Revert (mechanical moves only) |
| Suggested branch | `td/07-code-hygiene` |
| Suggested PR title | `TD-07: split db monolith, close suppressions, retire proven-dead bridges` |

---

## TD-08A — Pre-Adoption Backup / Restore Proof

| Field | Plan |
|---|---|
| Resolves | Operational proof obligations raised by TD-01A/TD-01B (not new register items — backup domain is ✅) |
| Exact scope | (a) Owner-executed (agent-prepared) full production backup via the existing verified path (reuse `scripts/backup-full.mts` + `verify-backup.mjs`) — this becomes the abort point for the entire TD-01A → TD-01B chain. (b) A restore drill on an isolated PG18 clone (reuse `restore-full.ts` + `restore-drill.test.ts` procedure) proving the restored clone passes `db:status` + `verify:ci` phase-1 journeys. (c) Record RPO/RTO observations and the drill report under `docs/` |
| Dependencies | TD-02 (parity environment); runs BEFORE TD-01A per the owner-fixed sequence |
| Likely affected files | None in code (operational runbook + docs only, unless the drill exposes a defect → new register entry) |
| Acceptance criteria | A dated drill report exists — production backup verified, restored clone functional, timings recorded — produced before any adoption step (staging or production) |
| Required tests | `production-backup.test.ts`, `postgres/production-backup.test.ts` (per `docs/PRODUCTION_BACKUP_GATE.md`: 13 files / 101 tests on isolated PG18), `restore-drill.test.ts` |
| Rollback | The backup itself IS the rollback; production was not modified by the drill |
| Suggested branch | `td/08a-pre-adoption-backup-proof` (docs + runbook only) |
| Suggested PR title | `TD-08A: pre-adoption production backup & restore drill report` |

---

## TD-08B — Final Backup Proof

| Field | Plan |
|---|---|
| Resolves | Re-proof of the backup path once the unified system settles (post-adoption, post-consolidation) |
| Exact scope | Repeat the full backup/restore drill (same procedure as TD-08A) at the post-TD-06 state, proving the verified backup path against the now migration-owned schema; refresh RPO/RTO observations; publish the updated drill report under `docs/` |
| Dependencies | TD-01B completed; TD-04/TD-03/TD-06 landed; runs BEFORE TD-09 per the owner-fixed sequence |
| Likely affected files | None in code (operational runbook + docs only, unless the drill exposes a defect → new register entry) |
| Acceptance criteria | A second dated drill report on the final schema state — production backup verified, restored clone functional, timings recorded |
| Required tests | Same suites as TD-08A |
| Rollback | The backup itself IS the rollback; production was not modified by the drill |
| Suggested branch | `td/08b-final-backup-proof` (docs + runbook only) |
| Suggested PR title | `TD-08B: final production backup & restore drill report (post-unification)` |

---

## TD-09 — Full-Day Multi-Role E2E

| Field | Plan |
|---|---|
| Resolves | Cross-cutting regression confidence before the final gate; no single register item — it is the closing proof for TD-01A..TD-08B |
| Exact scope | One scripted full-clinic day on an isolated PG18 environment (reuse the journey framework — `scripts/journeys/*.mjs` + Playwright `playwright.mjs`): admin opens shift → reception books + checks in a walk-in and a booked patient → doctor seats/treats/completes + chart + prescription → waiting-list offer/convert path → reception invoices + payment (+ SAR/USD payment with FX) → partial refund → expense voucher → shift close → executive report vs ledger reconciliation → AI assistant performs one confirmed booking action → backup day-claim runs. Assert invariants at each checkpoint (append-only untouched, audit rows exist, capacity respected, waiting-list link unique) |
| Dependencies | TD-01A..TD-06 landed; TD-08B completed before running against production-derived data (owner-fixed sequence) |
| Likely affected files | new `scripts/journeys/full-day.mjs` wired into `verify-ci-journeys.mjs` as a new final phase |
| Acceptance criteria | The journey runs green in CI; any failure blocks merges (it joins `verify:ci`) |
| Required tests | The journey itself is the test; it reuses every domain's assertions |
| Rollback | Remove the journey from the registry (additive only) |
| Suggested branch | `td/09-full-day-e2e` |
| Suggested PR title | `TD-09: full-day multi-role operational journey as a merge gate` |

---

## TD-10 — Final Debt-Closure Gate

| Field | Plan |
|---|---|
| Resolves | Register verification: every entry retired or explicitly accepted by the owner |
| Exact scope | (a) Re-run this register's evidence commands at the final commit; produce a closing matrix (entry → retired/reduced/accepted-with-reason). (b) Owner review session over the matrix. (c) Update `docs/SOURCE_OF_TRUTH_OWNERSHIP_MAP.md` verdicts. (d) Tag a release (the repo currently has no tags/releases — governance doc PR #35 notes this) and archive the TD series state in `docs/`. (e) Only after this gate: schedule new feature phases (Today's Clinic, Clinical Handoff, Checkout) as fresh, debt-free baselines |
| Dependencies | TD-01A … TD-09 (all prior phases of the owner-fixed sequence) |
| Likely affected files | register + map + new release tag (tag created by owner) |
| Acceptance criteria | No P0/P1 items remain open; every P2 either fixed or owner-accepted in writing; P3 triaged |
| Required tests | Full CI + `verify:ci` + TD-09 journey green at the tagged commit |
| Rollback | N/A (documentation + tag) |
| Suggested branch | `td/10-closure-gate` |
| Suggested PR title | `TD-10: technical debt series closure matrix and release tag` |

---

## Phase Sequence (owner-fixed during PR #42 review, 2026-09-17)

| Order | Step | Why this position |
|---|---|---|
| 1 | **PR #42 merge** | Owner approval of the TD-00 audit documents themselves |
| 2 | **Refresh/resolve PR #35** | Governance rules on `main` before any TD phase runs |
| 3 | **TD-05** | Base-currency truth — tiny, zero-risk, closes the only ❌ in the ownership map |
| 4 | **TD-02** | Environment parity — the enabler for every rehearsal that follows |
| 5 | **TD-08A** | Pre-adoption backup/restore proof — the safety net before anything approaches adoption |
| 6 | **TD-01A** | Schema unification proven on **staging only** — deployment/staging/fresh-DB/restored-DB/equivalence proof |
| 7 | **TD-01B** | Production **read-only preflight** → **owner-approved adoption** → `ensureSchema` retirement staging |
| 8 | **TD-04** | Authorization matrix — security consistency |
| 9 | **TD-03** | Domain consolidation (single scheduling core, duplicate census) |
| 10 | **TD-06** | Mutation/audit/idempotency contracts |
| 11 | **TD-08B** | Final backup proof on the unified system |
| 12 | **TD-09** | Full-day multi-role E2E as a merge gate |
| 13 | **TD-10** | Closure matrix, release tag, and the green light for feature phases |

This sequence was **fixed by the owner** during PR #42 review and supersedes the
earlier scheduling recommendation. It is not self-executing: no phase begins
without explicit owner approval, and each phase remains a small, independently
reviewable PR with its own review cycle. TD-01B additionally requires the
read-only production preflight report and the owner's written adoption approval
before any production step.
