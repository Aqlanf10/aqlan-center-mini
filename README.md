# Aqlan Center Mini

Lightweight clinic operations system for **مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان** (Dr. Aqlan Complete Center for Orthodontics, Implants and Cosmetic Dentistry).

This repository is a clean, independent application and must remain isolated from the main `aqlan-dental` production system and its database. It focuses on the daily workflow: authentication, patients, appointments, today's operations, visits, follow-up/recall and contact tracking. See `docs/PROJECT_SCOPE.md` for the MVP scope.

**Current stage: daily operations + finance (feat/mvp-v1), Railway-native.** The full daily cycle works against PostgreSQL: Patient → Appointment → Arrival → Visit → Complete → Next appointment → Follow-up, plus a complete finance module: services catalog, visit work items, treasury accounts, numbered receipt/payment vouchers (RCPT-/PV-YYYY-NNNNNN), reversals with counterpart entries, doctor commissions with plan snapshots, lab cases & balances, suppliers & purchase invoices, daily closing / period reports and A5/A4 print pages. Every number on screen is computed from the database — placeholder/mock data does not exist in the codebase. A Railway project with `web` + `postgres` services is the deployment target (runbook in `docs/DEPLOYMENT.md`); finance design in `docs/FINANCE_DESIGN.md`.

## Stack

| Layer      | Choice |
| ---------- | ------ |
| Framework  | Next.js (App Router) + React + TypeScript strict |
| Styling    | Tailwind CSS v4 + shadcn/ui primitives + Lucide icons |
| Language   | Custom cookie-based i18n — Arabic (default, RTL) / English (LTR) |
| Database   | PostgreSQL on Railway (`postgres` driver) + Drizzle ORM + Drizzle Kit |
| Validation | Zod |
| Auth       | Better Auth (username + password, sessions in PostgreSQL) |
| Tests      | Vitest (unit + real-PostgreSQL integration via embedded-postgres) |
| CI         | GitHub Actions (typecheck, lint, tests, production build) |

Package manager: **npm only** (`package-lock.json` committed; do not use pnpm/yarn).

## Development

```bash
npm ci            # install dependencies (first time / after pulling)
npm run dev       # start the dev server
npm run build     # production build
npm run lint      # ESLint
npm run typecheck # TypeScript strict check
npm test          # unit + PostgreSQL integration tests (vitest)
```

Copy `.env.example` to `.env.local` and fill in the values before running the app locally.

### Environment variables (names only)

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` | PostgreSQL connection string (Railway reference variable or local; secret — never commit) |
| `AUTH_SECRET` | Secret used by Better Auth (generate with `openssl rand -base64 32`) |
| `NEXT_PUBLIC_APP_NAME` | Public application name |
| `NEXT_PUBLIC_APP_TIMEZONE` | Clinic timezone — `Asia/Aden` |
| `ADMIN_USERNAME`, `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional — used only by the seed script when creating the first administrator |

Never put secrets in `NEXT_PUBLIC_*` variables. Never commit `.env`, `.env.local` or any real connection string.

## Database workflow (Drizzle + PostgreSQL on Railway)

1. Railway provides a dedicated PostgreSQL service for this project (do not reuse any database from `aqlan-dental`). Its connection string is exposed to the web service as the `DATABASE_URL` reference variable (`${{Postgres.DATABASE_URL}}`).
2. Locally, put an equivalent connection string in `.env.local`.
3. Generate and apply migrations:

```bash
npm run db:generate   # generate SQL migrations from src/db/schema
npm run db:migrate    # apply pending migrations to DATABASE_URL
npm run db:studio     # optional: browse the database
```

Schema lives in `src/db/schema` (users, patients, appointments, visits, patient_contacts, charges, payments, audit_logs, plus Better Auth tables). Generated migrations are tracked in `drizzle/` and committed.

Design notes:

- **Currencies are never mixed.** YER / SAR / USD live in separate balances on every voucher, statement and report; there is no cross-currency total anywhere.
- **Vouchers are append-only.** A wrong receipt/payment voucher is corrected by a reversal entry (same type, linked via `reversal_of_voucher_id`, mandatory reason) — never an edit or delete. Patient balances, treasury balances, lab/supplier balances and the daily closing are all derived from the real voucher/payment rows.
- **Idempotency keys** guard every voucher and legacy charge/payment against double-clicks and retries (unique PK + same-transaction claim).
- **One visit per appointment** — a partial unique index on `visits(appointment_id)` is the database barrier.
- **Completed visits are immutable**; later corrections are appended as audited `visit_corrections` rows.
- **Commission plans are snapshotted** onto each commission row at creation; editing a plan never rewrites history. Unplanned commissions stay PENDING with no amount until ADMIN sets/approves one.
- **File numbers** are human-readable (`P-000001`) and drawn from the PostgreSQL sequence `patient_file_number_seq` — concurrency-safe, never `MAX()+1`. The UUID primary key stays internal.
- **Double-booking guard**: a partial unique index keeps one doctor from holding two active appointments at the exact same time; the UI also pre-checks for a friendly bilingual error.
- **Clinical retention**: no cascade deletes from patients to appointments/visits/payments/charges/contacts (`RESTRICT`). Patients are archived (`active = false`), never hard-deleted from the UI.
- **Atomic visit completion** runs in one SQL transaction (visit + linked appointment + optional next appointment together or not at all).
- **Timezone**: every “today/due/overdue” computation anchors to `Asia/Aden`; the UTC↔Aden midnight boundary is unit-tested.
- **Follow-up engine** is a pure module (`src/server/follow-up/logic.ts`) with derived statuses — nothing stale is stored. Queues: Due Today / Due Soon (3-day central window) / Overdue / No Next Appointment / Missed / Contacted.

4. Seed the first administrator (after migrating):

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' npm run db:seed
```

The seed script never prints the password; Better Auth stores a strong one-way hash (scrypt). Further staff accounts (ADMIN / DOCTOR / RECEPTION) are created by an administrator under **Settings → Staff**; deactivating a user terminates their sessions immediately. Public self-signup is disabled at the auth level.

## Branch strategy

- `main` — protected; only updated by merging the reviewed PR.
- `feat/mvp-v1` — current MVP work branch. PR #1 (`feat/mvp-v1` → `main`) stays **draft** until the foundation is reviewed.
- No direct commits to `main`. Do not merge or close PR #1 without explicit approval.
- Commit style: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:` with small, focused commits.

## Security

- Server-side authorization on every protected page (`requireUser` / `requireRole` in `src/lib/auth/guards.ts`); hiding UI buttons is never the protection.
- Unknown roles in a session fail **closed** (treated as unsigned-in) — never a default role.
- Sessions are persisted server-side; the edge `proxy.ts` only performs a cheap cookie gate before the real check.
- Passwords are stored as strong one-way hashes (scrypt via Better Auth) — never plaintext, never logged; public self-registration is disabled.
- Deactivated users (`active = false`) are blocked from creating sessions and their live sessions are revoked on deactivation.
- Every mutation is Zod-validated server-side; client validation is UX only.
- WhatsApp contact uses `wa.me` deep links with `+967` normalization — no paid API, nothing sent automatically.
- `.env*` files with secrets are git-ignored; `.env.example` documents variable names only.
- No real patient data in development, CI, seeds or previews — fake data only.
- Clinical and financial tables use archive/soft-delete-friendly patterns; sensitive actions belong in `audit_logs` (patient/appointment/visit/contact/charge/payment/user events with actor + entity + timestamp).

## Deployment architecture

**Railway is the single production platform** for this project (no Neon, no Supabase, no Vercel):

```
Railway — aqlan-center-mini
├── Next.js Web        (this repository, Nixpacks build, /api/health probe)
├── PostgreSQL         (dedicated service, referenced as ${{Postgres.DATABASE_URL}})
├── Future Object Storage (patient photos, X-rays, documents)
├── Future Worker      (background jobs)
├── Future Cron        (scheduled recall reminders)
└── Future Redis       (queues/cache when needed)
```

- Deploy as its own **Railway project** with a `web` service (this repo) and a `postgres` service.
- Required runtime variables: `DATABASE_URL`, `AUTH_SECRET`, `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_TIMEZONE` (+ `BETTER_AUTH_URL` set to the public Railway domain).
- Migrations run as an explicit release step (`npm run db:migrate`) — never automatically on every app restart.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and a production build on every PR — with a format-valid placeholder `DATABASE_URL`, because the build never connects to a database.
- Release checklist and step-by-step Railway runbook: `docs/DEPLOYMENT.md`.

## Repository layout

```
src/
  app/            # App Router pages (login + authenticated shell group + /print sheets)
  components/     # shadcn/ui primitives, layout shell, domain components
  db/             # Drizzle client + schema (src/db/schema)
  i18n/           # locale config, dictionaries (ar/en), server + client helpers
  lib/            # auth (server/client/guards/rbac), datetime, whatsapp, money, validation
  server/         # domain layer: patients/appointments/visits/follow-up/contacts/staff/
                  # finance (vouchers, accounts, reports, statements) / services / commissions /
                  # labs / suppliers
  proxy.ts        # edge gate for protected routes (Next.js proxy convention)
drizzle/          # generated, committed SQL migrations
tests/            # PostgreSQL integration tests (embedded PostgreSQL, real migrations)
scripts/          # seed-admin.ts (first administrator)
docs/             # project scope + finance design + deployment + operations guardrails
```

Agent rules that apply to every change in this repository: `AGENTS.md`.
