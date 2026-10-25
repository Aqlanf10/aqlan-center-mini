# Doctor duty suggestions in reception (read-only Slice A)

Base: `d9371706931230584aa6c7c7f9374837bb7fa786`.

This slice connects the existing HR clinical-roster read model to the existing authorized appointment-availability endpoint and quick-appointment picker. It does **not** complete authoritative doctor booking or online slot requests.

## Behavior and boundary

- The picker says **أوقات مقترحة وفق الدوام المسجّل** and **الاقتراح ليس حجزًا مؤكّدًا**. It never claims that confirmation rechecks HR duty.
- Proven weekly/effective-dated duty minus approved full-day leave is projected from yesterday/today into the requested clinic civil date, intersected with existing clinic periods and complete appointment/buffer windows. Existing capacity, chairs, provider blocks and booking-conflict suggestions remain in use.
- Missing or ambiguous mapping/schedule, invalid source rows, unsupported partial leave and unavailable HR schema yield an explicit unknown schedule, not green slots or a known day off. Read failures return an error; malformed or mismatched HTTP success payloads are not accepted as suggestions.
- No source IDs, leave reasons, staff names, salaries or payroll data are exposed. The API returns only the qualified advisory envelope and clock/status/label slots. Unknown returns no slots. Admin/reception/self-doctor authorization is unchanged.
- All suggestions, errors, unknown states and selected-time warnings belong to the exact doctor/date/service/type/duration/chair/new-patient request context. A render-time ownership check hides stale advice before effect cleanup; aborted old responses cannot restore it.
- Selecting a suggestion copies its exact clinic-local clock. No UTC conversion is applied to appointment clocks or WhatsApp text.
- The canonical writer and manual time-entry flow are unchanged. Manual booking is not newly prohibited by unknown/off-duty advice. Existing outside-hours warning and capacity-override policies are unchanged. The API snapshot is not a reservation or admission lock.
- No public request endpoint/form/schema, settings/HR writer, salary/attendance/signed history, follow-up queue/history UI, AI feature or deployment changes. Night periods and cross-midnight appointments are not enabled. Existing civil-day/lock limitations remain.

## Reviewed source reuse

Selected read-only source and tests from #432 at `354cb6f907227a114ad4dad91142dff6c903b02e` were reused without merging its ancestry. `source-provenance.json` records each original/result SHA-256 and the unchanged boundary file hashes. Five source/test files are byte-identical. The reused real-PostgreSQL test adds a before/after snapshot regression covering all HR tables, identities, appointments and audit rows. The independent pure interval proposal was not included.

The API projection is explicitly allowlisted by tests and fingerprinted in the provenance file. The source/read adapter remains internal; its diagnostic reasons and windows are not forwarded to the client.

## Verification

- Unit contracts cover duty periods, weekly days off, leave, unknown identity/schedules, effective boundaries, previous-day night tails, complete duration/buffers, capacity/doctor/block constraints, source immutability, 12:00 WhatsApp formatting, private-data projection, roles and malformed/stale responses.
- Real PostgreSQL tests cover one repeatable-read READ ONLY source snapshot, concurrent source edits without mixed-anchor reads, rollback/connection cleanup, and equality of all HR/source/appointment/audit data before and after repeated projection.
- Built-app HTTP tests use a synthetic duty fixture and retain real existing booking conflicts and role checks.
- `doctor-schedule-suggestions-ui.test.ts` uses the actual built reception page and actual HTTP API, not invented successes. Its stale-response journey delays a fetched real response. It checks unknown versus known day off, manual entry, Close/reopen, and a 12:00 suggestion through real appointment creation to the stored clock and decoded WhatsApp link in UTC and Asia/Aden browser timezones. No WhatsApp message is sent and no reminder delivery is recorded.
- Final executed checks and any unavailable browser/hosted stages are reported with the exact resulting commit. This document alone is not a claim that hosted CI or browser acceptance passed.

## Remaining integration work

Authoritative booking still requires an agreed policy for unknown duty, off-duty/leave overrides, provider applicability, conflicts created by later duty edits, and date-override precedence. It also requires coordinated source-writer/admission locks and real concurrency tests. The public request still has only date/period preferences and remains unconfirmed until reception handles it. Structured doctor/slot preference storage, the older request-confirmation writer and weekly/night clinic settings remain separate work, including migration-number collision review. #452's existing follow-up work and reserved 0070–0072 are not replayed here.
