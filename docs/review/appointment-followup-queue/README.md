# Appointment follow-up queue — bounded Draft continuation

Base: #434, exact `598b1664fb58b2fc0ea3ed9e623cbecc1ac258a2` (`feat/appointment-followup`). New branch: `feat/appointment-followup-queue-20261023`. This is stacked on the dormant foundation; it does not modify #434, #439, main or any finance branch. Its ancestry includes #434's frozen finance-union base; the diff against #434 contains no finance behavior change.

## Behavior

- Admin/reception only, at both HTTP admission and current-session transactional revalidation. Unknown methods, CSRF, bounded bodies and cache policy use the existing doors. Doctors, assistants, cashier and accountant receive no follow-up authority.
- Explicit tasks for recorded eligible no-shows. Today's successful no-show action offers task creation; patient appointment history offers the same editor. Opening the editor/draft is read-only. The open queue is separate from daily classification and has patient-scoped views.
- Keyset pagination uses `(due_at,id)` with exact PostgreSQL microseconds, bounded page size, patient-bound cursors and current reset generation. No 100-row truncation. This is a live queue, not a frozen export; changing deadlines can move rows between pages, so the UI offers restart/refresh.
- No-answer and awaiting-reply remain open with a future due time. Assignees must remain active admin/reception. Revision checks prevent concurrent double outcomes.
- Local persisted attempts contain structured IDs/state only and are written before POST. Lost-response retries use the exact same request key/body across remount/reload. All refusals, including 400/404/409, retain the exact attempt; context refresh never deletes it. Origin-wide Web Locks coordinate simultaneous editors/tabs, with compare-before-delete only after a validated success receipt. Replaced session objects remount the editor; prior responses cannot render into the replacement.
- Rebooking navigates to the existing patient summary / planned-session rebook path (#420 ancestor), with its capacity, stale-source and idempotency checks. No replacement booking is inferred or marked complete by this queue. Ordinary booking remains in the existing appointment workflow. There is no new booking writer.
- No automatic WhatsApp sending, reminder timestamp or message-delivery write. Task creation is pending work, never proof of contact or sending. No finance lifecycle, HR enforcement, credentials, production or backup operations.

## Schema and history

Number 0070 allocated after inspecting latest open PRs through #441 and the full local chain ending 0069; #434 reserved no number. Migration and runtime DDL are byte-identical. Runtime registration and active reset classification ship together. Numbered-chain tests and generated current contract/disclosure are updated mechanically; baseline manifest is unchanged.

The existing live-link, generation, source timestamp, immutable history, reset and restore guards are retained. Links alone are wiped; tasks/events/receipts persist. Missing links are never recreated. The existing export dependency still inserts links before events. No shared restore algorithm change.

## Validation

Results and exact tested source SHA are recorded in the Draft PR. All DB/HTTP data is synthetic in a new isolated local PostgreSQL 18.6 container. Runtime for final checks is temporary local Node 22 with the committed lockfile (`npm ci`); no dependency file change.

Initial Node 24 run: 85 focused unit tests and 77 focused PostgreSQL tests passed. An initial build exposed the new SQL placeholder missing from a TypeScript literal union; corrected without changing eligibility SQL. These preliminary results do not substitute for final Node 22 checks.

Schema ownership: zero unexpected differences, 16 pre-existing open convergence findings. This does not claim runtime/full-chain schema equality.

## Remaining limits

- This is not completion of the appointment mandate or release authorization. No merge/deploy.
- Linked planned-session rebooking is a handoff to the existing patient workflow, not a single atomic follow-up + booking command or automatic task closure.
- Pagination is live, and closed/historical tasks are preserved in storage but no historical task/event explorer is added here.
- Same-origin browser storage and Web Locks are required for a recoverable mutation. This is not cross-device offline synchronization; current authorization and source witnesses are always enforced server-side.
- No Production compatibility or deployment claim; the parent owns that separate investigation. No denied raw GitHub log/artifact download was attempted.

## Initial 090dae60 validation (local synthetic; superseded by review-fixes evidence)

| Check | Result |
|---|---|
| Node / dependencies | Node 22.23.4, committed lockfile, Next 16.4.2, Vitest 4.1.12 |
| Full unit run | 667 files / 11,633 tests passed; final timezone-display cleanup was made while this long run was in progress, so the focused run below and final build/browser run establish that cleanup |
| Final focused unit / migration / authorization / audit group | 12 files / 125 passed |
| Final PostgreSQL 18.6 | 5 files / 88 passed: follow-up, real reset/restore, migration registration, populated index upgrade concurrency, schema ownership |
| Final built-app HTTP/browser | 3 files / 19 passed: new follow-up HTTP/mobile lost-response persistence, existing planned rebooking HTTP and browser acceptance |
| Production build | Passed (existing dynamic-filesystem tracing warning in migration-files.ts remains) |
| Focused ESLint | No warnings or errors on new routes, follow-up libraries/components and new tests |
| Schema ownership | 0 unexpected differences; 16 inherited open convergence findings retained |
| Diff whitespace | Passed |

Initial test-only corrections: the HTTP assertion used the wrong pre-existing reminder column name; corrected to `reminder_sent_at`. The schema ownership fixture expected 129 application tables; updated to 133 for the four new tables. Their final groups passed without weakening behavior assertions.

Evidence logs and mobile/desktop screenshots are in `evidence/`. Hosted CI remains a separate exact-head gate; no hosted logs/artifacts were downloaded.

Independent review fixes and subsequent validation are documented in [review-fixes/README.md](review-fixes/README.md). The initial table is historical and must not be used as proof for a later head.
