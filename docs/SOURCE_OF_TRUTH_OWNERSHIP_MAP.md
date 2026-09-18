# TD-00 — Source-of-Truth Ownership Map

**Repository:** `Aqlanf10/aqlan-center-mini`
**Audit baseline commit:** `5308418d3ae6f77a7c4520e7fc6e1eed59946961` (`main`)
**Purpose:** For each operational domain, name the ONE canonical owner (table, module, or mechanism) that the system treats as authoritative, list every competing implementation that also writes or derives the same facts, and record the current risk. This map is the reference for TD-03 (domain source-of-truth consolidation) and the arbiter for every future "where does X live" decision.

**Legend:** ✅ = single owner, no competing writer. ⚠️ = one owner + sanctioned secondary writers. ❌ = competing sources that must be reconciled.

---

## 1. Patient Identity

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Identity record | `patients` table | `lib/db.ts:321-339`; `patient_number TEXT UNIQUE` |
| Number generation | PostgreSQL sequence `patient_number_seq` (synced from MAX at `ensureSchema`) | `lib/db.ts:1411-1421`, INSERT `lib/db.ts:2603-2604` (`'P-' || LPAD(nextval...))` |
| Domain logic | `lib/patient.ts` | creation/update/lookup |
| Duplicate detection | `lib/duplicates.ts` (heuristics: name tokens, phone) — advisory only | `findDuplicates` `lib/duplicates.ts:105` |
| Merge procedure | `scripts/verify-merge.mts` (verification journey) | read-only proof tooling |
| Portal linkage | `lib/portal.ts` + `portalInvite.ts` (patient↔portal account by phone) | separate identity surface for patients |

**Status: ⚠️.** One record store, but duplicate creation is possible (heuristic warning only — see TD-REG-012). The portal account linkage is a second identity surface keyed by phone.

---

## 2. Appointment

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Record | `appointments` table | `lib/db.ts:341-364` + lifecycle columns 404-409 |
| Creation / rescheduling | `lib/book-appointment.ts` (`bookAppointment`, `rescheduleAppointment`) | `:220`, `:382` |
| Waiting-list conversion | `lib/waiting-list-booking.ts` (`convertWaitingToAppointment`) | `:51`; durable link `appointments.waiting_list_id` (migration 0011; mirrored `lib/db.ts:780-783`) |
| Lifecycle states | `lib/appointment-lifecycle.ts` | state vocabulary + transitions |
| AI booking | `lib/ai-tools/appointment-tools.ts` → goes through the same booking core | tools wrap, not bypass |
| Status snapshots | `appointment_services` + `legacy_type` bridge | service-bound typing with legacy text codes |

**Status: ⚠️.** Three sanctioned entry points (book, reschedule, waiting-list conversion) + one AI path, all expected to pass the same capacity judges. Risk: convention, not enforced boundary (TD-REG-011).

---

## 3. Capacity

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Day capacity judge | `lib/capacity.ts` — `judgeCapacity` `:66`, `judgeFullCapacity` `:263`, `dayCapacityMinutes` `:129` | pure functions |
| Inputs (chairs, hours, shifts) | `settings` table via `lib/settings.ts` keys (capacity group) | `settings-definitions.ts` categories |
| Service resolution | `lib/capacity-context.ts` (resolves appointment type → service duration) | uses `resolveServiceByLegacyType` |
| Override recording | `recordCapacityOverride` `lib/book-appointment.ts:111` + audit action `appointment.capacity_override` | explicit, audited |
| Verification | `scripts/journeys/capacity.mjs` + `__tests__/capacity-*.test.ts` (3 suites) | journey wired into verify:ci |

**Status: ✅.** Single judge module; inputs from settings; overrides audited.

---

## 4. Provider Availability

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Block records | `provider_blocks` table + API `app/api/provider-blocks/**` | CRUD surface |
| Time computation | `lib/schedule.ts` (availability windows, conflict detection) | 18 KB module |
| Timezone correctness | `lib/clinicZone.ts` (`clinicDayStart`, offset math) | provider-block guard fixed to clinic zone (PR #40 commit `fbb59f2`) |
| Permissions | `lib/doctor-permissions.ts` (476 lines — per-doctor capability flags) | separate concern, same domain |

**Status: ✅.** One table, one computation module, timezone centralized.

---

## 5. Waiting List

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Record | `waiting_list` table (`lib/db.ts:692`) + `waiting_list_contact_events` (`:748`) | |
| Domain logic | `lib/waiting-list.ts` (536 lines), matching `lib/waiting-list-match.ts`, booking `lib/waiting-list-booking.ts` | match → claim → convert pipeline |
| Link to appointments | `appointments.waiting_list_id` UNIQUE partial index (migration 0011) | exactly one appointment per waiting row |
| Completion semantics | migration 0010 + `__tests__/waiting-list-completion.test.ts` | owner-reviewed closure rules |
| Spec | `docs/WAITING_LIST.md` | |

**Status: ✅.** Well-fenced domain with its own docs and concurrency proofs (3 postgres suites).

---

## 6. Visit Lifecycle

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Record | `visits` table (`lib/db.ts:302-317`) | states `waiting`/`seated`/`finished`, chair, call/no-response counters |
| Waiting-room flow | `lib/waiting-room.ts` (21 KB) | chair assignment, calling |
| Flow orchestration | `lib/flow.ts` | visit stage transitions |
| Clinical content | `lib/clinical.ts` + `app/api/visits/[id]/clinical` | per-visit records |
| Doctor attribution | `visits.doctor_id` (`lib/db.ts:786-787`) — inherited from appointment or set at reception | commission + follow-up depend on it |
| Planned next visit | `app/api/visits/[id]/next` + `planned-visits/[id]/schedule` | future-visit scheduling surface |

**Status: ⚠️.** Single record store; transition logic split between `waiting-room.ts` and `flow.ts` (documented reasons); chair race protected (`visit-chair-concurrency.test.ts`).

---

## 7. Clinic Timezone / Date

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Zone resolution | `lib/clinicZone.ts` — `resolveClinicZone(process.env.CLINIC_TIME_ZONE)` with `Asia/Aden` fallback | single source by design |
| Exports | `CLINIC_TIME_ZONE` const (`lib/db.ts:2281`) — consumed by every date-bound query (100+ sites) | was 34 scattered literals before PR #26 (`feat/single-clinic-timezone`) |
| Day-start math | `clinicDayStart()` `lib/clinicZone.ts:76` | DST-safe two-pass offset |
| Tests | `__tests__/clinic-zone.test.ts`, `__tests__/clinic-day-start.test.ts` | |

**Status: ✅.** Deliberately env-owned, NOT a settings key (a typo in a settings row must not shift the clinic day). Registry note: keep it that way (see register TD-REG-004 for the currency contrast).

---

## 8. Settings

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Storage | `settings` table (`key TEXT`, `value TEXT`, versioned rows — PATCH contract) | write contract `__tests__/settings-write-contract.test.ts` |
| Defaults | `SETTING_DEFAULTS` `lib/settings.ts:68` | single defaults map |
| Metadata / types | `lib/settings-definitions.ts` (typed registry: type, scope, sensitivity, lock) | "المصدر الوحيد لمعنى المفتاح" |
| Validation | `lib/settings-validate.ts` (+ legacy bridge to `validateSetting` — TD-REG-017a) | server-side per-type checks |
| Permissions | `lib/settings-permissions.ts` + `settings-audit.ts` | who may change what; audited |
| UI groups | `lib/settings-ui.ts` + search index (`feat/settings-search-arabic`, PR #32) | |
| Concurrency | `__tests__/postgres/settings-concurrency.test.ts` | versioned PATCH races proven |

**Status: ✅ (since TD-05).** Well-layered architecture with a documented single meaning source. The former exception `finance.base_currency` is closed: the key is `systemLocked` (writes rejected server-side even for admin, UI shows "محكوم بالنظام") and has zero runtime consumers — TD-REG-004 closed by TD-05 (2026-09-17).

---

## 9. Finance / Ledger / Currencies

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Money units & types | `lib/money.ts` — `Currency = YER|SAR|USD`, minor units (YER 1, SAR/USD 100), `CLINIC_BASE_CURRENCY = "YER"` (hardcoded) | `:22-47` |
| Double-entry ledger | `lib/accounting.ts` (chart of accounts, journals) + `accounting` API | 38 KB |
| Documents | `payments` / `expenses` / `invoices` tables — append-only via migration 0005 guards + mirrored guards in `ensureSchema` (`lib/db.ts:1837-1860`) | UPDATE/DELETE triggers |
| Idempotency | `payments.idempotency_key` + `idempotency_request_hash` (migration 0003) with actor-scoped replay/conflict | HTTP 409 on conflict |
| Reversals | partial reversals model (sum of reversals ≤ original, `SELECT … FOR UPDATE`) | documented decision |
| FX | `lib/fx.ts` (revaluation) + `finance/fx` API + audit `fx.revalue` | |
| Commission | `lib/commission.ts` + `material_rate_history` (append-only, TIMESTAMPTZ, migration 0004) — event-time rate resolution | |
| **Clinic base currency** | `CLINIC_BASE_CURRENCY = "YER"` in `lib/money.ts` — constitutional constant; `finance.base_currency` setting retained only as a locked compatibility key (systemLocked, no runtime readers) | TD-05 (2026-09-17); `lib/settings-definitions.ts` |
| **Patient agreement currency** | per-agreement: `treatment_plans.base_currency` / `invoices.base_currency` (YER/SAR/USD chosen at creation); payments settle their invoice's currency bucket; balances are per-currency (`patientBalancesByCurrency`, `lib/money.ts`) | TD-05 |

**Status: ✅ (since TD-05).** The ledger is strongly owned (append-only, idempotent, guarded). Base currency is a constitutional constant (`CLINIC_BASE_CURRENCY = "YER"`, `lib/money.ts`); patient agreement currencies (YER/SAR/USD) are per-agreement and flow independently to installments, invoices, payments, statements and per-currency balances. TD-REG-004 closed.

---

## 10. Documents / Files

| Aspect | Canonical owner | Evidence |
|---|---|---|
| File storage | `DOCUMENTS_DIR` on durable volume (Railway volume `/data`) | X-ray bytes on disk, never in DB (Inviolable Don't #8) |
| Access layer | `lib/files.ts` (+ `imageSize.ts`, `magic-bytes.ts` validation) | turbopack-instrumented dynamic paths |
| Metadata | DB rows per document (patient-scoped) | |
| Durable-storage gate | `lib/storage-readiness.ts` + entrypoint ownership init (`docker-entrypoint.sh:13-30`) | refuses non-durable roots |
| Journeys | `scripts/journeys/documents.mjs` + `verify-documents.mjs` | upload/read/size backfill |

**Status: ✅.** Disk-vs-DB boundary enforced with fail-closed checks.

---

## 11. Audit

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Record | `audit_log` table — write-only (no update/delete path anywhere) | `lib/audit.ts:12-13` |
| Action vocabulary | `AuditAction` closed union (`lib/audit.ts:17-70`) — 90+ actions | |
| Writer | `recordAudit` `lib/db.ts:10457` (single choke point) | |
| Callers | 42 route files directly + lib-layer writers (booking, payments, settings…) | split responsibility — TD-REG-009 |
| Verification | `scripts/verify-audit.mjs` journey (real PG, append-only proof) | |

**Status: ⚠️.** Single record + single writer function; the responsibility for *when* to write is split between layers without a coverage matrix.

---

## 12. Backup / Restore

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Config resolution | `lib/backupConfig.ts` (settings table → explicit runtime config) | central interpretation |
| Engine | `lib/backupEngine.ts` (snapshot cycle) | |
| Data snapshot | `lib/backup.ts` (full data, no schema — designed for the owner, not an engineer) | |
| Production gate | `lib/productionBackup.ts` + `PRODUCTION_BACKUP_GATE.md` (PG18 isolated, 13 files/101 tests) | |
| Read path | `lib/backupReadOnly.ts` (read-only sessions, never touches `ensureSchema`) | |
| History / retention | `backupHistory.ts` (on durable disk, not the production DB) + `backupRetention.ts` | |
| Schedule decision | `backupSchedule.ts` (pure functions; trigger elsewhere) + `backupDayClaim.ts` (advisory day-claim) | |
| Destinations | `backupDestinations.ts` (multi-destination, encrypted via `backupEncryption.ts`) | |
| Restore | `scripts/restore.mjs` (data), `scripts/restore-full.ts` + `lib/restore/{archive,staging,validate}.ts` (full drill) | `SKIP_SEED` semantics |

**Status: ✅ (module sprawl noted, TD-REG-021).** Config is centralized; the read path is isolated from DDL; restore is a rehearsed drill (`restore-drill.test.ts`, 8 tests).

---

## 13. AI Actions

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Tool registry | `lib/ai-tools/registry.ts` (single execute path) | |
| Permission matrix | `lib/ai-tools/permission-matrix.ts` (role × tool) — the model the HTTP layer lacks (TD-REG-006) | |
| Confirmation tokens | `lib/ai-confirmation.ts` + `ai_confirmation_claims` table (jti, one-time, atomic insert) | P0.6 |
| Policy / privacy | `lib/ai-tools/policy.ts`, `privacy.ts`, `authorization.ts` | |
| Providers | `lib/ai-providers/{registry,adapters,presets,types}.ts` (Gemini/OpenAI/z.ai/DeepSeek/Anthropic/Groq, SSRF-guarded) | allowed-hosts list |
| Feature registry | `lib/ai-tools/system-feature-registry.ts` | what AI may claim exists |

**Status: ✅.** The most formally structured domain in the repo; its permission matrix is the pattern TD-04 proposes to mirror for HTTP routes.

---

## 14. Environment / CI Runtime Contract (TD-02)

| Aspect | Canonical owner | Evidence |
|---|---|---|
| Node major contract | `lib/env-contract.ts` (`SUPPORTED_NODE_MAJOR=22`) → enforced by `package.json` engines, `.nvmrc`, `setup-node` in CI, `FROM node:22-alpine` in Docker | `__tests__/environment-parity.test.ts` asserts all four agree |
| npm range contract | `lib/env-contract.ts` (`SUPPORTED_NPM_RANGE=">=10.9 <12"`) → `engines.npm`; CI pins major 11 for the audit bulk endpoint | documented rationale in `docs/ENVIRONMENT_CI_PARITY.md` |
| PostgreSQL test major | `lib/env-contract.ts` (`SUPPORTED_POSTGRES_MAJOR=18`) → `__tests__/postgres/_global-setup.ts` fails closed; `schema:contract` refuses non-18 | reproducible local: `docker compose up -d pg18` |
| Clinic timezone | `lib/clinicZone.ts` (section 7) + `CLINIC_TIME_ZONE=Asia/Aden` enforced literally in CI by `verify:environment` | section 7 unchanged by TD-02 |
| Environment preflight | `scripts/verify-environment.mjs` (`npm run verify:environment`) — fail-closed static check; a CI step since TD-02; inspects **every runtime connection alias** (`RUNTIME_DATABASE_URL_ENV_NAMES` + `TEST_DATABASE_URL` + `SOURCE_DATABASE_URL`) | no DB, no network |
| Local full gate | `scripts/verify-full.mjs` (`npm run verify:full`) — every essential fail-able CI gate in CI's order (schema-contract + baseline-manifest generation and committed-baseline verification included); artifact uploads remain CI-only provenance | step list tested against `REQUIRED_CI_GATES` (CI order + local order) |
| Env-var classification | `docs/ENVIRONMENT_CI_PARITY.md` (authoritative table) + `.env.example` | secrets never committed (`.gitignore` + tested) |

**Status: ✅ (since TD-02).** One contract source per runtime fact; drift between any two enforcement files fails `npm test`.

---

## Consolidated Verdict

| # | Domain | Status | Open item |
|---|---|---|---|
| 1 | Patient identity | ⚠️ | duplicate census + merge SOP (TD-REG-012) |
| 2 | Appointment | ⚠️ | single scheduling boundary (TD-REG-011) |
| 3 | Capacity | ✅ | — |
| 4 | Provider availability | ✅ | — |
| 5 | Waiting list | ✅ | — |
| 6 | Visit lifecycle | ⚠️ | flow split is documented; keep under watch |
| 7 | Clinic timezone | ✅ | — (env-owned by design) |
| 8 | Settings | ✅ | `finance.base_currency` locked (TD-REG-004 closed by TD-05) |
| 9 | Finance/currency | ✅ | constitutional YER + per-agreement YER/SAR/USD (TD-05) |
| 10 | Documents/files | ✅ | — |
| 11 | Audit | ⚠️ | coverage matrix (TD-REG-009) |
| 12 | Backup/restore | ✅ | — |
| 13 | AI actions | ✅ | — |

**The only hard conflict (❌) is base currency.** Everything else is either clean (✅) or has sanctioned secondary writers with documented reasons (⚠️).
