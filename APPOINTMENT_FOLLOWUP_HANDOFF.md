# Appointment follow-up foundation — dormant, not release-ready

Independent clone: `task-2/appointment-followup`; branch: `feat/appointment-followup`.
Base: PR #429, `bc5cae2bed642069dda2326e353fa1d17c3ada40`, verified against GitHub.
PR #420 head `181cab90350c421d40fed24fb92a7c8fa0667b44` is an ancestor.
The source doctor-availability checkout was read only; its uncommitted work was not copied or changed.

## Implemented candidate

- Strict command contract with an expected patient ID witness; no arbitrary notes, patient names, phone numbers, diagnoses or treatment text.
- Unnumbered schema in `lib/appointment-followup-schema.ts`, installed only by its PostgreSQL test. **No runtime registration.**
- One task per original appointment ID + exact PostgreSQL creation epoch (six fractional digits) + existing reset generation. Immutable source identity, nullable live appointment/patient references, and revision control.
- `readAppointmentFollowupSource` produces the draft's appointment ID, expected patient ID, full-precision timestamp and generation from live server context after current authorization. The writer compares all of them with the locked source before creation or receipt lookup. Patient identity is included in the request digest, not copied into history FKs. A pre-merge or pre-reassignment draft fails with 409, including a lost-response retry; changing its witness with the same request key also conflicts.
- Append-only structured events and actor-scoped request receipts; no patient FK in either history table. Current task patient FK can follow the canonical patient merge.
- `saveAppointmentFollowup` performs source locking, current session and patient access checks, assignee validation, revision check, task write, event, receipt and canonical audit in one transaction. It uses the existing shared reset fence without modifying it or any booking/HR/financial writer.
- Per-actor request locking serializes exact retries; source row locking serializes competing creation. Exact replay returns the original revision after current session/source validation. Another actor cannot receive the first actor's receipt.
- Explicit creation for a past/current, recorded `no_show`, with no attendance/visit evidence. Elapsed time alone creates nothing. `no_answer`/`awaiting_reply` stay open and need future due time. Rebooking remains `rebooking_review`; no arbitrary appointment link or “rebooked” closure is accepted.
- `readAppointmentFollowupQueue` is a bounded current-generation open backlog, with live patient context joined only after admin/reception session authorization. Missing, reassigned or reused source identities return no patient context. It has no selected-day filter, no auto-creation, and no HTTP endpoint yet.
- Transaction cleanup destroys connections after failed BEGIN, uncertain COMMIT or failed ROLLBACK, and preserves the original failure even if release also fails.
- Two audit action labels, without changing the audit writer.

## Coordination proposal — not applied

Last migration present in the verified base: `0069_unpaid_currency_transitions.sql`. No `0070+` number reserved or assigned here. Recheck remote work before allocating one.

After PG18 evidence and review, proposed touch points are:

1. An agreed numbered migration, byte-identical runtime registration in `lib/db.ts`, chain counts/manifests/schema contract regenerated through existing generators.
2. Explicit reset classification for the three tables. The earlier protected-history refusal proposal changes existing operational behavior and is **not an approved or final policy**. Reset policy requires owner review before any registration. **Nulling live references alone does not solve PostgreSQL TRUNCATE FK dependencies**; do not add these tables to a wipe list or bypass immutable triggers. No reset change has been made.
3. Backup/restore and schema-ownership coverage for all three tables/functions/triggers; restore ordering task → event → receipt; patient merge/deletion compatibility evidence.
4. Narrow admin/reception API routing/permission registration with existing bounded body/CSRF conventions, then recall editor/queue. UI must retain the frozen attempt/key across lost responses and isolate responses after actor/patient changes. A WhatsApp draft is not contact or delivery.
5. Separate leadership backlog panel after the underlying slice passes. No selected-day KPI substitution.

## Verification and blockers

- Read `AGENTS.md`, local Next route-handler guide, PostgreSQL global setup, safe-target guard and related rebooking/merge/reset tests.
- `.agents/skills` was absent from this Git checkout, the authorized doctor checkout and inspected ancestor locations. No substitute repository skill instructions were invented.
- After the expected-patient identity fix, focused follow-up and adjacent audit suites passed: **6 files, 52 tests** (Node 24.15.0). Repository requires Node 22, so this is provisional runtime evidence. No tests or SQL assertions were weakened.
- Focused ESLint: passed after repairing an incomplete npm install and fixing transaction cleanup structure.
- Final full nonincremental typecheck after the expected-patient identity fix: passed (exit 0, empty diagnostic log), on the current foundation and test files. Node remains 24.15.0 rather than the repository-required Node 22.
- PostgreSQL suite: **not executed**. The existing global setup refused startup because neither `TEST_DATABASE_URL` nor `DATABASE_URL` was configured. No alternate database, PGlite fallback, target-guard change, secret-file read or environment switch was used.
- Locked dependency installation initially crashed and left a corrupt dependency. Retrying `npm ci --ignore-scripts --maxsockets=1` succeeded without package/lockfile changes.
- Adjacent audit test initially failed solely because Windows checkout converted an unchanged migration to CRLF. That file was restored from Git with LF; no SQL/assertion was modified.

## Required evidence before activation

The authored PG suite covers concurrency, exact retries/content conflicts/actor scope, stale revision, changed sessions/roles, invalid source states/future sources, no-answer/waiting, source microsecond identity, deletion/ID reuse, patient reassignment, canonical patient merge, append-only constraints, live-context queue, explicit closure/separate replacement history and audit rollback. **None of these database cases is claimed to have passed.**

Still required: real reset integration (including saved and unsaved pre-reset intents and reused IDs), controlled clinic-midnight tests, merge/reset/session/attendance races, restored-backup identity, nonempty financial/clinical sentinel fingerprints, HTTP permission/CSRF tests and browser lost-response/actor-switch checks. The current fingerprint assertion includes several empty financial tables and is not sufficient release evidence by itself.

There is no active API, recall editor, leadership panel, numbered migration, PR, deployment, merge, WhatsApp send or paid-service activation. `lib/db.ts`, reset registry, permissions, financial writers, booking guards and HR locks remain unchanged.

## Design review details

- Merge: only the live task has a patient FK. The canonical FK-driven merge should move that FK and the appointment FK together. Events and receipts contain no patient FK and no copied patient context, so merge must not update history. Both isolated reassignment and a legitimate merge invalidate old displayed-patient witnesses: old requests return 409 before receipt access. Refreshing context is explicit, and a changed witness cannot reuse an old key.
- Deletion: appointment deletion nulls the task's live appointment reference; patient deletion nulls its live patient reference. Original source ID, full-precision timestamp and generation remain immutable. An orphan cannot be rebound even if an appointment number is reused. Queue context/identity becomes null with `source_unavailable_review_required`, `contactBlocked: true` and `rebookingBlocked: true`; edits/replays fail closed. No active UI exists yet. The first slice never claims a proved replacement booking for any task.
- History: typed state snapshots, actor ID, request ID, digest and revision; append-only triggers forbid UPDATE/DELETE and nonempty TRUNCATE. Receipt uniqueness is actor + request ID, linked to the exact event/digest. The writer commits state + event + receipt + canonical audit together. Database transaction/race guarantees still need real PG18 execution.
- Reset policy remains undecided and unregistered. The added synthetic PG cases advance the actual reset-generation marker, reuse the exact original appointment ID and timestamp, and assert 409 with identical task/event/receipt/audit snapshots for both saved and unsaved attempts. This tests the generation boundary when executed; it does not exercise or approve the canonical reset workflow.
- The previously identified creation-intent gap is addressed by the required expected-patient witness and locked comparison. Authored PG tests cover reassignment/merge before creation, reassignment/merge after creation, replay after merge, changed-witness key reuse and reset-generation ID reuse, asserting no partial writes. PG execution remains blocked.

## Computer reconnection

The same clone and branch were recovered without recreation. The old final TypeScript process/session no longer existed, and its result was not recoverable; only this unconfirmed check was rerun, with persistent output in `../followup-typecheck.log` and exit status in `../followup-typecheck.exit`. No PostgreSQL executable, Docker executable or PostgreSQL Windows service was found in the scoped availability checks. No credentials, security settings or database targets were created or changed.

## Review delivery gate

The owner authorized a local independent commit and a Draft PR only after available Node 22 checks pass. Only Node 24.15.0 was found on PATH and in the inspected standard version-manager locations (Roaming/nvm, Local/fnm, ~/.nvm, ~/.fnm, C:/tools/nodejs). No runtime was downloaded or system settings changed. Therefore no push or Draft PR is performed on this evidence. PG18 remains unexecuted. The eventual review title must explicitly state: schema unregistered, API/UI inactive, PG unexecuted; its base must be the #429 branch, not main.
