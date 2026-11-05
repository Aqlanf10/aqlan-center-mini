# Staging integration plan — two parallel tracks (2026-11-05)

## Owner directive (2026-11-05, recorded verbatim in intent)

The owner changed how the work proceeds: Staging trials no longer wait for the whole governance programme.

**Track 1 — governance continues on WORK** (`feat/work-recovery-followup-20261027`):
- permissions, account migration, defect fixes and audit findings;
- no phase stops and no repeated approvals;
- completed work is committed and pushed periodically with test evidence;
- full completion of governance is not a precondition for saving work.

**Track 2 — Staging, gradually and safely.** A separate integration branch, never the WORK branch itself. It carries only fixes whose dependencies are verified and which do not conflict with the current version. Before any deploy:
- the full build, then unit, PostgreSQL, HTTP, Playwright, permission and security gates;
- migration compatibility with the Staging database;
- a restore and rollback test;
- a backup before any change.

The Staging database is independent and holds synthetic data only for sensitive changes. Failed tests are never bypassed, and governance and permission constraints are never relaxed. If all gates pass, the chosen SHA is deployed to Staging only, and the SHA, CI results and deploy status are recorded. The owner then receives the link, the features to try and the remaining risks.

**Mandatory limits:**
- No full merge of WORK into `main`.
- Nothing on Production; the production database is never touched.
- No incomplete feature on Staging presented as ready.
- Staging preparation never stalls governance.
- No overlap with Dot's work or Dot's ortho/ceph branch.

## Infrastructure decision (owner, 2026-11-05)

There was no Staging environment (`docs/STAGING_READINESS.md`, TD-02). The owner chose the following setup.

**Owner sets up the environment.** In the same Railway project, a `staging` environment with:
- its own app service, PostgreSQL and volume;
- `DATABASE_ENVIRONMENT=staging`;
- a new `SESSION_SECRET`;
- nothing shared with Production;
- auto-deploy from the branch `staging/integration-20261105`.

**Claude's side:**
- Gating happens on `feat/staging-candidate-20261105` (CI runs on `feat/**`).
- Only a SHA that passed every gate is pushed to `staging/integration-20261105` (CI does not run there; a push deploys).
- Claude holds no Railway credentials.

## Update (owner, 2026-11-05, later the same day)

Dot already has a Staging environment ready and separate from Production. The request to create a new Railway environment is withdrawn. Claude waits for Dot's report on:
- the deploy branch or mechanism;
- database and secret isolation;
- the PostgreSQL version;
- backup and rollback.

Until then nothing is pushed to any deploy branch. The candidate keeps its full gate so it is ready when the target is confirmed.

## Candidate composition (first wave)

The base is `origin/main` (`c6c88612`). It takes the reviewed legacy-path batches from the REVIEW head `9c31e071`, whose CI was green: features that work with today's accounts, without the canonical identity runtime.

| Commit | Content | Wave 1 |
|---|---|---|
| `6b4c31a5` | Invoice archive and service additions (0081, 0082), statement batch | Yes |
| `0b654f4c` | Booking, lab work intents (0074), patient numbering (0080), ortho follow-up coverage (0079), CI repairs | Yes |
| `56f5be4d`, `7f31b1c3`, `94f7aed1`, `2aafa2ff`, `58a317f1`, `487001dd`, `9c31e071` | Test, fixture and CI contract repairs for the above | Yes |
| `1194db38` | Partial inventory recovery and PR482 composition | No: partial |
| `8658cf44` | Quarantined, unregistered staff identity substrate | No: not a feature |
| WORK M1–M3 canonical runtime (slices 1–94) | Staff identity, grants and scopes | No: its tables (0076, 0083–0086) are not registered yet (M4); a later wave after M4 and the schema rehearsal |

The trial cherry-pick on `c6c88612` conflicts in 16 files. They are mostly shared registries, tests, `lib/db.ts` and the schema contract that both sides extended. Each one is resolved by hand, then the full gate runs.

## Remaining risks known now

- **Migration order on Production:** it already has 0087 and 0089. Adopting 0074 and 0079–0082 there later is out of order. A fresh Staging database applies them in order. This is to be proven in the schema rehearsal before any Production plan (none is in scope).
- **The canonical identity runtime** (the main body of WORK) is not in wave 1.
