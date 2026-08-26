# Aqlan Center Mini

Lightweight clinic operations system for **مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان** (Dr. Aqlan Complete Center for Orthodontics, Implants and Cosmetic Dentistry).

This repository is a clean, independent application and must remain isolated from the main `aqlan-dental` production system and its database. It focuses on the daily workflow: authentication, patients, appointments, today's operations, visits, follow-up/recall and contact tracking. See `docs/PROJECT_SCOPE.md` for the MVP scope.

**Current stage: foundation (this branch).** The application shell, bilingual UI, database schema, authentication and RBAC are in place. Patient/appointment CRUD arrives in the next stage — pages show real empty states, never fake numbers.

## Stack

| Layer      | Choice |
| ---------- | ------ |
| Framework  | Next.js (App Router) + React + TypeScript strict |
| Styling    | Tailwind CSS v4 + shadcn/ui primitives + Lucide icons |
| Language   | Custom cookie-based i18n — Arabic (default, RTL) / English (LTR) |
| Database   | Neon PostgreSQL (serverless HTTP driver) + Drizzle ORM + Drizzle Kit |
| Validation | Zod |
| Auth       | Better Auth (username + password, sessions in PostgreSQL) |
| Tests      | Vitest |
| CI         | GitHub Actions (typecheck, lint, tests, production build) |

Package manager: **npm only** (`package-lock.json` committed; do not use pnpm/yarn).

## Development

```bash
npm ci            # install dependencies (first time / after pulling)
npm run dev       # start the dev server
npm run build     # production build
npm run lint      # ESLint
npm run typecheck # TypeScript strict check
npm test          # unit tests (vitest)
```

Copy `.env.example` to `.env.local` and fill in the values before running the app locally.

### Environment variables (names only)

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` | Neon PostgreSQL connection string (secrets — never commit) |
| `AUTH_SECRET` | Secret used by Better Auth (generate with `openssl rand -base64 32`) |
| `NEXT_PUBLIC_APP_NAME` | Public application name |
| `NEXT_PUBLIC_APP_TIMEZONE` | Clinic timezone — `Asia/Aden` |
| `ADMIN_USERNAME`, `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional — used only by the seed script when creating the first administrator |

Never put secrets in `NEXT_PUBLIC_*` variables. Never commit `.env`, `.env.local` or any real connection string.

## Database workflow (Drizzle + Neon)

1. Create a **dedicated** Neon PostgreSQL project for this app (do not reuse any database from `aqlan-dental`).
2. Put its connection string in `DATABASE_URL` (`.env.local` locally, Vercel env vars in deployment).
3. Generate and apply migrations:

```bash
npm run db:generate   # generate SQL migrations from src/db/schema
npm run db:migrate    # apply pending migrations to DATABASE_URL
npm run db:studio     # optional: browse the database
```

Schema lives in `src/db/schema` (users, patients, appointments, visits, patient_contacts, charges, payments, audit_logs, plus Better Auth tables). Generated migrations are tracked in `drizzle/` and committed.

4. Seed the first administrator (after migrating):

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' npm run db:seed
```

The seed script never prints the password; Better Auth stores a strong one-way hash (scrypt). Additional staff accounts are created by an administrator inside the app in a later stage.

## Branch strategy

- `main` — protected; only updated by merging the reviewed PR.
- `feat/mvp-v1` — current MVP work branch. PR #1 (`feat/mvp-v1` → `main`) stays **draft** until the foundation is reviewed.
- No direct commits to `main`. Do not merge or close PR #1 without explicit approval.
- Commit style: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:` with small, focused commits.

## Security

- Server-side authorization on every protected page (`requireUser` / `requireRole` in `src/lib/auth/guards.ts`); hiding UI buttons is never the protection.
- Sessions are persisted server-side; the edge `proxy.ts` only performs a cheap cookie gate before the real check.
- Passwords are stored as strong one-way hashes (scrypt via Better Auth) — never plaintext, never logged.
- Deactivated users (`active = false`) are blocked from creating sessions.
- `.env*` files with secrets are git-ignored; `.env.example` documents variable names only.
- No real patient data in development, CI, seeds or previews — fake data only.
- Clinical and financial tables use archive/soft-delete-friendly patterns; sensitive actions belong in `audit_logs`.

## Deployment architecture

- Deploy as its own **Vercel project** from this repository (preview + production environments, separate env vars).
- Database: dedicated Neon PostgreSQL project (`READY TO CONNECT` — no production deployment has been made yet).
- Required runtime env vars on Vercel: `DATABASE_URL`, `AUTH_SECRET`, `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_TIMEZONE`.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and a production build on every PR — with a format-valid placeholder `DATABASE_URL`, because the build never connects to a database.
- Release checklist before production use: `docs/DEPLOYMENT.md`.

## Repository layout

```
src/
  app/            # App Router pages (login + authenticated shell group)
  components/     # shadcn/ui primitives, layout shell, shared components
  db/             # Drizzle client + schema (src/db/schema)
  i18n/           # locale config, dictionaries (ar/en), server + client helpers
  lib/            # auth (server/client/guards/rbac), datetime, validation, db re-exports
  proxy.ts        # edge gate for protected routes (Next.js proxy convention)
drizzle/          # generated, committed SQL migrations
scripts/          # seed-admin.ts (first administrator)
docs/             # project scope + deployment guardrails
```

Agent rules that apply to every change in this repository: `AGENTS.md`.
