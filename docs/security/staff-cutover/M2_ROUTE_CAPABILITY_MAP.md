# M2 — route → capability map, for review

Status: **names approved by the owner (Dot 6484846432); routes migrate slice by slice.** This is the first M2 deliverable required by `M1_ENTRY_SLICE_DESIGN.md` §6 ("M2 proposes a per-route capability map for review"). Nothing here grants anything or activates a route.

The machine-checked source is [`M2_ROUTE_CAPABILITY_MAP.json`](M2_ROUTE_CAPABILITY_MAP.json). Its test, `scripts/audits/m2-route-capability-map.test.mjs`, proves three things:
1. Every staff route that `inventory.json` holds for canonical admission has exactly one entry.
2. No entry names a route that no longer exists.
3. Every entry marked `existing` uses only catalogue capabilities.

## 1. Rules

### Entry fields
- **`need`** — every capability listed is required.
- **`anyOf`** — at least one of the listed capabilities is required.
- **`scope`** — the record filter that applies on top of the capability:
  - `patient`: rows limited by the actor's `patientScope`.
  - `appointment`: rows limited by `appointmentScope`.
  - For both, `own` means the actor's validated, active clinician link.
  - A role label never widens a scope.

### Status values
- **`existing`** — uses current catalogue names.
- **`proposed`** — needs a new catalogue name. The list is in §2.
- **`owner-only`** — a protected-owner operation, never a delegable grant.
- **`self`** — acts only on the caller's own data.
- **`entry`** — login, session and logout (done in M1).
- **`excluded`** — AI/Dot, out of scope.
- **`canonical-done`** — already migrated: the procurement route (M3a) and the M2 slices recorded in §5.

### Unchanged business rules that still apply
Cashier shift for money movements, treasury balance rule, signed-visit addenda, capacity override. They are listed in each entry's `note`.

### Counts (383 held routes)

| Status | Routes |
|---|---|
| existing | 315 |
| owner-only | 20 |
| excluded | 12 |
| entry | 4 |
| self | 3 |
| canonical-done | 29 |

| Record scope | Routes |
|---|---|
| patient | 149 |
| appointment | 11 |

## 2. Approved capability names (owner decision, Dot 6484846432)

In the catalogue since policy version 6, with Arabic labels and prerequisites in `lib/staff-capability-catalogue.ts` and `lib/staff-capability-labels.ts`. Catalogue presence grants nothing.

| Group | Proposed capability | Arabic label | Today (legacy roles) |
|---|---|---|---|
| Appointments | `appointments.schedule.manage` | إدارة حجب أوقات الأطباء | admin |
| Visits | `visits.manage` | تسجيل الوصول وإدارة الزيارة | admin, reception, doctor |
| Visits | `visits.delete` | حذف زيارة | admin |
| Clinical | `clinical.ortho.view` | عرض حالات التقويم | admin, reception, doctor |
| Clinical | `clinical.ortho.edit` | توثيق حالات التقويم وخططها | admin, doctor |
| Clinical | `clinical.ceph.analyze` | تحليل السيفالومتري | admin, reception, doctor |
| Clinical | `clinical.prescriptions.write` | كتابة الوصفات وإلغاؤها | admin, doctor |
| Clinical | `clinical.referrals.manage` | الإحالات | admin, reception, doctor |
| Lab | `clinical.lab.view` | عرض أوامر المختبر وأسعاره | admin, reception, doctor |
| Lab | `clinical.lab.order` | طلب وتحديث أعمال المختبر | admin, reception, doctor |
| Lab | `clinical.lab.cancel` | إلغاء أمر مختبر | admin |
| Lab | `clinical.laboratories.manage` | إدارة المختبرات | admin |
| Lab | `finance.lab-prices.edit` | تعديل أسعار المختبر وخدماته | admin |
| Patients | `patients.merge` | دمج ملفين | admin |
| Patients | `patients.number.manage` | تعديل رقم الملف | admin |
| Patients | `patients.documents.delete` | حذف مستند مريض | admin |
| Patients | `patients.history.record` | تسجيل الوثائق التاريخية | admin, reception |
| Patients | `patients.history.correct` | تصحيح وثيقة تاريخية | admin |
| Finance | `finance.patient-ledger.manage` | مسؤولية الدفع وحساب المريض | admin |
| Finance | `finance.legacy.record` | تسجيل المعالجات والأرصدة السابقة | admin, reception |
| Finance | `finance.legacy.void` | إبطال اتفاق سابق | admin |
| Finance | `finance.agreements.manage` | تعديل الاتفاقيات والتسويات | admin |
| Finance | `finance.invoices.correct` | تصحيح فاتورة | admin |
| Finance | `finance.payables.record` | تسجيل مستحق مورد يدوي | admin, reception |
| Finance | `finance.parties.manage` | إدارة الجهات (موردون/مختبرات) | admin |
| Finance | `finance.opening-balances.manage` | الأرصدة الافتتاحية | admin (reception for opening entry) |
| Finance | `finance.fx.manage` | أسعار الصرف | admin |
| Finance | `finance.journal.post` | قيد يدوي | admin |
| Finance | `finance.reconciliation.manage` | اعتماد تسويات المختبر | admin |
| HR | `hr.directory.view` | دليل الموظفين والجداول | admin, reception |
| HR | `hr.attendance.record` | تسجيل الحضور | admin, reception |
| HR | `hr.attendance.correct` | تصحيح الحضور | admin |
| HR | `hr.staff.manage` | ملفات الموظفين والعقود | admin |
| HR | `hr.leaves.request` | طلب الإجازات وعرضها | admin, reception, doctor |
| HR | `hr.leaves.approve` | اعتماد الإجازات والأرصدة | admin |
| HR | `hr.schedules.manage` | إدارة جداول الدوام | admin |
| HR | `hr.payroll.manage` | الرواتب وصرفها | admin |
| HR | `hr.reports.view` | تقارير الموارد البشرية | admin |
| HR | `hr.settings.edit` | إعدادات الموارد البشرية | admin |
| Work | `tasks.use` | المهام (المسندة والمنشأة) | admin, reception, doctor |
| Work | `messages.use` | الرسائل الداخلية والخارجية | admin, reception, doctor |
| Patients | `patients.operational-summary.view` | ملخص المريض التشغيلي (للحجز والتنسيق) | owner decision 1: reception summary |

**Owner-only operations** (never delegable; approved, in `OWNER_ONLY_OPERATIONS`):
- `clinic.data.import`
- `clinic.data.export`
- `clinic.backup.manage`
- `clinic.reset`

`settings.integrations.change` (messaging) is already owner-only.

## 3. Decisions requested

1. Approve, rename or merge the names in §2. Each must also get:
   - its prerequisites, e.g. `clinical.ortho.edit` → `clinical.ortho.view`; `hr.leaves.approve` → `hr.leaves.request`;
   - an Arabic label in `staff-capability-labels.ts`.
2. **Delegated documents after the cutover.** Every account starts with an empty document; the owner keeps every capability. Two options:
   - (a) the owner grants each person in the editor;
   - (b) a reviewed, one-time "starting template per legacy role" that the owner confirms account by account.

   Option (b) is a convenience, never automatic authority. It still needs an explicit owner decision.
3. **Record reassignment** (patient/provider change) stays an authority write until decided (§6).

## 4. Implementation order after approval

Order follows the owner's priorities: crowding, appointments, orthodontics, then finance accuracy.
1. Patient reads (list, profile, timeline, workflow) and visits/waiting list/arrival.
2. Appointments, recall, waiting list, booking requests.
3. Orthodontics, cephalometry, clinical documentation, prescriptions, referrals.
4. Plans and agreements; invoices, payments, shifts, expenses.
5. Lab and laboratories.
6. HR, tasks, messages.
7. Settings, reports, audit.
8. Backup/restore (owner-only, with M4).

Each step has the same parts:
- the canonical branch of each route, with the exact capability in the transaction that protects the write, and the owning snapshot reader for reads;
- grant-projected UI controls;
- registration of the page in the canonical shell;
- PostgreSQL tests (allowed action, adjacent action refused, revocation, scope);
- a built-app journey on an owned database, with an empty DDL log.

## 5. Implemented M2 slices

### Shared mechanism: registered record reads
`lib/canonical-record-reads.ts` holds a closed registry of record reads (keys start with `read:`, so they never collide with operation actions). Each entry has:
- `record`: `patient` or `appointment`;
- `need`: capabilities that are all required;
- `anyOf`: capabilities of which one is required.

The owning RR snapshot reader (`lib/canonical-read-snapshot.ts`) admits a record read in the same snapshot as the authority proof. It refuses with `STAFF_OPERATION_RECORD_SCOPE_DENIED` (HTTP 403) when the actor's scope for that record is `none`. That includes `own` without a validated, active clinician link. The constraint (`all`, or `own` with the clinician party) is passed to the domain read, which filters rows by it. A role label never widens a scope.

### Slice 1 — `GET /api/patients` (search and browse)

**Release-gated.** Which delegated grants see which column group is open owner policy (Dot 6480538845 item 4). The implementation keeps the narrowest technical default. Appointment grants never reveal clinical fields.

| Column group | Fields | Shown when |
|---|---|---|
| identity | id, file number, name, phone, gender, age | admitted (scope not `none`) |
| schedule (operational) | last visit, next appointment | `appointmentScope` is `all` |
| care (clinical) | medical alert, active orthodontics, flags | one of `clinical.plans.view`, `clinical.visits.document`, `clinical.xrays.view` |
| balances | amounts due per currency | `finance.patient-ledger.view` |

The protected owner holds every group.

How the projection behaves:
- **Hidden groups are omitted, not zeroed.** An empty balance list would read as "no debt".
- **Selecting on a hidden group refuses** with `patient_filter_not_granted`, so hidden fields cannot be learned through filters or counts:
  - debt filter → balances;
  - no-next-appointment filter and last-visit sort → schedule;
  - medical-alert, orthodontic and flag filters → care.
- **The patient photo is not published** until `/api/documents/[id]` is canonical.
- **The screen** registers `/patients` as an exact page in the canonical shell. It is visible when the patient scope is not `none`. The list hides filters outside the projection. Rows open the canonical file (slice 2). The create form follows slice 1b.

Evidence: `__tests__/postgres/patients-canonical-directory.test.ts`:
- scope `all`, `own`, owner, `none`, unlinked `own`, admin label;
- identity-only, schedule-only, clinical-only, ledger-only and full projections;
- appointment grants never open clinical fields or filters;
- refused filters and invalid input;
- revocation.

### Slice 1b — `POST /api/patients` (create)
One admitted operation for the exact capability `patients.create`. It is listed in `CLINIC_RUNTIME_ACTIONS` and in the runtime's literal action set. The same transaction holds:
1. the shared patient-import lock, so creation never interleaves with an import;
2. duplicate detection on the current rows;
3. the INSERT;
4. the audit row. An audit failure rolls the patient back.

Rules:
- **Duplicate candidates are other patients' identities.** They are disclosed only to an actor whose current patient scope is `all`. Others get the bounded warning: how many, never who. They can still confirm the creation.
- **The previous-balance step is refused** with `opening_balance_not_canonical` (409, Arabic), not dropped. It waits for `finance.opening-balances.manage` (proposed in §2).
- **Screen:**
  - the create button follows `patients.create`;
  - the previous-balance and family-link steps are not offered;
  - after saving, the list shows a status line instead of opening the profile, which is not canonical yet.

Evidence:
- PostgreSQL, 6 cases:
  - adjacent grant and admin label refused, nothing written;
  - created with its attributed audit row;
  - disclosure by scope, plus confirmation;
  - audit failure rolls the patient back;
  - waits for a running import;
  - revocation (stale session, then refused).
- Built-app journey, 2 cases:
  - HTTP refusals, the previous-balance refusal and validation;
  - mobile browser creation with duplicate confirmation, and the audit trail.

### Slice 2 — `GET /api/patients/[id]` (one patient's file)
- **`read:patients.record`.** In the same snapshot, the patient must exist and be inside the actor's patient scope (`own` uses the list's predicate, without locks). Outside the scope reads exactly like a missing patient: `patient_not_found`, 404, identical body. The response never reveals whether a file exists.
- **Projection:**
  - identity and contact for every admitted actor;
  - care (medical alert, flags, note, referral, recent visits) with a clinical grant;
  - appointments by appointment scope: `all` lists every appointment, `own` only the actor's, `none` omits the key.
- **Not yet canonical:** the bounded `?projection=` mode refuses (409 `projection_not_canonical`).
- **Screen:** `/patients/[id]` is a pattern-matched canonical page, not in the menu. A canonical session gets `CanonicalPatientProfile`: one read, only the projected sections. It never calls the legacy panels. Every other section appears there only when its route is migrated.
- **Evidence:**
  - PostgreSQL, 5 cases: own clinician file with own appointments only; outside equals missing; appointment grants never reveal clinical fields; no appointment scope; scope `none`, a stale session, and the owner.
  - Built-app journeys: HTTP, plus a mobile browser opening the file from the list. Only `/api/patients` and `/api/patients/:id` are called; an out-of-scope file shows the Arabic refusal.

### Slice 3 — clinical sub-reads and the timeline
- **`medical-history`, `vitals`, `problems` (GET)** use `read:patients.clinical`: a clinical grant plus the patient inside the scope. An actor without a clinical grant is refused at admission (403) before the patient is looked up, so existence never leaks either way.
- **`timeline` (GET)** uses `read:patients.record`. Events are filtered by group:
  - clinical events: care group;
  - appointment events: schedule group;
  - invoice and payment events: balances group.

  A hidden group's events are omitted entirely. The legacy path masks amounts but shows the events; the canonical path does not reveal that they exist.
- **Screen:** the canonical profile shows medical alerts and review state, latest vitals, the problem list and the timeline, each only when its group is projected.

### Slice 4 — diagnoses, intake history, referrals, contact consents
- **`diagnoses`, `intake-history`, `referrals` (GET)** use `read:patients.clinical`. The diagnoses `orthoCaseId` filter is validated in the canonical branch.
- **`contact` (GET)** uses `read:patients.record`: consent mode, per-channel state and history for anyone admitted to the record. Whether recording is offered follows `patients.edit`, the write's capability, never a role label.
- **Screen:** the profile shows the consent state for everyone, and referrals inside the clinical panels.
- **Not yet migrated:** `family` (GET), because its view is built from the legacy session.

### Slice 5 — arrival panel (`GET /api/patients/[id]/arrival-panel`)
Admitted by `read:patients.record`. One snapshot: `arrivalPanelWith` reads every source (balances, previous balances and arrangements, plans, cases, orthodontics) through the owning facade. The legacy path passes its unchanged standalone readers.

| Group | Contents | Shown when |
|---|---|---|
| visit | today's active visit | every actor admitted to the record |
| appointments | today's appointments | appointment scope: `all` lists all, `own` only the actor's, `none` removes the key |
| care | cases and orthodontic status | clinical grant |
| balances | money lines and suggestions | `finance.patient-ledger.view` |

- `canCollect` requires both balances and `finance.payments.collect`. The collect route proves it again, with its open-shift rule.
- A role label (cashier, reception) decides nothing.
- Groups the actor cannot see are not read at all.

### Slice 6 — workflow summary (`GET /api/patients/[id]/workflow`)
Admitted by `read:patients.record`. `patientWorkflowWith` reads every source through the owning facade: plans, planned visits, the ledger (`patientLedgerInSnapshot`) and case rows. The legacy path passes its standalone readers unchanged.

| Group | Contents | Shown when |
|---|---|---|
| identity | basic patient fields, open visit | every admitted actor |
| schedule | next appointment | `appointmentScope` is `all` |
| care | medical alert, last visit, plans without money fields, planned visits, counts, cases, clinical alerts | clinical grant |
| balances | financial summary, plan money fields, overdue-installment alerts | `finance.patient-ledger.view` |

- **Authority setting:** `workflow.doctor_financial_view` does not widen canonical visibility; grants decide.
- **Rebooking:** not offered until its own route is canonical.

### Slice 7 — clinic settings (`/api/settings` GET, PATCH, POST reset; owner decision 5)
- **Read:** one owning snapshot admitted by `settings.view`. The same payload as legacy (a secret's value is never returned), plus `__canWrite`: the keys this account may change, from the same snapshot.
- **Write:** one admitted transaction per batch (`lib/canonical-settings.ts`):
  - admission by `settings.view`, the catalogue prerequisite of every settings write;
  - then every key's requirement is proved through the same handle before anything is written: `settings.operational.edit`, `settings.finance.edit`, or the owner-only `settings.security.change`, `settings.integrations.change`, `clinic.backup.manage`;
  - a refused key refuses the whole batch and names the key (`setting_not_granted`, 403);
  - the expected-version CAS (`setting_conflict`, 409), the in-transaction prefix rule, the writes, and one audit row per changed key with the canonical actor all commit together. An audit failure leaves no setting change (PG test).
- **Screen:** `/settings` is registered for `settings.view`. Each key is editable only if `__canWrite` lists it; owner-only keys show «للمالك فقط» to delegates; areas not yet canonical (history, users, backup run, announcements, specialised screens) are not linked.
- **Tests:** PG `settings-canonical` (14), built journey `canonical-settings-journey` (HTTP and browser).

### Slice 8 — patient edit (`PATCH /api/patients/[id]`) and contact consent (`POST /api/patients/[id]/contact`)
One admitted `patients.edit` transaction each (`lib/canonical-patient-writes.ts`). `patients.edit` is in `CLINIC_RUNTIME_ACTIONS` and the runtime's literal action set.
- **Record:** the patient is locked (`FOR UPDATE`) inside the actor's current scope. Outside the scope reads exactly like a missing patient (`patient_not_found`, 404, identical body).
- **Field groups follow the read projection.** Nobody writes what it cannot see:

| Group | Fields | Needs, besides `patients.edit` |
|---|---|---|
| identity | name, phones, gender, birth year and date, address, guardian, national ID, email, preferred channel | nothing |
| care | medical alert, note, referral source, referred by | a clinical grant |
| flags | coordination flags (values from `patients.flags`) | a clinical grant or `patients.operational-summary.view` |

- A field outside the actor's groups refuses the whole request and names it (`patient_field_not_granted`, 403); unknown fields and empty requests refuse (400). Validation is the creation rule on the merged record.
- **Only sent fields are written**, so two concurrent edits of different fields both survive. The audit row (canonical actor) commits with the change; an audit failure leaves no change. The response is the read projection of the written record.
- **Consent:** channel, state, source and note are validated; the consent row and its audit row commit together; `recordedBy` is the canonical actor.
- **Screen:** the canonical profile offers «تعديل البيانات» (changed fields only; care fields only when the care group is projected) and «تسجيل الموافقة» when the session holds `patients.edit`.
- **Tests:** PG `patients-canonical-writes` (11): field groups, scope (outside equals missing), admission refusals, revocation, concurrency, audit rollback, consent. Built journey `canonical-patient-writes-journey`.

### Slice 11 — Today queue (`GET /api/visits`) and arrival (`POST /api/visits`)
The crowding screen first. Read: the record read `read:visits.today`, one owning snapshot (`listTodayVisitsWith`). Write: one admitted `visits.manage` transaction (`lib/canonical-visits.ts`); `visits.manage` joins `CLINIC_RUNTIME_ACTIONS`.

| Group | Contents | Shown when |
|---|---|---|
| identity | name, phone, status, chair, arrival/call/seat/finish times, appointment and doctor links | every actor admitted to the queue |
| operational | the arrival note (a planned visit's note carries its clinical title) | a clinical grant or `patients.operational-summary.view` |

- **Rows follow the current patient scope.** `all`: every visit of the clinic day. `own`: visits assigned to the actor's clinician party and visits of its patients (the patient list's condition). A role label never widens it.
- **Arrival:** a file must be inside the actor's scope (outside answers exactly like a missing file, 404); a walk-in without a file needs no record. An `own`-scope actor opens visits on its own clinician party only (default when none is sent; another doctor is refused, 403 `visit_doctor_not_allowed`). An `all`-scope actor may name an active doctor only. One active visit per patient per day (409 `visit_already_active`, naming the visit). The audit row commits with the visit.
- **Planned-visit start:** locks the planned row, checks its patient against the scope before any write, then starts the visit and moves the booked appointment to arrived in the same transaction. The legacy refusals are unchanged (`startVisitFromPlannedVisitWith`, shared with the legacy route).
- **Not yet canonical:** the reception hand-off view (`?view=reception-handoff`, 409 `view_not_canonical`); call, seat, finish and the other queue actions (`PATCH /api/visits/[id]`, next slice).
- **Screen:** `/visits` («قائمة اليوم») is registered for an account with a patient scope: summary, waiting list by longest wait (thresholds from settings), chairs, and the arrival form with a file search when `visits.manage` is held. It polls every 20 seconds and calls only `/api/visits` and `/api/patients`.
- **Tests:** PG `visits-canonical-queue` (11); legacy PG files using the refactored writers (54 files, 703 tests); built journey `canonical-today-queue-journey` (3).

### Slice 12 — queue moves (`PATCH /api/visits/[id]`: call, call again, seat, return, finish, clear)
One admitted `visits.manage` transaction per move (`commandCanonicalVisitMove`). The domain bodies are shared with the legacy route (`gatedVisitMoveWith`, `callVisitAgainWith`, `returnVisitToWaitingWith`, `finishVisitWith`, `clearVisitWith`); the legacy behaviour is unchanged.
- **Lock order** as the legacy path: the chair-day advisory lock (call and seat), then the visit row `FOR UPDATE`, inside the shared lifecycle fence taken at admission.
- **Scope after the row lock:** `all`, or `own` when the visit is assigned to the actor's clinician party or its patient is one of the clinician's patients (the queue read's condition). A missing visit and one outside the scope answer identically (404 `visit_not_found`), for every move including call and seat.
- **Readiness gate unchanged:** `ops.require_clearance_before_call` refuses a call without clearance (409 `clearance_required`); an emergency needs a written reason (`emergency_reason_required`) and its bypass is audited in the same transaction. `clear` (the readiness acknowledgement) needs `visits.manage`; the legacy role list (admin, reception, doctor) is not carried over.
- Every move writes its audit row with the canonical actor in the same transaction; a refused audit leaves the visit unchanged. Two concurrent calls to one chair: exactly one wins.
- **Not canonical yet (409 `visit_action_not_canonical`):** `defer` (a money decision, `finance.payments.collect`), `link` and `open_file` (patient-file slices). The route entry stays `existing` until they move.
- **Screen:** the canonical queue offers «نداء إلى كرسي N» and «إجلاس» on waiting rows (first free chair), «جلس», «إعادة النداء» and «لم يحضر — للانتظار» on a called chair, «انتهى» on an occupied chair; call and seat go through the readiness gate with the written emergency reason.
- **Tests:** PG `visits-canonical-moves` (6): the whole journey with audit, own scope (outside equals missing, call included), admission and revocation, concurrent calls to one chair, the gate and emergency bypass, audit rollback; legacy PG files for the moved functions (8 files, 57). Built journey `canonical-today-queue-journey` now 5.

### Slice 13 — chair readiness (`GET /api/visits/readiness`)
Read only: the record read `read:visits.readiness`, one owning snapshot (`readCanonicalChairReadiness`; `listTodayVisitReadinessFactsWith`, `patientVisitReadinessFactsWith`, `chairReadinessSettingsWith`, balances from `computeDebtRowsInSnapshot`).

| Group | Contents | Shown when |
|---|---|---|
| identity | visit, status, chair, times, clearance (who and when) | every actor admitted to the queue |
| care | the whole checklist, alert texts, history alerts, the editable alert | a clinical grant |
| operational | the checklist without the medical-history item; the alert item as existence only («تنبيه طبي مسجَّل — راجعه مع الطبيب قبل الكرسي»); flags; today's intake form | `patients.operational-summary.view` (owner decision 1) |
| balances | due lines per currency (warning thresholds from settings) and the stepper's «paid» step | `finance.patient-ledger.view` |

- **Rows** are the queue read's; `?patientId=` needs the patient inside the scope (outside answers exactly like a missing file, 404) and returns its visit with the stepper.
- Hidden groups are omitted, never replaced by neutral values (no empty balance list that would read as «no debt»).
- **Screen:** each waiting row of `/visits` shows the projected checklist and dues, and «أقِرّ الجاهزية» (the slice 12 `clear` move) when `visits.manage` is held; the readiness read failing never hides the queue.
- **Tests:** PG `visits-canonical-readiness` (7): the four groups (no alert text or medical history in the operational payload), own scope and the patient mode (outside equals missing), the stepper with and without the ledger grant, a canonical clearance shown on the next read. Built journey `canonical-today-queue-journey` now 6.

### Slice 14 — waiting list (`/api/waiting-list` GET, POST; `/api/waiting-list/[id]` GET, PATCH)
Step 2 of the order (appointments, recall, waiting list). A scheduling record, so the **appointment scope** decides, with the meaning it has for appointments (slice 2): `all` lists every entry; `own` lists the entries assigned to the actor's clinician party. The legacy doctor view also listed unassigned entries and other doctors' entries for its patients; the canonical `own` scope does not. `appointments.edit` joins `CLINIC_RUNTIME_ACTIONS`; the runtime gains `staffOperationAppointmentScope`.
- **Reads:** the record read `read:waiting-list`, one owning snapshot: entries, stale marks from `scheduling.waiting_list_hold_days`, and the contact history, all from the same snapshot. An entry outside the scope answers exactly like a missing one (404). `canEdit` = `appointments.edit` (display only).
- **Writes:** one admitted `appointments.edit` transaction each: add, offer, contact, preferences, cancel, expire. The entry row is locked first, then checked against the scope. The audit row is written in the same transaction: the legacy path keeps its best-effort audit after the write, the canonical path makes it atomic (`*With` writers take an audit callback, `WaitingAudit`).
- **References:** an `own`-scope actor adds entries only for its own patients (the patient list's condition), assigned to its own clinician party by default; another doctor, or clearing the doctor, is refused (403 `waiting_doctor_not_allowed`), so an entry never leaves the scope of the actor who wrote it. A named doctor must be active and a named service must exist (400), instead of a foreign-key error.
- **Not canonical yet (409 `waiting_action_not_canonical`):** the free-slot matching mode of the list (`date`/`time`/… parameters) and `book`. Both go through the appointment engine and move with the appointment routes. `booked` refuses as before (400).
- **Screen:** `/waiting-list` is registered for an account with an appointment scope. It reuses the existing page, which only calls these routes. Write controls follow `canEdit`; the appointments screen is not linked for canonical sessions.
- **Screen fix:** the row's action buttons kept their intrinsic width (`shrink-0`) and pushed «إغلاق» off a 390px screen; they now wrap (`max-w-full`), for legacy sessions too.
- **Tests:** PG `waiting-list-canonical` (7): add with atomic audit, duplicate need, inactive doctor and unknown service, own scope (outside equals missing, own party only), appointment scope rather than patient scope, contact → preferences → cancel with audit, own-scope moves outside equal missing, book/booked refusals, audit rollback, revocation. Legacy waiting-list PG files (6, 29 tests) and HTTP files (7) unchanged and passing. Built journey `canonical-waiting-list-journey` (2): HTTP scope and refusals, mobile browser call recording without horizontal scroll, viewer without write controls.

### Slice 15 — appointment day list (`GET /api/appointments?date=`) and personal schedule (`GET /api/appointments/mine`)
Read only. Record reads `read:appointments.day` and `read:appointments.mine`, one owning snapshot each (`listAppointmentsByDateWith`, `labWorkForPatientsWith`, `readDoctorDailyScheduleWith`).

| Group | Contents | Shown when |
|---|---|---|
| identity | the appointment as the schedule shows it (patient name and phone, time, service, doctor, status, lifecycle stamps, booking note) | every actor admitted to the day |
| operational | lab readiness («has the work arrived?», no cost or price), computed after the row filter | a clinical grant or `patients.operational-summary.view` |

- **Rows:** appointment scope `all` lists the whole day; `own` lists the appointments assigned to the actor's clinician party, the meaning it has in slice 2. The legacy doctor view also listed unassigned appointments and other doctors' appointments of its patients; the canonical `own` scope does not. A patient scope alone does not open the schedule.
- **Personal schedule:** the actor's own validated clinician party only (`clinician_link_required`, 403 otherwise), never a client-selected doctor. The file link is offered only when the patient is inside the actor's current patient scope; otherwise it is `null`, not an error.
- **Screen:** `/appointments` («المواعيد») is registered for an account with an appointment scope: a read-only day view (previous/next day, lab readiness chips), with the existing «جدول مواعيدي» card (it calls only `/api/appointments/mine`) for an `own`-scope clinician. A route layout (`app/appointments/layout.tsx`) renders the canonical view for a canonical session, so the legacy page is never mounted for it; the legacy page itself is unchanged. Booking, rescheduling and cancelling are the next slices.
- **Tests:** PG `appointments-canonical-day` (5): all versus own rows, lab readiness only with the summary, patient scope alone refused, invalid dates, the personal schedule and its file link by patient scope, no clinician link refused. Built journey `canonical-appointments-journey` (3).

### Slice 16 — booking (`POST /api/appointments`)
One admitted `appointments.create` transaction through **the same capacity engine** (`commandCanonicalBooking` → `bookAppointment(..., { client, audit })`). `writeAppointmentInDay` gains an optional caller transaction: with it, the day locks, the judgement and the insert run on the admitted transaction and the writer neither begins, commits nor rolls back; without it nothing changes. `appointments.create` joins `CLINIC_RUNTIME_ACTIONS`.
- **Atomic audit:** the booking, its `appointment.create` row and any `appointment.capacity_override` row commit or roll back together (the legacy route writes no creation row and its override row after the commit; both unchanged).
- **Patient:** appointment scope `all` books any patient; `own` books only the clinician's own patients (the patient list's condition), so a booking never pulls a new patient into the clinician's scope. Outside answers like a missing patient (404).
- **Doctor:** `own` books on its own clinician party only (default); another doctor is refused (403 `booking_doctor_not_allowed`), and a return booking whose case clinician is someone else rolls back.
- **Capacity override:** only with `appointments.override-capacity`. The engine receives the display label `canonical`, so neither the legacy admin override nor the doctor self-assignment by role ever applies.
- **Refusals:** every engine refusal rolls the transaction back and answers as the legacy route does: 400 with the engine's code (for example `return_booking_context_required`), or 409 with the conflict (reasons, suggestion, `canOverride`, and the nearby-appointment confirmation token).
- **Screen:** the canonical day view offers «حجز موعد» to `appointments.create`: the patient from the canonical search, time, duration and note; a full chair shows its reasons and suggestion; the override reason field appears only with the override grant; the nearby-appointment confirmation is a second, explicit click. Return bookings, rescheduling and cancelling are later slices.
- **Tests:** PG `appointments-canonical-booking` (7): creation audit, a role label never overrides capacity, override with atomic audit, engine refusals with codes, two concurrent bookings for the last chair, own scope (outside equals missing, own party only), admission and revocation, audit rollback. Built journey `canonical-appointments-journey` now 5 (mobile booking with a full-chair refusal shown, then a successful booking with its audit).

### Slice 17 — appointment moves (`PATCH /api/appointments/[id]`)
One admitted `appointments.edit` transaction per move (`commandCanonicalAppointmentMove`). The branch capability is checked inside it: `arrive`, `close_done` and `close_no_show` need `visits.manage`; `cancel` and `no_show` need `appointments.cancel`; `reminded` needs nothing more.
- **Order:** the appointment row is locked (`FOR UPDATE`) and then checked against the CURRENT appointment scope: `all` any appointment, `own` only the appointments assigned to the clinician party; a missing appointment and one outside the scope answer identically (404). Arrival then takes the patient-day lock, as the legacy writer does.
- **Writers:** the same domain writers on the admitted transaction: `arriveAppointmentWith` (the legacy `arriveAppointment` wraps it and rolls back every `false`), `transitionAppointmentInTransaction` (status log, referral release, no-show and past-booking admission unchanged) and `recordManualAppointmentReminder(..., client)`. The cancellation reason rule and its legacy default are kept.
- **Audit:** an `appointment.update` row (move, from, to, reason) with the canonical actor commits with the move; any refusal rolls everything back.
- **Freed slot and deletion:** slice 19 (`waiting` after a cancel or no-show; `DELETE`). Rescheduling is slice 18.
- **Screen:** the canonical day view shows «وصل» (visits.manage), «لم يحضر» and «إلغاء الموعد» with a reason (appointments.cancel) on booked rows, only with `appointments.edit`; a refused move shows the server's Arabic message.
- **Tests:** PG `appointments-canonical-moves` (8): arrival with its queue row, status log and audit; double arrival conflict; cancel with and without a reason; no-show only after the time and close only for past bookings; reminder snapshot (stale and malformed); reschedule not canonical; own scope (outside equals missing, unassigned excluded); per-branch capability, missing `appointments.edit`, no appointment scope and a stale session; audit failure rolls the arrival back. Built journey `canonical-appointments-journey` now 7 (HTTP refusal, own-scope 404 parity; mobile arrival and cancellation with a reason, audited).

### Slice 18 — rescheduling (`PATCH /api/appointments/[id]`, `action: "reschedule"`)
One admitted `appointments.edit` transaction through **the same cross-day capacity engine** (`commandCanonicalReschedule` → `rescheduleAppointment(..., { client, audit })` → `writeAppointmentAcrossDays({ client })`). With the caller's client the writer takes the sorted day locks, judges and moves on the admitted transaction and neither begins, commits nor rolls back; without it nothing changes.
- **Order:** the appointment is read without a row lock and checked against the CURRENT appointment scope (`own`: assigned to the clinician party; missing and outside answer identically, 404). The engine then takes the day locks and the row lock (legacy order); its guarded UPDATE keeps the read status, date, time and doctor, so a concurrent change between the read and the write is refused (409), never overwritten.
- **Doctor:** `own` cannot move the appointment to another doctor (403); a responsibility transfer that lands on someone else rolls back. A doctor change without the return-booking context keeps the engine's `return_booking_context_required`.
- **Capacity override:** only with `appointments.override-capacity`; the engine receives the display label `canonical`. The `appointment.reschedule` and `appointment.capacity_override` rows commit with the move (the legacy path keeps its post-commit best-effort rows).
- **Responses:** as the legacy route: `{ ok, appointment, warning }`; 409 `{ message, conflict }` for capacity; 400 or 409 with the engine code otherwise.
- **Screen:** «نقل الموعد» on booked rows with `appointments.edit`: new date, time and a required reason; a full chair shows its reasons and suggestion; the override reason only with the grant; the nearby-appointment confirmation is a second, explicit click.
- **Tests:** PG `appointments-canonical-reschedule` (8): move with atomic audit and the old reminder cleared; engine refusals with codes; full chair, role label never overrides, override grant audited; two concurrent reschedules (one wins, the stale read refused); only booked moves; own scope (outside equals missing, own party only); admission and revocation; audit failure leaves the appointment in place. Built journey `canonical-appointments-journey` now 8 (mobile reschedule with a full-chair refusal shown, then the audited move).

### Slice 19 — deletion (`DELETE /api/appointments/[id]`) and the freed-slot match
- **Deletion:** one admitted `appointments.cancel` transaction (`appointments.cancel` joins `CLINIC_RUNTIME_ACTIONS`; readiness pin updated). The row is locked, then checked against the CURRENT appointment scope (outside = missing, 404); an arrived appointment refuses (409, it became a visit). The same writer (`deleteAppointmentWith`, the legacy `deleteAppointment` wraps it unchanged) releases a booked referral, unlinks a visit and deletes the row; the `appointment.delete` audit row (the row's snapshot and the reason) commits with it. The reason is optional (an empty body means none; only an oversized body refuses). The legacy route stays admin-only; the canonical path is the grant plus the scope.
- **Freed-slot match:** `readCanonicalFreedSlotCandidates`, one `read:waiting-list` snapshot: the slot's service, doctor and duration are completed only from appointments inside the actor's appointment scope (`resolveFreedSlotFrom` with scoped readers; an appointment outside is treated as absent); the candidates are the open entries inside the scope, ranked by the same pure `rankFreedSlot` the legacy matcher now uses; shifts from `loadCapacityContextWith`. Used by `GET /api/waiting-list?date=&time=` (legacy response shape) and, best effort after the commit, by the cancel/no-show/past-no-show moves (`waiting: { count, slot }`, no names).
- **Screen:** after a cancel or no-show the day view shows how many waiting entries fit the freed slot, «اعرض المرشّحين» (names and reasons from the canonical match) and a link to the waiting list; «حذف نهائي (إدخال خاطئ)» sits in the cancel panel for `appointments.cancel`.
- **Tests:** PG `appointments-canonical-delete-freed` (8): legacy/canonical ranking parity for `all`, own entries only for `own`, slot facts only from appointments in scope, the cancel's `waiting` summary, patient scope alone refused; deletion with snapshot audit and visit unlink, arrived refused, second delete missing, own scope parity, capability (an admin label without the grant refused), scope and revocation, audit failure leaves the row. Built journeys: `canonical-appointments-journey` now 10 (HTTP delete refusals and 404 parity; mobile cancel → freed-slot candidates → mistaken entry deleted and audited); `canonical-waiting-list-journey` checks the slot mode (200, own entries only).

### Slice 20 — booking from the waiting list (`PATCH /api/waiting-list/[id]`, `action: "book"`)
The legacy door claims the entry, books, then marks it booked in three transactions (with recovery for a crash between them). The canonical door (`commandCanonicalWaitingBook`) does all of it in **one** admitted `appointments.edit` transaction, plus the branch's `appointments.create`:
1. the entry row is locked (`FOR UPDATE`), before the engine's day locks (the order the legacy claim already uses), then checked against the CURRENT appointment scope (outside = missing, 404);
2. an entry already booked answers its appointment (`alreadyBooked`, no second one); a closed entry refuses (409); a live legacy claim (< 2 minutes) refuses (409), so the two doors never book one entry twice during the cutover;
3. recovery: an appointment already carrying the entry's id is linked, never doubled;
4. the booking goes through `bookAppointment(..., { client, audit })` with `waitingListId`; `own` books on its own party only; override only with `appointments.override-capacity`;
5. `markWaitingBookedWith` closes the entry in the same transaction; `appointment.create`, any `appointment.capacity_override` and `waiting_list.book` rows are atomic. Any refusal rolls everything back — no claim is ever left behind.
- **Writers:** `findAppointmentForWaitingWith` and `markWaitingBookedWith` (the legacy functions wrap them unchanged; the legacy `waiting_list.book` row stays best effort).
- **Screen:** «احجز له» on each freed-slot candidate in the canonical day view (with `appointments.create`); a conflict shows its reasons.
- **Tests:** PG `appointments-canonical-waiting-book` (9): book + link + close with every audit row and the idempotent second press; a full chair leaves no appointment and no claim, override audited; recovery linking; closed entry and live legacy claim refused (an expired claim books); two concurrent presses → one appointment; input validation; own scope (outside equals missing, own party only); capability, scope and revocation; audit failure leaves the entry open. `waiting-list-canonical` updated (book is its own command). Built journeys: `canonical-appointments-journey` books a candidate from the freed slot (audit and link checked); `canonical-waiting-list-journey` checks that book without `appointments.create` refuses (403).

### Slice 21 — online booking requests (`GET /api/booking-requests`, `PATCH /api/booking-requests/[id]`)
The queue holds people who are not patients yet (name and phone), so on the canonical path it opens only to `appointments.create` with the **whole** appointment scope; an `own`-scope clinician neither reads nor handles it (the confirmed appointment would land outside its scope). Navigation gains `wholeScope` for such pages; `/requests` («طلبات الحجز») is registered with it.
- **Read:** the record read `read:booking-requests` (need `appointments.create`), one owning snapshot (`listBookingRequestsWith`).
- **Confirm:** one admitted `appointments.create` transaction running **the same door** — the confirmation logic moved verbatim from the route into `lib/booking-request-confirm.ts` and is called by both branches (the single-door guard now pins that file and requires it to judge, check the override and record it). On the canonical path the day locks, the request row lock, the judgement and `confirmBookingRequest` run on the admitted client. Decisions to review: a request whose phone matches no patient creates a patient file, so it also needs `patients.create` (403 `patient_create_required` otherwise); the override needs `appointments.override-capacity` (the engine receives the label `canonical`). `appointment.create`, `booking_request.confirm` (new audit actions) and any override rows are atomic; any refusal rolls back (the request stays new and no patient is created).
- **Reject:** one admitted `appointments.cancel` transaction (`rejectBookingRequestWith`), `booking_request.reject` audited; booking grants never reject.
- **Tests:** PG `appointments-canonical-booking-requests` (7): queue scope and capability; confirmation of a new person (patient, appointment, request, audit rows) and the second press; patients.create needed only for a new person; full chair, role label never overrides, override audited; two concurrent confirmations → one appointment; own scope, grant, revocation and audit-failure rollback; rejection by grant with audit and the handled refusal. Built journey `canonical-booking-requests-journey` (2): HTTP refusals in Arabic, then the desk opens «طلبات الحجز» from the shell on a phone-width screen, confirms one request and closes another, both audited.

### Single-snapshot guard
Every canonical patient reader, run as the owner (every source read), must take exactly one pool lease and send zero direct pool queries. The test is in `patients-canonical-directory`. It caught `patientTimelineWith` reading internal-referral events through `getPool()` (fixed in 7def211b), and it fails if that call is restored.

## 7. Owner decisions (Dot 6484846432) and their translation

1. **Reception operational summary.**
   - **Capability:** `patients.operational-summary.view`, an independent, revocable grant. It neither needs nor grants clinical capabilities.
   - **Shows only:**
     - whether an orthodontic case is active;
     - whether a medical alert exists (`hasMedicalAlert`, never its text);
     - the coordination flags.
   - **Applied in:** the list, the file, the workflow summary and the arrival panel.
   - **Leak tests:**
     - search never matches the alert text (search fields: name, file number, phones, guardian, national ID);
     - the alert and orthodontic filters select on existence only;
     - no clinical timeline events;
     - the bounded `?projection=` and export modes are not canonical yet.
   - **Interpretation to confirm:** "the alert needed for booking" is taken as the alert's existence. A short coordination text would need its own field, not the medical text.
2. **The 41 names and the four owner-only operations** are in the catalogue (policy version 6). The limited delegable exports are `reports.export` and `finance.export`; the full clinic export is the owner-only `clinic.data.export`. No proposal beyond these, such as `supplier-intent.recover`, is included.
3. **Starting templates per type of work** (`lib/staff-starting-templates.ts`): reception, cashier, accountant, doctor (own/own), lab coordinator, inventory keeper.
   - A template only fills the editor form, limited to what the editor may delegate; the dropped items are listed. Nothing is saved until the normal atomic, audited save of that one account.
   - There is no automatic legacy-role conversion and no template is applied by a role label.
   - Templates use catalogue names only, are closed under prerequisites and hold no owner-only operation (unit tests).
   - No assistant template: the legacy "today's visits" scope has no canonical record scope yet (owner decision pending).
   - Built journey: applying a template changes nothing on the server until saved.
3b. **Initial owner confirmation** (Dot 6494187100 item 2). The capability document is schema version 2 and carries `confirmation`:
   - `pending`: the document grants nothing and both record scopes are `none`, however well-formed its grants are. Every document that has not been confirmed by the owner (imported, converted, prepared from a template) is pending. Version 1 documents are refused (fail closed).
   - `owner`: the owner has confirmed the account. Only the owner moves an account from pending to owner; the owner's save, after the change preview, is the confirmation. Every save results in `owner`; nobody saves an account back to pending.
   - A delegated editor can neither edit nor confirm a pending account (`initial-owner-confirmation-required`, 403), including revocation-only saves. Its later maintenance of a confirmed account stays within the authority the owner gave it.
   - The confirmation is part of the revocation fingerprint, so a confirmation ends the account's existing sessions. The audit row records `confirmation: [before, after]` and `confirmedByThisSave`.
   - Applying a template never confirms anything; the account stays pending until the owner saves it.
   - The editor shows an atomic change preview before every save: capabilities added and removed, scope changes, modules hidden or shown, and the confirmation.
   - Tests: unit (parser, effectiveness, delegate refusal); PG `staff-capability-editor` (pending, delegate refusal, owner confirmation, later delegated maintenance); built journey `canonical-confirmation-journey`.
4. **Modules** (`lib/staff-modules.ts`): 14 modules; every capability belongs to exactly one (unit test).
   - Hiding a module revokes all of its capabilities in one atomic save. The server then refuses its routes from the account's current grants (built journey).
   - Revocation during a session: the old session is refused (stale permission revision), and a new session has no grant.
   - Revocation during a pending request is serialized: the admitted write holds its proof rows `FOR SHARE`, so the revocation waits for it; afterwards the old session is refused (PG test in `settings-canonical`).
   - The protected owner is never a target of these grants: the owner cannot be locked out.
   - Restricted doctors and doctor-managers (Dot 6494187100 item 3): hiding a restricted doctor's clinical module refuses its clinical API on the server, ends its live session and keeps its `own` scopes; a doctor-manager grants only what it holds and never an `own` scope it cannot vouch for; revoking its staff module refuses the API and the direct page. Revocation racing a doctor-manager's pending save is decided by the exclusive fence queue: the first writer completes, the second is either applied after it or refused, never mixed (PG). A doctor or admin title alone grants nothing.
5. **Unified settings:** the inventory is in `UNIFIED_SETTINGS_INVENTORY.md`. Step 1 is done: the canonical `/api/settings` read and batch write (§5, slice 7) and the canonical settings screen. Next: account writes in the staff editor, the catalogue routes, then the owner-only tab with M4.

## 6. Dot review 6480538845: what the map now records

1. **Settings, per key.** `lib/settings-capabilities.ts` classifies every defined setting key exactly once (unit test against `SETTING_DEFINITIONS`):
   - operational → `settings.operational.edit`;
   - finance → `settings.finance.edit`;
   - authority → owner-only `settings.security.change`: `workflow.doctor_financial_view`, `finance.reception_adds_opening_balance`;
   - integration → owner-only `settings.integrations.change`: automatic reminders, consent mode, external AI;
   - backup → owner-only `clinic.backup.manage`.

   Operational never inherits the other classes. A batch needs every key's requirement; an unknown or refused key refuses the whole batch. Acceptance for the settings slice: no partial write, the existing expected-version CAS, and the audit row in the same transaction. Keys marked `forReview` need the owner's confirmation; they do not widen access.
2. **Branches.** Every entry whose handler branches on a request-body `action`, `op`, `mode` or `decision` declares `branches` with one requirement per value, plus `fields` for sensitive fields such as the capacity override, price overrides, role or credential changes. `scripts/audits/m2-route-scan.mjs` re-scans the handlers, and the map test fails when a branch value has no rule. Examples:
   - `booking-requests/[id]`: `confirm` needs `appointments.create`, `reject` needs `appointments.cancel`, and the capacity override needs `appointments.override-capacity`. The route itself grants nothing.
   - ortho billing decision: `no_charge` needs `clinical.ortho.edit`, `billed` needs `finance.invoices.create`.
3. **Projections.** `M2_PROJECTION_INVENTORY.json` lists every GET handler with a role-dependent signal (72 routes). It is generated from the code and drift-tested. No GET route can become `canonical-done` without a declared `projection`. Example: documents. `isAdmin` passes removed documents today; canonically they need `patients.documents.delete` (proposed) or the owner, never `clinical.xrays.view` alone. Counts cover only the projected rows.
4. **Care summary.** Narrowed as described in slice 1. Release-gated until the owner decides reception's clinical-summary scope.

Still open, not inferred: the owner decisions (four owner-only operations; empty manual grants versus per-account confirmed templates; reception's clinical-summary scope), the restore hold, owner-only recovery, and the issuer lost-COMMIT acknowledgement review (6479317375).

