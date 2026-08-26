# Deployment Guardrails

## Environments
Use separate environments for development/preview and production. Never reuse credentials from the main `aqlan-dental` system.

## Neon
- Create a dedicated Neon PostgreSQL project/database for Aqlan Center Mini.
- Connection must come from `DATABASE_URL` only.
- Never commit a real connection string.
- Run schema changes through tracked Drizzle migrations.
- Use fake data only in development/preview.

## Vercel
- Deploy this repository as its own Vercel project.
- Keep preview and production environment variables separate where appropriate.
- Do not expose secrets through `NEXT_PUBLIC_*` variables.
- Verify the deployed app manually after each release, not only the build status.

## Required environment variables
- `DATABASE_URL`
- `AUTH_SECRET`
- `NEXT_PUBLIC_APP_NAME`
- `NEXT_PUBLIC_APP_TIMEZONE`

## Release checks
Before production use:
1. Typecheck passes.
2. Lint passes.
3. Tests pass.
4. Production build passes.
5. Database migrations pass.
6. Login works.
7. Critical patient workflow works against persistent storage.
8. Arabic RTL and English LTR are verified.
9. Mobile layout is verified.
10. No demo credentials, fake metrics, or real patient data are present in preview/test content.

## Safety
Do not merge to `main` or promote a production deployment without explicit user approval.
