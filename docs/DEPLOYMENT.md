# Deployment Guardrails — Railway

**Railway is the single, unified platform for this project.** The Next.js web
application, PostgreSQL, and (in the future) object storage, workers, cron jobs
and Redis all run inside one dedicated Railway project. Neon, Supabase and
Vercel are **not** part of this project's production path.

```
Railway — aqlan-center-mini
├── web        Next.js (this repository; Nixpacks build; /api/health probe)
├── postgres   PostgreSQL (dedicated; do not share with any other project)
├── (future) Object Storage — patient photos, X-rays, documents
├── (future) Worker        — background jobs
├── (future) Cron          — scheduled recall reminders
└── (future) Redis         — queues/cache when needed
```

## Environments
Use separate environments for development/preview and production. Never reuse
credentials or databases from the main `aqlan-dental` system. Use fake/demo
data only in development and preview.

## Step-by-step Railway runbook

1. **Create the project** — in Railway, create a project named
   `aqlan-center-mini` with two services:
   - `web` — deployed from this GitHub repository (branch `feat/mvp-v1` or
     `main` after merge).
   - `postgres` — a new PostgreSQL service created **for this project only**
     (never `aqlan-dental`, never shared).
2. **Connect the database** — in the `web` service Variables, set
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (reference variable — no
   credential copy/paste, nothing in source control).
3. **Set required variables** on `web`:
   - `AUTH_SECRET` — strong random secret (`openssl rand -base64 32`); store it
     only in Railway Variables, never in the repository or reports.
   - `NEXT_PUBLIC_APP_NAME=Aqlan Center Mini`
   - `NEXT_PUBLIC_APP_TIMEZONE=Asia/Aden`
4. **Deploy** — `railway.json` pins the build (`npm run build`) and start
   (`npm run start`) commands and wires the `/api/health` health check.
   Nixpacks auto-detection handles the rest; `next start` binds to Railway's
   `PORT` automatically.
5. **Apply migrations (release step)** — after the first successful build, run
   once per deploy that includes schema changes:
   `railway run npm run db:migrate` (or Railway's shell on the `web` service).
   Migrations are an **explicit release step** — the app never migrates on
   startup/restart by itself, so multiple instances cannot race migrations.
6. **Seed the first administrator** (only once, after migrating):
   `railway run npm run db:seed` with `ADMIN_USERNAME` / `ADMIN_PASSWORD`
   (strong, ≥ 8 chars) / optional `ADMIN_NAME`, `ADMIN_EMAIL`. The password is
   never printed or logged.
7. **Set the public origin** — set `BETTER_AUTH_URL` to the Railway public
   domain (e.g. `https://aqlan-center-mini.up.railway.app`) so auth redirects
   never fall back to localhost in production.
8. **Verify manually** — login, patient CRUD, appointment → arrival → visit →
   completion → follow-up, Arabic RTL and English LTR, mobile layout, and
   `/api/health` returning `200 {"status":"ok","database":"connected"}`.

## Database backups
Railway PostgreSQL does **not** include automatic scheduled backups on the
free/hobby plan. Until the project is on a plan with automated backups (or
Railway's backup feature is enabled for the `postgres` service), treat manual
`pg_dump` exports as the only backup path and document a schedule. Do not
build a custom backup system for the MVP; revisit when real patient data
enters the system.

## Future storage (not in MVP)
Patient photos, X-rays and documents will use Railway's object storage when
that feature is added. Do not integrate Supabase Storage or external S3 for
this project.

## Future mobile apps
Android/iOS staff apps and the patient app will consume the same Railway
backend. Business logic lives in the `src/server/` domain layer (pure,
reusable modules for patients, appointments, visits, follow-up, staff and
finance) — React components only render it. Keep it that way so an HTTP/JSON
API can be exposed for mobile clients without rewriting the system.

## Required environment variables
- `DATABASE_URL` — PostgreSQL connection string from Railway (reference
  variable). All connection parameters come from this URL; nothing is
  hard-coded.
- `AUTH_SECRET`
- `NEXT_PUBLIC_APP_NAME`
- `NEXT_PUBLIC_APP_TIMEZONE`
- Optional: `BETTER_AUTH_URL` (recommended in production), `DATABASE_SSL`,
  `DATABASE_POOL_MAX`, `ADMIN_*` (seed only).

## Release checks
Before production use:
1. Typecheck passes.
2. Lint passes.
3. Tests pass.
4. Production build passes.
5. Database migrations pass (as an explicit release step).
6. Login works on the deployed URL.
7. Critical patient workflow works against persistent storage (create →
   refresh → still there).
8. `/api/health` returns 200 with `database: connected`.
9. Arabic RTL and English LTR are verified.
10. Mobile layout is verified.
11. No demo credentials, fake metrics, or real patient data are present in
    preview/test content.

## Safety
Do not merge to `main` or promote a production deployment without explicit
user approval. Never commit a real connection string or `AUTH_SECRET`.
