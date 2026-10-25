# Leadership hub: implementation scope and source ownership

Base: PR #472 commit `b0a0578361a31eb854ed9e64caaa2c5ba41ea080` (tree `6bfc22a0d57669c2a598b05bc97c51fffc44485c`), containing the earlier operational overview. This change is an isolated read-only UI and projection. It does not change those PR branches, business workflows, financial calculation, permissions, schema, Production or Staging.

## Design decision

The owner delegated expert selection and requested professional cards. Use a restrained Fluent-inspired work surface inside the existing application shell: clinic navy structure, a scoped calm teal accent, the existing local IBM Plex Arabic, compact cards with real values and source-specific labels, and original-record drilldowns. This is not a Microsoft product/brand copy, a global rebrand or a new second operating surface.

Three layers: a concise overview, attention lists with evidence, then the canonical working record. No decorative charts, fake comparisons, empty department cards, rainbow status fields or new notifications. The read-only hub never assigns, calls, books, completes, accepts, sends or pays anything.

## UI and transport owners

- `app/executive/page.tsx`: authenticated workspace, local section selection, principal-keyed subtree. Existing privileged-doctor financial access remains separate from admin-only operational access. AppShell is unchanged.
- `components/leadership/LeadershipOverview.tsx`: selected-arrival-day pulse, current all-date lab preview, visible current task priorities and canonical links. Four cards are distinct: waiting visits, all unfinished visits, received-unfitted orders and overdue-at-lab orders. Waiting is explicitly a subset of unfinished, not an independent total to add.
- `components/leadership/LeadershipTeam.tsx`: task detail list and explicitly opened attendance/inventory readers. It does not manufacture a workforce denominator or live doctor presence.
- `components/leadership/ExecutiveFinancialOverview.tsx`: fresh four-view financial presentation with uniform currency cards and progressive detail, without changing formulas, endpoint, CSV, currency grouping or range semantics. Imported only when needed.
- Existing `LeadershipOperationalOverview` / `LabBacklogOverview`: existing full source-specific detail owners with the same reader behavior and newly unified card/control styling; mounted on demand rather than combined into one misleading date filter.
- `components/leadership/useLeadershipRead.ts`: no-store, no polling, timeout/abort, request-key clearing, late-result rejection, explicit unknown/error, manual refresh and stale-on-focus/reconnect. It is scoped to this hub, not a replacement for mutation hooks.
- `lib/leadership-pulse.ts`, `lib/leadership-pulse-db.ts`, `app/api/executive/pulse/route.ts`: strictly decoded admin-only day/tasks readers. One SQL statement per view, exact whole-population totals, stable ten-row page and bounded enrichment. Current authenticated principal is checked before and after the read. No financial readers or schema bootstrap in these projections.
- `leadership.module.css`: scoped semantic layout/accent. Existing global tokens, font, focus styling, icons, PageHeader, native date picker and natural document scrolling remain authorities.

## Source coverage and limitations

| Subject | Verified source and access | Date/scope and evidence | What the hub may say / must not say |
| --- | --- | --- | --- |
| Finance | `GET /api/executive`, `lib/db.ts:executiveKpis`, `lib/executive.ts`; admin or explicitly privileged doctor | Financial range for billing, expenses and cash; receivables through end date; party due source and current inventory indicators retain existing semantics | Currency-specific invoice/accrual, cash movements and debts, never mixed-currency profit or a base-currency substitute. Cash movement is not current drawer balance. No cross-request financial cache. |
| Daily arrivals and unfinished visits | New day view over existing `visits` / `appointments`, same `onClinicDaySql` helper | Arrival-date cohort, current stored state at database statement timestamp; date-only appointment schedule separately | Waiting/called/in-chair/done and original arrival times. Wait is measured at read time, not a staff fault or historical-state reconstruction. Patient Summary link rather than pretending the current Today tab is a historical visit. |
| No-show/cancelled appointment and result review | Existing `/api/executive/operations`, leadership operation contract, admin only | Selected-day event cohort with current state; ten rows and exact cohort totals per independent source | Cancellation stays separate from no-show; documented replacement remains separate from case completion. Review doctor is context, not accepted task ownership. Appointment time is not a follow-up deadline. |
| All-date lab backlog | PR #472 `/api/lab/backlog`, `lib/lab-backlog*`, admin only | All five existing open states, complete counts, twenty-row page, latest tracking event, visible linked open HR tasks | Preparing / with lab / overdue expected arrival / received-unfitted. Distinct patient vs order counts. Assigned task staff, task due and latest event actor stay distinct. No implied patient absence or causal blame; missing received timestamp means unknown age. |
| Task priorities and accountability | New tasks view over `hr_tasks` / latest indexed `hr_task_events`; matches HR admin visibility | Current open shared tasks plus this admin's private tasks; excludes others' private tasks in rows and counts. Exact count then ten-row stable priority page | Real assignee, saved due, latest event actor/action/date and suggested review step. Null due is not overdue. Task completion never proves treatment/fitting. No invented accepted owner or SLA. Existing `/hr?tab=tasks` is a workspace link, not a fake task deep link. |
| Recorded attendance | Lazy `/api/hr/attendance?startDate=…&endDate=…`; admin/reception source, admin hub | Explicit chosen attendance date, recorded state and actual check-in; first ten shown with full returned record count | Recorded attendance, late/incomplete/leave states. It is not a live presence service and cannot support an `18/20 expected` ratio without roster/shift coverage. Do not infer absence from no row. |
| Doctor availability | Existing `/api/appointments/availability`, `doctorAvailabilitySlots`, and `/appointments` UI; admin/reception or own doctor | A selected doctor, date, duration, service, chair, provider blocks and capacity rules | Route user to canonical availability workflow. No eager per-doctor fan-out, no broad online/free/busy inference, no new provider workflow. |
| Waiting for an appointment | `/api/waiting-list` and matching/contact-event authorities | Cross-day waiting/offered requests, distinct from actual waiting-room visits; contact history optional and can be unavailable | Canonical workspace link. Existing API is not paginated and history failures can become empty history, so do not import an unbounded population or claim zero contacts in the overview. |
| Inventory | Lazy `/api/inventory`, canonical `inventoryAlerts` | Current low-stock items, expired batches and soon-expiring batches | Show the three distinct units, not a summed item count. No activation, procurement, custody or stock writes. Existing reader may be expensive, so never poll or include it in first paint. |
| Booking requests / recalls / messages / audit | Existing `/requests`, `/recall`, `/messages`, `/settings/audit` | Existing readers include caps/independent scopes (booking request list caps at 200; audit has its own limit) | Navigation only, not an invented exact global unresolved counter. AppShell's existing badges are not reused as reliable source counts because they can retain stale data / default errors to zero. |

## Loading and failure budget

Overview owns three initial requests only: selected-day pulse, current visible tasks and current lab backlog. Existing AppShell requests are unchanged and excluded from claims about this new budget. Finance, operational cohort, attendance and inventory are not fetched for initial overview. The selected day never filters the lab or task backlog. No new interval, unbounded event fetch, per-row request or per-doctor fan-out. Each source retains its own timestamp and errors; there is no fabricated global atomic snapshot or grand total across overlapping entities.

Source failure is unknown, never zero. Changing date/source or principal hides old values immediately. Focus/reconnect marks potentially stale and does not automatically issue more reads. Clicking a source record is navigation, not resolution. No patient data in URL filter state or browser storage. Default Today uses the server clinic day on each manual refresh, including after midnight. Choosing a date or paging a displayed cohort pins that explicit day; the Today control returns to server-today. The refresh control is explicitly labeled for operations and lab only; tasks have their own refresh. Future arrival timestamps produce unknown waiting age, not zero. A session denial in any new reader clears the whole new hub subtree.

## Deferred, not promised by the current sources

- Unified decision/approval inbox, automatic escalation, accepted/reassigned follow-up ownership and SLA policy.
- Automatic causal attribution of delay to staff, lab or patient; employee scores or disciplinary conclusions.
- Complete current workforce availability, expected attendance denominator and doctor presence.
- Exact lab-order-to-appointment/plan/invoice membership beyond existing verified linkage.
- New contact/reminder/provider workflows, outbound messages, finance writes, export redesign and new AI/Dot features.
- Broad global-shell redesign or whole-application accessibility certification.

## Verification contract

Unit/route tests: transport consistency, permission denial before read, role/account revocation, no-store, null due, temporal scope, no invented historical-visit link, financial integrity reader regressions. PostgreSQL: actual clinic-midnight boundaries, exact pagination beyond 300 tasks, privacy in totals, actor versus assignee, read purity, and a 20,000-task/100,000-event fixture with one statement and bounded enrichment. Hosted synthetic app: desktop and narrow RTL, keyboard, source failure/session clearing, date independence, no writes, first-paint request budget, real screenshots and performance entries. New evidence is uploaded as an explicit synthetic-only artifact, never logs or auth state.

Tests and screenshots are only claimed after their executions succeed. Hosted browser evidence remains a publication/CI gate; local Chromium restrictions are not bypassed.

## Project-local implementation skill

`docs/skills/clinic-leadership/SKILL.md` is the bounded project guide requested for this workspace. It routes source verification, professional RTL presentation, financial/privacy invariants, loading budget and visual acceptance; it does not alter global assistant settings. The fresh finance, laboratory and review presentation applies its shared hierarchy rather than embedding the old financial card/table screen.
