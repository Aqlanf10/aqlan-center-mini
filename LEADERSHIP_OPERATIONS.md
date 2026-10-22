# Leadership operational review, phase 1

This extends the existing `/executive` page. It does not replace Today or change any financial reader, calculation, export, permission or workflow.

## Contract and limits

- Access is the existing `admin` role only. There is no new manager role. Doctors who can read the existing executive financial endpoint do not gain access to this panel or endpoint. Reception, doctor, assistant, cashier and accountant access is unchanged.
- The date selects an **event cohort**: appointments scheduled that day, and internal referral results whose recorded completion timestamp falls on that clinic day. Their **current** state is read now. This is neither a complete backlog nor a reconstruction of historical state. Records without an attributable event date are not claimed to be covered.
- The UI labels its two source filters “Appointments” and “Referrals”. Their underlying action lanes mean existing reception/administration scheduling review or recorded review-doctor/administration result review. They are not assigned case ownership, accepted responsibility, an SLA, a new role, or an access grant.
- Appointment time is the original appointment time, never an invented follow-up deadline. Referral review has no stored deadline. The canonical result-review recipient (`COALESCE(return_to_party_id, doctor_party_id)`) is context, not proof that the doctor accepted follow-up ownership.
- Cancellation remains distinct from no-show. Neither opening the patient link nor an acknowledgement is claimed to resolve the treatment plan. The panel performs no writes and sends no notifications.

## Source authorities and proof

`lib/leadership-operations-db.ts` reads only existing appointments, planned visits, appointment status history, visits, treatment-plan patient identity, referral status, parties and rebooking audit records.

1. Appointments with current `no_show` or `cancelled` status, scheduled on the chosen date. Original status/time/history are retained. Contradictory attendance or inconsistent live links require record review.
2. Internal referrals with `status = completed`, `workflow_state = completed`, a recorded `completed_at` within the selected clinic day and no `returned_at`. The canonical patient referrals tab is the review destination. A recorded return removes the narrow “awaiting result review” signal, not a broader clinical follow-up case.

Rebooking proof uses the existing `planned_visit.rebook` audit, not another later appointment for the patient. Every edge checks the current reset-generation fingerprint, patient, planned-visit identity, old/new appointment identifiers and creation snapshots. Every traversed historical appointment must remain detached in both directions as the canonical writer left it, without contradictory attendance or visit evidence. A terminal replacement with such evidence requires record review. Duplicate same-generation original audit edges stop proof rather than branch. Proof is computed only for the ten displayed cohort rows. It follows at most 31 replacement edges without cycles and requires a coherent current reciprocal planned-visit/appointment endpoint. Duplicate links and cross-patient treatment-plan links require review. Missing rows, exhausted proof, stale generation and ambiguous evidence never imply completion. A current replacement that is itself cancelled/no-show remains visibly distinct from an active replacement. `done` means only that the replacement appointment is recorded as finished, not that the treatment or case is resolved.

The UI uses the existing patient navigation helper for exact patient Summary or Treatment → Referrals links. It does not manufacture a visit identifier or create a new Today surface.

## Read consistency, freshness and pagination

Each source executes one SQL SELECT statement. Its cohort, recursive proof, total, clamped page and result rows share that statement's PostgreSQL MVCC snapshot, including the reset-generation read. Two sources are independent and carry separate database statement timestamps; the endpoint does not pretend they form a global transaction. Concurrent updates can appear only on a later refresh of that source. The PostgreSQL test pauses a SELECT while actual canonical rebooking and another event commit, then proves the count and proof remain internally consistent.

Date-only appointments use their stored clinic date. Referral timestamps use the existing indexed clinic-day helper and explicit configured clinic timezone, including DST behavior. The initial server-selected clinic day is pinned for subsequent pagination and refresh instead of silently advancing at midnight.

Every source uses exact totals and ten-row server pagination. Appointment totals count all selected-day no-show/cancelled records, including documented replacements; they are explicitly not unresolved-case totals. Proof classification never filters a page or changes that cohort count. Pages clamp after cohort shrinkage. A failed source returns unknown count and null freshness, not zero, while a successful other source stays available. Loading, invalid transport, network timeout and expired/revoked sessions do not retain old patient data. The view is explicitly a reading snapshot, not live monitoring. Return-to-tab/focus/reconnection marks it potentially stale and offers refresh. Requests abort on replacement/unmount; late responses are ignored. Account/role changes unmount the whole operational view, and the server revalidates the current account after the source reads.

### Synthetic query sample (not a production capacity claim)

A local PostgreSQL 18 sample added 100,000 unrelated audit events, 10,000 unrelated rebooking-labelled audit rows, and ten selected appointments with six actual canonical rebook operations each. Three full reads took 496–503 ms; `EXPLAIN (ANALYZE, BUFFERS)` reported about 477 ms execution and 7.2 ms planning. All ten rows had correct replacement evidence and the exact cohort total stayed ten. The plan used existing audit action/entity indexes, traversed 60 edges and examined JSON provenance repeatedly. This is bounded-output and depth evidence at the stated synthetic scale, not proof of production-load readiness. There is no new index or migration. The shared database statement timeout remains 60 seconds and the UI stops waiting after 20 seconds; aborting a client fetch does not claim to cancel a database query. No automatic refresh/retry loop accumulates reads.

## UI ownership

The existing Arabic/RTL IBM Plex Arabic, navy/orange clinic identity, borders, rounded surfaces, global focus treatment and natural page scrolling are preserved. There are no new tokens, dialogs, tables, financial controls or global shell changes. One native disclosure explains scope/ownership limits; each optional rebooking proof uses a native disclosure, keeping daily review concise. Native date input behavior is intentional and follows the existing executive date controls. Date/day and role/page state are local to this small embedded panel, as the existing executive period state is; patient information is never persisted to URLs or browser storage.

`components/leadership/LeadershipOperationalOverview.tsx` owns the read-only panel and source cards. `lib/leadership-operations.ts` owns transport, date, navigation and pagination contracts. Existing `lib/roles.ts`, `lib/http-permissions.ts`, `lib/referrals.ts`, `lib/patient-navigation.ts`, `lib/clinic-day-sql.ts` and `lib/planned-visit-rebooking-contract.ts` remain authorities for access, action roles, destinations, dates and audit generation.

### Canonical UI Map (this embedded panel only)

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Date | Native browser/OS picker; application-owned label and ISO value | Existing executive inputs, this panel and clinic-day helpers | Native picker popup and locale; no authored calendar or new tokens | Unit validation, timezone PostgreSQL test, hosted narrow/keyboard journey |

`docs/leadership-operational-ui-audit.json` is an explicit **scoped** product-admin review profile for the executive page and the new leadership component directory only. It records the native date decision already documented here and in DESIGN.md. The same profile and shared ownership contract are used on unchanged baseline source and candidate source; both report zero scoped findings. Its result does not replace the retained default/broad reports or assert whole-application compliance.

## Remaining phases, not delivered here

Durable follow-up cases, explicit owner acceptance/reassignment, due-time policy, contact attempts and clinical outcome evidence, escalation, notifications and a cross-day backlog need separate approved workflow decisions. No schema migration or task table is introduced. No financial work, automatic WhatsApp, AI/Dot capability, or broad patient-file redesign is included.

## Verification

- Focused unit/route/hook/SSR regressions cover permission boundaries, session changes, late responses, timeout, source failure vs known zero, source purity, selected clinic date and canonical patient links.
- Real PostgreSQL 18 tests cover actual and chained rebooking, cancelled/no-show separation, generation and identity mismatches, contradictory records, bounded count/page behavior, exact clinic-midnight cutoff, read purity and concurrent-read consistency.
- The hosted standard security harness includes `__tests__/security-http/leadership-operations-ui-journey.test.ts` for narrow RTL, keyboard/label focus, real source reads, financial-source failure isolation, empty scope, partial source error and 401 clearing. It uses only synthetic fixtures and blocks external browser traffic.
- Browser execution was not permitted locally. The hosted journey is added but is not claimed to have run until hosted CI reports its result. Visual/narrow-browser acceptance remains a release gate.
- The design skills and project `DESIGN.md` were read before implementation. The static design auditor was run in report mode against both app and component directories: the raw broad comparison has 263 baseline findings and 264 candidate findings before applying an ownership profile. The added native-date ownership finding is resolved through the explicit scoped profile and canonical map, not a change to the auditor. All unrelated broad findings remain; this is not a whole-project audit pass. Repository lint/typecheck/tests are separate evidence, not a substitute claim for browser acceptance.
