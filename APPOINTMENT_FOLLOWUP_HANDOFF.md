# Appointment follow-up foundation — dormant review candidate

Independent clone: `task-2/appointment-followup`; branch `feat/appointment-followup`, Draft #434.
Base #429: `bc5cae2bed642069dda2326e353fa1d17c3ada40`; #420 rebooking commit `181cab90350c421d40fed24fb92a7c8fa0667b44` is an ancestor.
The doctor-availability checkout, financial writers, booking/merge writers and HR locks are unchanged.

## Current design

- Explicit work for an eligible recorded no_show only. No automatic GET writes or inferred absence from elapsed time. Admin/reception only. Contact does not change attendance, treatment or financial lifecycle.
- Strict structured command: assignee, due time, status, outcome, next step, revision, frozen request key and server-produced identity witnesses. No free text, names, phones, diagnoses or treatment text in task/event/receipt history.
- `appointment_followups` holds immutable original appointment ID + exact six-decimal creation epoch + reset generation. It has no FK to patients, appointments or links.
- `appointment_followup_links` alone has the nullable live appointment/patient FKs (ON DELETE SET NULL), and points to its task. No preserved history table points back to links. The link trigger forbids appointment replacement/rebinding after NULL and forbids recreating a link once an event exists.
- Events and receipts remain append-only with UPDATE/DELETE/nonempty TRUNCATE guards. Actor-scoped keys bind the exact event, fingerprint and revision. Their FKs do not follow patient merges.
- Writer checks generation, exact source timestamp and expected patient against the locked appointment before any receipt access. Existing tasks require their original live link; missing links are never reconstructed from numeric source IDs. Current session/permissions and assignee are checked. Task + link + event + receipt + canonical audit commit atomically.
- Lock order: shared existing reset fence, actor/key, source, task NOWAIT, link NOWAIT, users NOWAIT, patient NOWAIT. Merge's alphabetic FK update can hold links before appointments; NOWAIT fails closed with FOLLOWUP_BUSY and rollback. No merge writer change.
- Canonical merge moves only the live link's patient FK and appointment FK through its existing mechanism. Old displayed-patient attempts reject before replay; changing the witness cannot reuse the same key. Explicitly refreshed context permits subsequent work with a new key.
- Queue is a current-generation backlog, independent of selected-day KPIs. Missing link/source yields source_unavailable_review_required, no patient context, and blocked contact/rebooking. Conflicting attendance yields source_ineligible_review_required and blocked contact, preserving history.
- Shared eligibility reads both attendance-log directions, direct and source-specific planned links, and linked session/item witnesses. It does not scan sibling plan visits. A replacement visit does not rewrite the original absence; ambiguous moved pointers require review.
- No-answer/awaiting-reply stay open with later due work. Rebooking stays under review pending proven #420 linkage. Another missed appointment is separate history.
- Transaction cleanup discards uncertain connections and preserves the original error through rollback/release failures.

## Reset design approved for implementation/testing, not activation

The three history tables are KEEP. Only links are RESET_WIPE. Successful reset wipes links, preserves historical generations, and advances the existing audit-derived generation. Old generations do not appear in active backlog; reused patient/appointment IDs cannot reattach old work or replay old requests.

`lib/clinic-reset.ts` exports the candidate classifications separately. They are deliberately not spread into the active arrays yet: existing preview/reset queries reference every wipe table unconditionally, while this schema is still unregistered. Activating that entry alone would break reset on databases without the table.

The guarded PG suite installs candidate SQL and composes only those classifications via a test-local module mock, then calls the real `resetClinicData`. The reset algorithm and financial history protections are unchanged. No ProtectedFollowupHistoryError, CASCADE, trigger bypass or real reset is introduced.

Authored tests cover canonical reset with nonempty history, link deletion, changed generation, saved/unsaved stale intents with exact reused IDs/timestamps, new-generation work, and reset-audit failure after TRUNCATE rolling back links/history/sources/generation. They also adapt the deterministic real-merge race to the links table, assert merge leaves history unchanged, reject missing/recreated links and verify no retained-history FK targets patients/appointments/links. These tests require execution on this new head; old-schema results do not establish them.

## Proposed bootstrap / manifest touch points — awaiting review

1. Coordinate a numbered migration only after rechecking concurrent work. This clone's latest migration remains `0069_unpaid_currency_transitions.sql`; no number is reserved. The old candidate schema was never registered; do not assume an installed old shape or silently ALTER real databases.
2. Register the agreed DDL through the repository migration/runtime mechanism in `lib/db.ts` in the same reviewed release as spreading the candidate reset classifications into active RESET_WIPE_TABLES/RESET_KEEP_TABLES. Preserve existing reset algorithm and financial refusal guards.
3. Regenerate `schema/current-schema-contract.pg18.json` through `scripts/generate-current-schema-contract.ts` against guarded isolated PG18, and verify migration-chain/runtime ownership parity. Include all four tables, constraints, queue index, source/link/history functions and triggers. Do not rewrite the immutable 0001 baseline manifest or weaken ownership findings to hide drift.
4. Verify `lib/fullBackup.ts` / `lib/productionBackup.ts` and restore staging preserve all four tables, serial sequence positions, generation audit history and constraints/triggers. Verify restore population/trigger ordering does not conflict with the link insert guard. Test old-generation history, missing links, deleted sources and coherent restore identity. No backup/restore file changed here.
5. Add explicit schema readiness/permission/CSRF routing only after schema and PG acceptance; then implement recall editor/queue and a separate leadership backlog view. Browser attempts must survive lost responses and isolate actor/context switches. Opening WhatsApp is not delivery or contact.

## Evidence and limits

AGENTS.md, local Next guide, PG configuration/target guard and canonical reset/merge tests were read. `.agents/skills` is absent from the checkout. No secrets or real patient records were read.

Prior head d5cc1bb had 60 focused unit/audit tests, lint and TypeScript passing on Node 24.15.0. That is not evidence for this schema revision. Current-head check results are recorded in the PR/review delivery, including the exact SHA; Node 22 must be established by hosted CI.

The new PG attempt stopped in global setup because neither TEST_DATABASE_URL nor DATABASE_URL is configured. No PG test/reset executed locally. No target/guard/security change, runtime install, fallback DB or production connection was used. Final-head hosted PG evidence is mandatory.

Remaining activation gates include execution/review of this reset design, controlled clinic-midnight tests, broader merge/reset/session/attendance races, real backup/restore identity, nonempty financial/clinical sentinels, HTTP security and browser retry/actor-switch checks. Unit success is not integration acceptance.

Schema remains unnumbered/unregistered; no API, UI, deployment, merge, WhatsApp send or paid activation. `lib/db.ts` is unchanged. Only dormant follow-up reset classifications were added in `lib/clinic-reset.ts`.
