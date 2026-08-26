# AGENTS.md — Aqlan Center Mini

These rules apply to all coding agents working in this repository.

## Repository boundary
- Work only in `Aqlanf10/aqlan-center-mini`.
- Do not modify or depend on the production `aqlan-dental` repository.
- Do not copy production secrets, credentials, patient data, or database URLs from any other project.
- This app must remain independently deployable and independently reversible.

## Branch safety
- Do not commit feature work directly to `main`.
- Use `feat/mvp-v1` for the initial MVP unless the user explicitly changes the branch strategy.
- Do not merge or close the PR without explicit user approval.
- Fetch/review the latest branch state before major edits or final commits.

## Product goal
Build a lightweight, reliable clinic operations web app focused first on:
1. Authentication
2. Patients
3. Appointments
4. Today's operations
5. Visits
6. Follow-up / recall
7. Contact tracking

Avoid expanding into inventory, lab, cephalometry, AI, patient portal, or advanced accounting until the core workflow is stable.

## Technology direction
Preferred stack:
- Next.js App Router
- TypeScript strict mode
- Tailwind CSS
- shadcn/ui where helpful
- Neon PostgreSQL
- Drizzle ORM
- Zod
- Server-side authorization

Use a single package manager consistently; default to npm unless there is a strong reason not to.

## Language and UX
- Arabic is the default language and must support RTL correctly.
- English must support LTR correctly.
- Mobile-first design is required.
- Timezone is `Asia/Aden`.
- Every visible action should work; do not ship fake buttons, fake metrics, or mock persistence as production behavior.

## Data and security
- Never commit `.env*` secrets.
- Never commit real patient data.
- Use fake/demo data only in tests and seeds.
- Passwords must never be stored in plaintext.
- Authorization must be enforced server-side, not only by hiding UI.
- Prefer archive/soft-delete patterns for clinical and financial records.
- Audit sensitive actions.

## Quality gates
Before declaring a stage complete, run and report:
- typecheck
- lint
- tests
- production build

Fix real failures rather than disabling checks.
