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

### Counts (386 mapped route/method entries, after local slice 64 on WORK)

| Status | Routes |
|---|---|
| existing | 263 |
| owner-only | 23 |
| excluded | 12 |
| entry | 4 |
| self | 3 |
| canonical-done | 81 |

| Record scope | Routes |
|---|---|
| patient | 149 |
| appointment | 13 |

Counts are source conversion states, not an acceptance percentage. The broader inventory has 420 methods / 97 pages and remains NOT_READY. Published batch56–58 at `aa2388b0` has 77 canonical-done / 267 existing ordinary methods. Local59,61,62 add three methods, giving 80 / 264; UI60 and UI63 add no method. Full gates and review are tracked per slice, with no implication of whole-module readiness. Source pickers, bridge creation, image tracing, inventory and schema convergence remain separate.

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
- **Patient:** appointment scope `all` can schedule any patient; `own` books only the clinician's own patients (outside = missing, 404). The 2026-10-30 compound-scope follow-up additionally prevents an actor with patient scope `own` from assigning an outside patient to themselves, even with appointment scope `all` (403). The final resolved clinician is checked after day/doctor locks and before insertion on the admitted transaction. Other-doctor/unassigned scheduling and whole-patient/owner authority retain their rules.
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
- **Assignment boundary (2026-10-30):** new appointments from waiting entries use the same post-lock, pre-insert self-assignment guard as direct booking. A refused assignment rolls back the appointment, claim/link and audit together; existing recovery links do not create a patient relationship.
- **Tests:** PG `appointments-canonical-waiting-book` (9): book + link + close with every audit row and the idempotent second press; a full chair leaves no appointment and no claim, override audited; recovery linking; closed entry and live legacy claim refused (an expired claim books); two concurrent presses → one appointment; input validation; own scope (outside equals missing, own party only); capability, scope and revocation; audit failure leaves the entry open. `waiting-list-canonical` updated (book is its own command). Built journeys: `canonical-appointments-journey` books a candidate from the freed slot (audit and link checked); `canonical-waiting-list-journey` checks that book without `appointments.create` refuses (403).

### Slice 21 — online booking requests (`GET /api/booking-requests`, `PATCH /api/booking-requests/[id]`)
The queue holds people who are not patients yet (name and phone), so on the canonical path it opens only to `appointments.create` with the **whole** appointment scope; an `own`-scope clinician neither reads nor handles it (the confirmed appointment would land outside its scope). Navigation gains `wholeScope` for such pages; `/requests` («طلبات الحجز») is registered with it.
- **Read:** the record read `read:booking-requests` (need `appointments.create`), one owning snapshot (`listBookingRequestsWith`).
- **Confirm:** one admitted `appointments.create` transaction running **the same door** — the confirmation logic moved verbatim from the route into `lib/booking-request-confirm.ts` and is called by both branches (the single-door guard now pins that file and requires it to judge, check the override and record it). On the canonical path the day locks, the request row lock, the judgement and `confirmBookingRequest` run on the admitted client. Decisions to review: a request whose phone matches no patient creates a patient file, so it also needs `patients.create` (403 `patient_create_required` otherwise); the override needs `appointments.override-capacity` (the engine receives the label `canonical`). `appointment.create`, `booking_request.confirm` (new audit actions) and any override rows are atomic; any refusal rolls back (the request stays new and no patient is created).
- **Reject:** one admitted `appointments.cancel` transaction (`rejectBookingRequestWith`), `booking_request.reject` audited; booking grants never reject.
- **Tests:** PG `appointments-canonical-booking-requests` (7): queue scope and capability; confirmation of a new person (patient, appointment, request, audit rows) and the second press; patients.create needed only for a new person; full chair, role label never overrides, override audited; two concurrent confirmations → one appointment; own scope, grant, revocation and audit-failure rollback; rejection by grant with audit and the handled refusal. Built journey `canonical-booking-requests-journey` (2): HTTP refusals in Arabic, then the desk opens «طلبات الحجز» from the shell on a phone-width screen, confirms one request and closes another, both audited.

### Slice 22 — planned-session scheduling (`POST /api/planned-visits/[id]/schedule`) and the booking context read
- **Door:** the scheduling logic moved verbatim from the route into `lib/planned-visit-schedule.ts`, called by both branches; `schedulePlannedVisit` takes an optional caller transaction (preview, day locks, judgement and write on it). The single-door guard pins the file and requires the route to call it.
- **Canonical command** (`commandCanonicalPlannedVisitSchedule`): one admitted `appointments.create` transaction. The planned visit's patient must be inside the CURRENT patient scope (the map's scope; missing and outside answer identically, 404); the appointment scope must not be `none`, and with `own` the appointment must land on the actor's own clinician party (the case's responsible doctor; otherwise 403 and roll back). The engine takes the day locks, then the planned row (legacy order); the override needs `appointments.override-capacity`; `appointment.create` and any override rows are atomic; refusals roll back.
- **Booking context:** `GET /api/patients/[id]/return-booking-context` reads in the `read:patients.record` snapshot (patient scope) with the same resolver, so the canonical screen books on the responsible doctor read from the server at booking time.
- **Screen:** the canonical patient file shows «الجلسات المخطَّطة» (care projection) from the canonical workflow summary; an unbooked session offers «حدّد موعد الجلسة» (date and time only) with `appointments.create`; the duration warning asks for confirmation; refusals show the server's reasons. Rebooking stays legacy (its own slice).
- **Tests:** PG `planned-visits-canonical-schedule` (8): booking on the responsible doctor with audit and the second press refused; engine refusals; full chair, admin label never overrides, override audited; two concurrent presses → one appointment; own scope (outside equals missing; a patient it owns whose case belongs to another doctor rolls back); capability, appointment scope and revocation; audit failure. Built journey `canonical-planned-visits-journey` (2, portOffset 21).

### Slice 23 — planned-session rebooking (`POST /api/planned-visits/[id]/rebook`)
- **Writer:** `rebookPlannedVisit` becomes `rebookPlannedVisitWith(intent, authority)`; the legacy route passes the legacy authority (session revalidated in the transaction, patient access by role and ownership with the same revalidated session, referral scheduling by role, the role gate right after the intent parses) — the legacy behaviour and query sequence are unchanged (legacy rebooking PG files 62 green).
- **Canonical authority** (`commandCanonicalPlannedVisitRebook`): one admitted `appointments.create` transaction; the writer's whole lock order (reset fence → day → appointments → planned row → …) runs inside it; at its fixed points the identity is the admitted one (grants held FOR SHARE for the whole transaction), patient access is the CURRENT patient scope, a referral appointment needs the whole appointment scope or the receiving clinician, and `own` appointment scope rebooks only on its own party. Replay receipts are keyed by the canonical user id; the old appointment's attendance and history stay untouched; refusals roll back.
- **Projection:** the canonical workflow summary now offers `canRebook` for display by grant (`appointments.create`), appointment scope and the referral rule; the command re-proves everything.
- **Screen:** «أعد حجز الجلسة» (date, time, required reason) for a missed or cancelled session in the canonical patient file; one request id per attempt (a retry after a lost reply replays instead of booking twice); the engine's nearby-appointment warning is confirmed by a second, explicit click («تأكيد الحجز رغم ذلك», also for first-time scheduling).
- **Tests:** PG `planned-visits-canonical-rebook` (5): replacement on the responsible doctor with old attendance kept, audit and replay, another actor never replays a receipt; stale expectation and past time; own patient scope; own appointment scope on another doctor; capability, scope and revocation. `patients-canonical-directory` updated (no rebook without the grant). Built journey `canonical-planned-visits-journey` now 3 (rebook a missed session with the nearby confirmation).

### Slice 24 — recall (`GET/POST /api/recall`)
- **Read:** record read `read:recall`, one owning snapshot. The three lists (open past bookings, missed appointments, lapsed patients) take the CURRENT patient scope inside their SQL (`listOpenPastAppointmentsWith`, `listMissedAppointmentsWith`, `listLapsedPatientsWith` with the patient list's own condition), so an `own` clinician's list is never cut short by the limits on other doctors' rows. The legacy route listed every patient to every admitted role. `canRecord` = `appointments.create` (display only).
- **Record a follow-up:** one admitted `appointments.create` transaction (the map's requirement); the appointment or patient row is locked and its patient checked against the scope (outside = missing, 404); the first follow-up time is kept; `recall.contact` is audited atomically.
- **Screen:** `/recall` («المتابعة») registered for a patient scope. Closing a past booking uses the canonical appointment move (slice 17); «حجز موعد» opens the canonical day view's booking form with the patient chosen (`/appointments?bookPatient=`); the legacy proposals panel and quick-booking modal are not mounted for a canonical session. `canonical-entry-journey` now uses `/lab` as its not-yet-canonical example.
- **Tests:** PG `recall-canonical` (5): all versus own lists (and parity with the legacy lists for the whole scope), appointment scope alone refused, closed weeks; follow-up marks (first time kept, audit), own scope 404 parity, conflicts, capability, scope, revocation and audit rollback. Built journey `canonical-recall-journey` (2, portOffset 23).

### Slice 25 — provider blocks (`GET/POST /api/provider-blocks`, `DELETE /api/provider-blocks/[id]`)
- **Read:** record read `read:provider-blocks` in one owning snapshot.
  - **With `providerId`:** that doctor's blocks on the day, when the doctor is inside the appointment scope. With `own` scope that means the actor's own party; another doctor answers like a doctor without blocks, which is how the legacy route answers an unknown id.
  - **Without `providerId`:** the day panel, meaning every in-scope active doctor and its blocks.
  - `canManage` = `appointments.schedule.manage`, for display only.
- **Create:** one admitted `appointments.schedule.manage` transaction. `appointments.schedule.manage` is now in `CLINIC_RUNTIME_ACTIONS`. The legacy route allowed the admin role label.
  - **Scope:** the appointment scope bounds the doctor: `all` allows any active doctor, `own` only the actor's party, and `none` is refused.
  - **Day locks:** it takes the booking engine's `appointments-day:` locks for every clinic day the block touches, in ascending order as bookings do. A booking and a block for the same day therefore serialize instead of crossing.
  - **Validation:** a reason is required (at most 300 characters) and a block lasts at most 92 days.
  - **Overlap:** the answer reports how many booked or arrived appointments of that doctor overlap the block, as a warning; they are not moved.
  - **Audit:** `provider_block.create` (with the overlap count) is audited atomically.
- **Cancel:** the block is locked. For `own` scope, another doctor's block reads like a missing one (404). A second cancel is 409. `provider_block.cancel` is audited atomically.
- **Shared writers:** `createProviderBlockWith` and `cancelProviderBlockWith` serve both branches; the legacy path keeps its post-write audit.
- **Screen:** the panel «حجب أوقات الأطباء» in the canonical appointments day view. The legacy app had no screen for blocks. It offers the doctor, the reason, a start time, and an end date and time, all in clinic time; cancelling is one button.
- **Tests:**
  - PG `provider-blocks-canonical` (8):
    - create with overlap and atomic audit, own-scope bound, and refusals that write nothing;
    - waiting on the day lock;
    - all and own reads, plus the day panel;
    - cancel parity and the second cancel;
    - audit rollback.
  - Unit `provider-blocks-panel-time` (clinic wall time).
  - Built journey `canonical-provider-blocks-journey` (2, portOffset 31). The appointments journey's API allowlists now include `/api/provider-blocks`.

### Slice 26 — shifts (`GET/POST/PATCH /api/shifts`, `/finance`)
- **Owner decision, 2026-10-30:** `finance.shifts.view` exposes complete per-currency drawer aggregates and recent shift summaries. Receipt details additionally require `finance.payments.view` AND the current patient scope; expenses require `finance.expenses.view`. The protected owner retains all details. Unattributed shift notes/difference reasons require both detail grants and the whole patient scope. No category, party or hidden-patient subtotals/counts are exposed.
- **Read:** `readCanonicalShifts` uses one owning RR read-only snapshot for current authority, scope, shifts, full drawer, filtered details and provenance. `own` reuses the central patient condition in SQL before limiting; `none` omits receipt keys. Each detail list is bounded to 1000 visible rows plus a scoped truncation flag; full totals are unaffected. `readReceiptProvenanceInSnapshot` remains SELECT-only, with its previous guards/bounds; SQL failure aborts the whole snapshot. No helper falls back to a second lease.
- **Commands:** unchanged from the reviewed `780448b9` batch. Exact operate grant, lifecycle lock then existing shared shift row lock, proof after waits, existing currency/drawer rules and atomic effect/audit. No collection, expense, payroll or migration changes.
- **Screen:** `app/finance/layout.tsx` chooses the canonical component, preserving the legacy page and avoiding its unrelated API calls. `/finance` is registered exactly under shifts.view, even without patient scope; nested finance pages remain held. It renders only server-projected details, never print/export links. Refresh/focus/visibility and a 30-second visible-tab reread clear stale data before reading and after refusal; authority is always proved on the server.
- **Uncertain writes:** state guards are NOT a durable request key. A late open retry after the original shift closed could open another shift. Exactly one POST/PATCH per explicit submission; on lost/5xx/malformed replies, a tab-local sessionStorage marker blocks commands across reload/navigation. GET verifies current state; a separate explicit new-intent acknowledgement and fresh read unlock a new form submission. No automatic retry.
- **Evidence:** PG commands 12 + reads 9; canonical built HTTP/browser journey 10 after the compound-scope follow-up (portOffset 33; the initial read/UI batch had 9), including 390/1280px, scope projection, revoked permissions, safe read failures, legacy print/export refusal, and a committed open whose response is lost after external close. Existing command/financial regression and receipt performance guards remain. See `docs/review/work-shifts-slice26-complete-20261030.md` for actual runs and limitations. Three map rows are `canonical-done` as source migration status; cutover remains `NOT_READY` and parent acceptance is pending.
- **Compound-scope boundary, 2026-10-30:** a synthetic reproduction on `78758658` proved that own-patient/all-appointment self-booking exposed an outside receipt without changing the drawer. Direct and waiting-list canonical booking now reject that self-assignment before insertion and after lock waits, using current patient scope on the admitted client. Central `DOCTOR_PATIENT_CONDITION`, existing relationships, legitimate other-doctor/unassigned scheduling and owner authority remain unchanged. Six new PG regressions plus the built HTTP/browser chain cover the boundary. Reschedule and online confirmation already require current clinical responsibility for clinician reassignment; their regressions were rerun. See `docs/review/work-shifts-scope-boundary-20261030.md`. This closes the reproduced prospective path; it does not establish a production incident, retrospectively clean relationships, or authorize activation. Parent review and final-head CI remain required.

### Slice 28 — next session (`POST /api/visits/[id]/next`)
- `appointments.create`, current patient scope (outside = missing), non-none appointment scope; own appointment scope books only on the actor's clinician, who must be the source's current responsible doctor. Client doctor overrides are ignored as on the legacy route.
- One `withStaffOperation` transaction: day-window locks → visit → patient/scope/responsibility witnesses (NOWAIT against inverse clinical ordering); reproof after waits and before commit. Resolve an existing phone-matched patient's scope **before** linking it to the actor's walk-in visit. No self-booking can create its own authorization.
- `createNextSessionWith` shares the exact old writer. Settings, service resolution, provider blocks, capacity judgement and writes use the admitted client. Every refusal rolls back file/link/phone changes; appointment and override audit commit atomically. Actual new-file creation needs `patients.create`, following slice 21; a missing clinical source still refuses and rolls it back.
- Existing source fingerprints, active responsible doctor, overlap, nearby confirmation, capacity and override grant/reason remain. No financial policy, migration or durable request receipt added.
- Canonical UI: patient's recent visits and completed visits in the internal queue; scheduler can book without queue-management or clinical-detail grants. Lost/5xx/unverified success never auto-retries (tab-local recovery marker survives reload; no name, phone or token): read scoped appointments, show a matching booking if found, otherwise require separate new intent. This is not an exactly-once promise across cancellation, a new browser session, unavailable browser storage or a new proposal.
- Evidence: `docs/review/work-next-session-slice28-20261030.md`; built journey portOffset 37. Map status records source migration, not deployment or overall acceptance.

### Slice 29 — orthodontic case summaries (`GET /api/ortho`)

- `read:ortho.cases` requires `clinical.ortho.view` and a non-none patient scope. One owning RR READ ONLY snapshot proves the session, grant and patient relationship and reads every summary; no legacy fallback or `ensureSchema` inside it.
- Optional `patientId`: existence and current membership use the standard per-patient reader; outside and missing share the same 404. With no filter, open cases only; a patient filter retains closed history. Own scope uses `DOCTOR_PATIENT_CONDITION` in SQL before the 300-row limit. A 301st allowed row sets `hasMore`; foreign rows never affect it.
- Explicit summary projection: case/patient identity, appliance/arches, recorded status/phase, start and planned duration, current recorded wires, responsible doctor and historical-baseline marker. No plan/funding, clinical notes, adjustment history, images or diagnosis payload; this is not a complete case record. Owner uses the same summary representation, without changing their underlying grants.
- The on-demand section in `CanonicalPatientProfile` requires the grant and patient scope; no registration of the legacy `/ortho` follow-up board. Reads clear old data on refresh, focus/visibility change, failure or timeout; responses superseded by a newer request are ignored. No editor, booking or legacy endpoint mounts.
- Source boundary: one GET only. Existing writers, clinical/financial relationships, full legacy case readers, ceph and plans remain untouched. This is a read: no new mutation/audit policy or idempotency claim.
- Evidence: `__tests__/postgres/ortho-canonical-cases.test.ts` and built `canonical-ortho-cases-journey` (portOffset 39); delivery report `docs/review/work-ortho-cases-slice29-20261030.md`.

### Slice 30 — one native clinical orthodontic case

- `GET /api/ortho/[id]` / `read:ortho.case`: `clinical.ortho.view` AND patient scope. Case existence and current central patient witnesses are filtered in SQL in the same owning RR READ ONLY snapshot as admission, clinical values, history and progress. Missing/outside have the same 404. No caller-selected field expansion or scope.
- Explicit clinical fields and native ortho case/adjustment notes. These notes belong to the ortho record; this grants no general visit notes, history or document access. No legacy hydration, plan id, legacy financial mode, images, document metadata, linked visit identifiers/signatures or closed-by account metadata. Owner uses the same bounded representation without changing grants. Independent document delivery remains unconverted.
- Latest 100 adjustments, deterministic date/id ordering and `hasMore`. Progress uses all scoped-case adjustments, not the bounded array. Read size is bounded at 1 MiB; oversized notes fail the result rather than silently truncating clinical content.
- Nested on-demand detail under the admitted summary, with existing RTL/390px design, timeout, abort/generation guards and clearing on failure/refresh/hide. No old editor or independent endpoint mounts. Parent-summary refresh may close the detail; no stale retained copy.
- All three data SELECTs use the owning connection. No mutations, migrations or financial rules change. Legacy GET body and POST/PATCH bodies remain unchanged.
- Evidence: `ortho-canonical-detail.test.ts`, `canonical-ortho-detail-journey.test.ts` (portOffset 41), report `docs/review/work-ortho-detail-slice30-20261030.md`.

### Slice 31 — immutable assessment read

- `GET /api/ortho/[id]/assessment`, registered `read:ortho.assessment`: `clinical.ortho.view` and current patient scope. Explicit `acceptSchema=2` or `1,2`; optional positive INTEGER `revisionId` scoped to this case. No extra/duplicate query keys or legacy fallback.
- One owning RR READ ONLY snapshot covers admission, central patient witnesses, unique owned clinical bridge, supported treatment-episode state, complete bounded history and source ownership/versions. A missing bridge with no history is explicit; orphaned history, corrupt hashes/schema/lineage and unknown revisions fail rather than becoming empty records. No bridge creation or history repair.
- Reuse the existing version-pinned content/hash decoder and unchanged history budgets (5000 revisions / 8 MiB stored content). Every historical source closure is checked, including copies; history reasons or an older revision URL cannot bypass a restricted ancestor. Imaging needs `clinical.xrays.view`; patient-history/visit references need the existing `PATIENT_CARE_CAPABILITIES` group, not ortho view alone. No new role policy.
- All external source identities across the returned history share the existing 128-source bound. Different historical versions of one mutable source remain distinct witnesses; capture current facts once with SELECT only. Missing/foreign ownership refuses the whole read; an owned changed/removed source preserves immutable content with an honest changed/unavailable state. Existing graph/external byte limits remain; resource excess never truncates history silently.
- No funding, image bytes/URLs, storage paths, source titles, unrelated notes or source-picker data. Only authorized reference ids/hashes and states are returned. `clinicalWritable=false`; editing choices are empty and explicitly incomplete. The owner retains their grants, but this route contract admits no mutation.
- Existing assessment renderer/async hash verifier reused in explicit read-only mode beneath the case detail. No editor lifetime or POST; on-demand mount, 30-second refresh and clear on hide/focus, generation guards and 15-second read timeout. Existing legacy rendering/writers keep their default behavior. No historical result is rewritten or recalculated using a replacement engine.
- Tests: `ortho-canonical-assessment`, `canonical-ortho-assessment-journey` (portOffset 43); report `docs/review/work-ortho-assessment-slice31-20261031.md`.

### Slice 32 — saved orthodontic strategy read

- `GET /api/ortho/[id]/strategy`, `read:ortho.strategy`: `clinical.ortho.view` and patient scope; optional exact positive INTEGER `revisionId`, no expansion/query alias or canonical-to-legacy fallback.
- One owning RR READ ONLY snapshot covers fresh authority, central patient scope, unique owned orthodontic bridge, supported case state, complete saved lineage and current reference status. Missing/outside are the same 404; a legitimate absent bridge remains explicit, while existing orphaned history is rejected.
- Existing schema-1 decoder and pure historical projection are reused. Entire history is validated before choosing a version. The canonical reader bounds history at 5000 revisions / 8 MiB and the union of linked problem/item identities at 128. Excess fails explicitly, without truncation, repair or writes.
- Native saved problems, objectives, strategy, rationale and revision reasons are clinical documentation. Saved plan-item links require the independent `clinical.plans.view` grant; otherwise each row exposes only `planLinks:{state:"restricted"}`, with no names, IDs, counts or choices. Current foreign links contribute no content; historical text is never replaced by current names. No prices, agreements, finance, images or editor choices are queried or returned.
- `clinicalWritable=false`, `planLinksWritable=false`, `canRevise=false`. The existing strategy reference renderer mounts on demand without an editor lifetime; 30-second/visibility/focus refresh, unmount/transport/decoder ownership, and existing 15-second timeout retire old documents. The legacy GET/POST and store reader/writer bodies remain unchanged.
- Evidence: `ortho-canonical-strategy`, `canonical-ortho-strategy-journey` (portOffset 45), legacy strategy/union regression; `docs/review/work-ortho-strategy-slice32-20261101.md`. Source-map migration status is not activation or independent acceptance.

### Slice 33 — saved cephalometric study list

- `GET /api/patients/[id]/ceph`, registered `read:ceph.list`: `clinical.xrays.view` and current patient scope. The old map's empty `need` was incomplete; the existing legacy handler already requires `canViewXrays`. No role-derived or orthodontic-view-derived imaging grant.
- One owning RR READ ONLY snapshot covers authority, central patient membership, study metadata, backing document / optional ortho-case ownership and saved ANB/FMA/WITS. Outside/missing patient = 404. A broken/foreign backing relationship rejects without details; owned removed or non-image references retain saved study values with `imageState=unavailable` and no image identity or content.
- `ceph-summary` allows id/patientId/status/phase/calendar xrayDate/createdAt/completedAt/imageState/findings only. Excludes discarded studies. Draft first, then createdAt DESC and id DESC; bound 300 plus `hasMore`. No summary counts claiming completeness. Drafts never expose sealed findings; completed values are saved data, not recalculated or rounded replacements. Non-finite stored values reject the whole read.
- No document IDs, image bytes/URLs/storage paths, notes, device, diagnosis, calibration, finance, current reference names or editor data. On-demand canonical patient panel clears on focus/hide/refresh/denial, retires late replies and times out after eight seconds. The legacy readers and all writes remain unchanged.
- Evidence: `ceph-canonical-list`, calendar-date regression, `canonical-ceph-list-journey` (portOffset 46), projection/parser and existing ceph UI tests. Source migration is not activation or independent acceptance.

### Slice 34 — one saved cephalometric study

- `GET /api/ceph/[id]`, `read:ceph.study`: independent `clinical.xrays.view` and current patient scope, strict positive safe study ID, no query expansion. Missing/discarded/outside return the same 404. No canonical-to-legacy fallback.
- One RR READ ONLY snapshot covers admission, study ownership, central patient scope, backing document and optional orthodontic relation, saved calibration, metadata, landmarks, measurements and diagnosis. Foreign backing ownership fails; an owned removed/non-image reference preserves the saved study with an unavailable state, without granting image access.
- Explicit `ceph-saved-study` projection, no document/case IDs, source titles, image bytes/URLs/storage or finance. Native clinical note/diagnosis and their recorded authors are imaging-study data under this grant. Unknown historical landmark/measurement codes are retained literally instead of silently dropped by a current catalogue. No clinical/reference/calibration engine is run.
- Whole-study limits are checked before materializing content: 256 landmarks, 256 measurements and 2 MiB stored bytes. Excess/invalid finite numeric data or partial calibration rejects; no history repair or silent truncation. Saved draft measurements remain explicitly `saved-unapproved`; approved values derive only from the recorded completed status. No new clinical decision is made.
- Read-only on-demand panel inside the study list; no editor/tracer, PATCH/DELETE, image fetch or legacy page link. Scope/identity parser, eight-second timeout, clear-on-refresh/hide/denial and delayed-response retirement. Existing legacy GET/PATCH/DELETE and database writers retain their bodies.
- Tests: `ceph-canonical-study`, full saved-list/calendar regression, `canonical-ceph-study-journey` (portOffset 47), older ortho/assessment and legacy ceph UI journeys. This is one read contract, not the whole ceph workflow.

### Slice 36 — patient plans, clinical projection

`GET /api/patients/[id]/plans` now has an independent `clinical.plans.view` plus patient-scope read. One RR READ ONLY snapshot covers authority, plan metadata, item facts, reference ownership and actual completed clinical sessions. Latest 100 plans have an explicit `hasMore`; at most 256 items per plan, 2000 per result, and 2 MiB are accepted before content materialization. Missing targets and native recorded values remain explicit. No financial query or data, plan/consent writer, image, appointment authority or historical recomputation is introduced. The legacy route body is preserved; canonical financial detail remains outside this clinical contract.

The read-only patient panel clears stale or failed responses and has no action or legacy navigation. Local and exact-head CI evidence is tracked in the slice report; source conversion status is not release acceptance.

### Slice 35 — current cephalometric reference catalogue

- `GET /api/ceph-reference-sets`: existing `clinical.xrays.view`, no patient record scope. Register that exact capability in the closed runtime action lists and use the existing owning RR READ ONLY snapshot; never grant access to patient data. A role label or adjacent clinical grant does not suffice. Patient `none` / unlinked `own` may read these non-patient reference facts but still cannot read studies.
- Explicit `ceph-reference-catalog` with active set key/name/population/age bounds/sex/version and original mean/sd values. No author, database IDs, patients, images, source storage or finance. No clinical engine or automatic reference selection, no replacement of historical study values. Unknown saved codes and precision remain intact.
- Whole-catalogue bounds before materialization: 200 active sets, 256 values per set, 2 MiB. Excess, invalid ages or non-finite mean/sd refuse without silent truncation/defaults. Inactive sets cannot leak through filters or query expansion. Metadata and values share the same snapshot.
- Current-reference panel inside the canonical ceph section, explicitly distinguished from the reference used for a historical study. Read only, eight-second timeout, hide/refresh/revocation clearing and delayed-response retirement. Min/max age labels are separate to avoid RTL interval reversal.
- PostgreSQL and HTTP/browser proof covers independent permission, none/own/all, real fence waiting and revocation, concurrent revisions, failed leases, exact JSON keys and unchanged legacy behavior. Source conversion is not independent acceptance, activation or completion of comparison/tracing workflows.

### Slice 66 — lab reads and the canonical lab board (`GET /api/lab`, `GET /api/lab/backlog`, `/lab`)
- **Orders:** record read `read:lab.orders` (`clinical.lab.view`) in one owning snapshot.
  - The patient scope is applied in SQL before the list limit: `own` uses the central `DOCTOR_PATIENT_CONDITION`, and `none` is refused.
  - Another patient answers like a patient without orders.
  - `summary=1` counts follow the scope.
  - Digits-only patient id (`1e9` is refused).
- **Money:** the clinical fields are an allowlist (`clinicalLabOrder`). Cost, currency, base amount, rate, financial status, payable, accounts and posting are added only with `finance.cost-prices.view`. The legacy route hid only cost/currency from doctors.
- **Backlog:** record read `read:lab.backlog`, the whole clinic's open work.
  - It needs the whole patient scope (`all`).
  - Linked tasks are shown only with `tasks.use`; others' private tasks never.
  - Same SQL as the legacy admin snapshot (`readLabBacklogWith`).
- **Shared fix (legacy too):** `listLabOrdersWith` makes the daily window a `WHERE` condition. It was appended after the last `LEFT JOIN` and filtered nothing, so the oldest 300 orders were listed and open work fell off. The window keeps `remake` orders.
- **Screen:** `app/lab/layout.tsx` mounts `CanonicalLabBoard`, a read-only board for this slice: filters, days late, due today, the backlog for the whole scope, and costs only when sent. `/lab` is registered with `clinical.lab.view` and a patient scope.
- **Tests:** PG `lab-canonical-reads` (6); existing lab PG suites 353/19; built journey `canonical-lab-board-journey` (3, portOffset 106). `canonical-entry-journey`'s not-yet-canonical examples are now `/api/laboratories` and `/reports`.

### Slice 67 — lab-order commands (`PATCH /api/lab/[id]` status, due date, events; `DELETE /api/lab/[id]`)
- **Status:** one admitted `clinical.lab.order` transaction through the legacy writer's own body (`setLabOrderStatusOn`, an injectable `LabStatusAuthority`; the legacy wrapper keeps its session revalidation and builds the same authority).
  - The order row is locked first. An order outside the patient scope answers like a missing one (404): `own` uses `DOCTOR_PATIENT_CONDITION`; `none` is refused.
  - An optional `expectedStatus` (what the screen showed) is compared under the lock: a stale screen gets 409 `lab_status_changed` and writes nothing.
  - Unchanged: the transition map, the prescription gate (`needed` → `sent` only through prescription completion), the tracking row, and the money effects (an unpaid payable is removed on cancel and the order becomes exempt; a paid one is kept; receipt/fitting recognises the payable once, `ON CONFLICT (lab_order_id)`).
  - The response is the clinical projection unless `finance.cost-prices.view`.
- **Cancel after dispatch** (status past `needed`) also needs `clinical.lab.cancel` (the map's field rule; the legacy route checked the admin role label). The `lab_order.cancel` audit row commits with the cancel; the legacy route wrote it after the commit.
- **Due date:** `setLabOrderDueDateOn` under the row lock and scope, for open work only (`needed`, `sent`, `in_progress`, `remake`), with a real calendar date. The tracking row carries the admitted actor and commits with the date. Shared fix (legacy too): the legacy list stopped at `needed`/`sent`, although its own refusal reads "work that arrived or was cancelled"; the legacy writer is now one transaction instead of two statements.
- **Events:** record read `read:lab.events` (`clinical.lab.view`) inside the patient scope.
- **Delete:** one admitted `clinical.lab.cancel` transaction (`deleteLabOrderOn`). The legacy rules are unchanged (source-linked or settled refused, reason of 3+ characters, unpaid payable removed). The `lab_order.delete` audit row commits with the delete.
- **Held:** `complete_prescription`, `update_clinical`, `update_shade`, `update_accounting`, `post` and `unpost` are refused explicitly in the canonical branch (409 `lab_action_not_canonical`). Money and posting stay behind their legacy guards and are unreachable from canonical sessions until their own reviewed slice.
- **Screen:** `CanonicalLabOrderActions` on each board card offers the next moves, an explicit two-press cancel (only with `clinical.lab.cancel` after dispatch), the promised date, and the tracking events. Each move sends `expectedStatus`; a 409 reloads the board.
- **Tests:** PG `lab-canonical-orders` (14), including:
  - two concurrent receipts: one wins, one payable, one tracking row;
  - cancel racing receipt: exactly one applies and the money stays consistent;
  - a move waits on the row lock, then reads the moved status.
  All lab PG suites 373/373 in 21 files. Built journey `canonical-lab-orders-journey` (3, portOffset 108).

### Slice 68 — lab-order creation with a request key (`POST /api/lab`)
- **Admission and scope:** one admitted `clinical.lab.order` transaction (`createLabOrderOn`, the legacy writer's own body). The patient must be inside the patient scope: outside or missing answers 404, and `none` is refused. The legacy route checked no patient access.
- **Duplicate prevention, without schema change:**
  - A `requestKey` is required, one per form submission.
  - Under a transaction advisory lock on (actor, key), the receipt is looked up first. The receipt is the same-transaction `lab_order.create` audit row, carrying the key and a fingerprint of the normalised request (stable JSON, nested fields included; 1-day window).
  - Same key + same request → the existing order is returned (200, `replayed`).
  - Same key + another request → 409 `lab_request_key_reused`.
  - Key whose order was deleted → 409 `lab_request_key_used`.
  - A failed attempt commits nothing, so its retry creates once. Keys are per actor.
  - The visit/tooth unique index still refuses a second order for the same tooth (409 `lab_order_exists`).
- **Money and posting:**
  - Explicit `cost`, `costCurrency`, `expenseCategoryId`, `expenseAccountCode`, `payableAccountCode` and `isPosted` are refused (409 `lab_money_not_canonical`, naming the field).
  - The only money effect is the legacy automatic price from the lab's pricing rules in force, with the legacy default accounts and posting.
  - The response is the clinical projection unless `finance.cost-prices.view`.
- **Directory:**
  - The lab must be an active lab party. The legacy route created a party from free text, a directory write that belongs to `clinical.laboratories.manage`.
  - A clinician-linked actor orders in its own name (the legacy doctor binding); others name an active doctor.
  - A visit must belong to the patient.
  - `GET /api/lab` returns the creation directory (active labs and doctors, names only) to `clinical.lab.order` holders.
- **Audit:** the `lab_order.create` audit row commits with the order; the legacy route wrote it after the commit.
- **Screen:** `CanonicalLabCreateForm` on the board.
  - Patient search goes through the canonical directory.
  - One key per opened form, kept across retries; a lost response is retried safely.
  - The form keeps its directory across the 30-second refresh, so it is never unmounted while being filled in.
- **Post-dispatch policy (pending the owner):**
  - [`lab-post-dispatch-policy-20261103.md`](../../review/lab-post-dispatch-policy-20261103.md) documents the map's text, the legacy behaviour, the two readings and the proposed decision.
  - The rule is one constant, `LAB_POST_DISPATCH_CANCEL_GUARDED = ["cancelled"]` (legacy-equivalent), checked under the lock.
  - PG `lab-canonical-dispatch-policy` (6) pins 12 moves × 4 grant sets.
- **Tests:**
  - PG `lab-canonical-create` (10): double press, 5 concurrent submissions with one key, reused key, distinct keys, per-actor keys, failed-attempt retry, deleted-order key, visit/tooth guard, money refusals, directory, scope and doctor binding, automatic price.
  - Unit `canonical-lab-create-fingerprint` (4).
  - Built journey `canonical-lab-create-journey` (2, portOffset 110), including a lost-response retry in the browser.

### Slice 69 — lab-order corrections (`PATCH /api/lab/[id]`: `complete_prescription`, `update_clinical`, `update_shade`)
- **Admission:** one admitted `clinical.visits.document` transaction each (the map's branch requirement). The legacy route allowed admin/doctor for the prescription and admin/doctor/reception for the corrections.
- **Writers:** the legacy bodies run unchanged through an injectable authority: `completeLabPrescriptionOn` (`LabPrescriptionAuthority`), `updateLabOrderClinicalOn` and `updateLabOrderShadesOn` (`LabClinicalAuthority`). The legacy wrappers build the same authority from their revalidated session. A doctor session without a linked party still may not change the doctor at all.
- **Locking:** the order row is locked and the patient scope checked first; outside the scope reads like a missing order (404). The prescription keeps the legacy lock order: the `lab_orders` table lock with `NOWAIT` before any row lock.
- **Guards, unchanged:**
  - the prescription's observed version and needed-only rule;
  - the source scope;
  - the lab change refused when a cost or payable is attached;
  - the clinical snapshot CAS, with doctor and lab changes refused when money or an invoice is attached;
  - the shade specification CAS;
  - a clinician may reassign the treating doctor only to itself.
- **Audit:** every audit row commits with its write.
- **Held:** accounting and posting stay refused (409 `lab_action_not_canonical`).
- **Screen:** `CanonicalLabCorrections` on the board, for `clinical.visits.document` holders.
  - Prescription completion with draft or dispatch, sending the observed version.
  - Clinical correction (work, teeth, doctor, lab), sending the observed snapshot.
  - Per-tooth body shade, sending the observed specification.
  - The read's directory now also reaches `clinical.visits.document` holders.
- **Tests:**
  - PG `lab-canonical-corrections` (7), including two concurrent shade edits from one observed state, of which exactly one applies.
  - Legacy suites `lab-prescription-completion`, `lab-shade-persistence`, `auto-lab-doctor-attribution`, `lab-work-intent-lifecycle` (PG 60) and the five route/write unit files (72): unchanged and passing.
  - Built journey `canonical-lab-corrections-journey` (2, portOffset 112).

### Slice 70a — laboratory directory, services catalogue reads, work-intent capability
- **Reads:** one owning snapshot under `clinical.lab.view`, covering `GET /api/laboratories(/[id])` and `GET /api/lab/services(/[id])`. Labs and services are directories, not patient records.
  - The lab's accounting group (currency, expense/payable accounts, automatic posting, custom account name) is added only with `finance.payables.record`; the legacy route showed it to every role.
  - The services catalogue carries no prices.
- **Writes:** `POST /api/laboratories`, `PATCH/DELETE /api/laboratories/[id]`, each one admitted `clinical.laboratories.manage` transaction; the legacy route checked the admin role label.
  - Contact and clinical fields only. The accounting group is refused (409 `lab_money_not_canonical`); a new lab gets the legacy defaults.
  - The party row is locked before a change, and the `settings.update` audit row commits with the write.
  - Delete keeps the legacy rule: a lab with orders is deactivated, never erased.
- **Capability:** `GET /api/lab/work-intents/capability` under `clinical.lab.order`; the legacy route checked admin/doctor labels.
- **Runtime actions added:** `clinical.lab.view` and `clinical.laboratories.manage`.
- **Screen:** `/settings/laboratories` is registered for `clinical.laboratories.manage`. Its layout mounts `CanonicalLaboratoriesDirectory` on the exact path (list, add, edit, deactivate/delete with confirmation). The entry journey's not-yet-canonical example is now `/api/lab/pricing`.
- **Not in 70a:** services writes and pricing (`finance.lab-prices.edit`, seven methods). They are slice 70b; the legacy pricing read shows cost prices to every role, which is an owner decision point.
- **Tests:** PG `lab-canonical-directory` (5), including concurrent changes that both land and are both audited; built journey `canonical-lab-directory-journey` (2, portOffset 114).

### Slice 70b — lab pricing and services-catalogue writes (owner decision on cost prices)
- **Owner decision, 2026-11-03 (#483 comment 6615071565):** lab cost prices are seen only with `finance.cost-prices.view`. Entering the lab module or holding `clinical.lab.view` is not enough. It is enforced in the server for every response that carries a price.
  - `GET /api/lab/pricing` (the list and `resolve`): `need` becomes `clinical.lab.view` + `finance.cost-prices.view`, and the answer is refused (403) without it — never a list with blanked prices.
  - Revoking the capability refuses a session issued earlier: the permission revision invalidates it.
- **Pricing writes:** `POST /api/lab/pricing` and `PUT/DELETE /api/lab/pricing/[id]` run under the independent `finance.lab-prices.edit` (unchanged; no new grant).
  - The response carries amounts only with `finance.cost-prices.view`, so an editor without it never reads a stored price back.
  - One transaction under an advisory lock on (lab, service). Closing the previous rule and creating the new one commit together; the legacy route ran them as separate statements.
  - Amounts are whole minor units. A currency change must restate the amount (the legacy route reinterpreted it). Dates are validated against the stored rule.
  - The audit row (with amounts, for financial accountability) commits with the write.
- **Services catalogue writes:** `POST /api/lab/services` (including `seed_defaults` under its own lock) and `PATCH/DELETE /api/lab/services/[id]` under `finance.lab-prices.edit` (the map).
  - A taken code is 409.
  - Delete keeps the legacy rule (deactivate when used), audited as `lab_service.deactivate`.
- **Shared fix:** the legacy `createLabPricingRule` returned the newest rule of the pair, not necessarily the one it created. It now returns the created rule.
- **Screens:** `/settings/lab-pricing` (anyOf cost view or price edit) and `/settings/lab-services` (`clinical.lab.view`), each mounted on the exact path.
  - The pricing page never requests prices without the cost capability.
  - The entry journey's not-yet-canonical example is now `/api/families`.
- **Note:** the audit reader (`/api/audit`) is still legacy (owner/admin). Its canonical slice must apply the same price projection to `lab_pricing.*` and `lab_order.create` details.
- **Tests:**
  - PG `lab-canonical-pricing` (7): refusal for list/resolve, revocation, editor without amounts, atomic close-previous, validation, pair lock wait, services writes, legacy create fix.
  - Built journey `canonical-lab-pricing-journey` (2, portOffset 116).

### Slice 71 — lab-order accounting (`PATCH /api/lab/[id]`: `update_accounting`, `post`, `unpost`)
- **Admission:** one admitted `finance.payables.record` transaction (the map's branch requirement). The legacy route allowed money roles by label.
- **Writer:** the legacy writer's own body (`updateLabOrderAccountingOn`, `LabAccountingAuthority`). The legacy wrapper keeps its session revalidation and money-role check, its no-patient-check contract for internal callers, and its no-op commit.
- **Guards, unchanged:**
  - payable link validation;
  - settlement evidence refusal;
  - the `finance.locked_before` period lock, the linked visit invoice included;
  - saved-snapshot and FX precision rules;
  - the NOWAIT lock order on payable and settings;
  - the payable updated or created once;
  - tracking and `lab_order.accounting` audit with the write.
- **Scope:** the patient must be inside the actor's patient scope; outside reads as missing, and `none` is refused. The legacy rule was "money roles any patient; doctors their accessible patients".
- **Exchange rate:** from settings (server-owned), with the optional `expectedExchangeRate` quote fence; the legacy parsing is kept field for field.
- **Owner money rule (6615124926):** the response carries amounts only with `finance.cost-prices.view`.
- **Screen:** `CanonicalLabAccounting` on the board for `finance.payables.record` holders (post, unpost, cost with its currency). It shows no amounts.
- **Tests:**
  - PG `lab-canonical-accounting` (6): post/unpost with tracking and audit, cost change in sync with the payable, exact no-op, currency required, settlement and period lock refused, concurrent edits consistent, scope, grant, revocation.
  - Legacy accounting suites: PG 161 and unit 145, unchanged.
  - Built journey `canonical-lab-accounting-journey` (2, portOffset 118). The orders and corrections journeys now expect 403 for posting without the grant.
- **Lab group status:** every lab route method is now canonical. The only open item is the owner's post-dispatch decision.

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


### Slice 40 — patient clinical cases and plan dependencies

`GET /api/patients/[id]/cases` uses the existing care record rule and current patient scope in one fenced RR READ ONLY snapshot. Plan items and edges require `clinical.plans.view`; native/bridged orthodontic cases require `clinical.ortho.view`. The exact clinical allowlist excludes financial markers and image/assessment data. All joined references belong to the same patient; missing and outside are identical. The complete graph includes explicitly labelled cancelled-plan endpoints; 1000 cases, 1000 problems, 2000 items, 4000 edges and 2 MiB are hard read bounds, not silent truncation. Cycles, malformed states or foreign references refuse the whole read. No existing writer is activated. See [the acceptance matrix](../../review/work-patient-cases-slice40-20261101.md); local implementation is distinct from final-head CI and independent acceptance.

### Slice 41 — plan-item case and priority

`PUT /api/plan-items/[id]/case` admits the existing `clinical.plans.edit` action, its view prerequisite and current patient scope. Patient/item waits are followed by fresh authority and locked ownership witnesses. Both old/new ortho links require independent ortho visibility. The shared writer preserves retained invoice/agreement attribution, priority-only edits and atomic audit. Exact expected values reject stale requests. The client preserves an uncertain tab intent, verifies current state and requires a new explicit intent; it never automatically replays. This is not a durable receipt. See [the acceptance matrix](../../review/work-plan-case-slice41-20261101.md); source implementation is distinct from exact-head CI and independent review.

### Slice 42 — plan dependency add/remove

`POST` and `DELETE /api/plan-items/[id]/dependencies` use existing plan-edit/view authority and current patient scope. Both endpoints are locked to the same patient; graph mutations share the legacy patient lock, preserve cycle semantics and audit atomically. Add is bounded; removal requires the opaque stored-edge version emitted by the clinical reader, preventing a stale request from deleting a recreated edge. The UI stores only a minimal pending marker and never replays automatically. No permanent request receipt or financial/execution policy is added. See [the acceptance matrix](../../review/work-plan-dependency-slice42-20261101.md). Focused local validation does not replace full exact-head CI or independent review.

### Slice 43 — general clinical case status

`PATCH /api/cases/[id]` uses current plan-edit/view authority and patient scope with a locked opaque version comparison, post-wait checks and atomic original transition/audit logic. Terminal cases cannot reopen; bridged orthodontic cases remain native-managed. No creation, assignment, money or permanent request receipt. See [the acceptance matrix](../../review/work-case-status-slice43-20261101.md). Local focused gates do not replace exact-head CI or independent review.

### Slice 44 — clinical problem status

`PATCH /api/problems/[id]` requires current `clinical.visits.document`, independently of plan edit. Original problem transitions, resolution provenance and atomic audit run on the admitted connection after patient and problem locks with a row-version comparison. It does not modify the case or financial state. The client requires explicit new intent after uncertainty. See [the acceptance matrix](../../review/work-problem-status-slice44-20261101.md); full new-head gates and review remain separate.

### Slice 45 — create a clinical problem, preserve independent case privacy

POST `/api/patients/[id]/problems` requires the existing documentation capability and current patient scope. Optional clinical-case links are checked and locked inside that patient, with independent ortho visibility. The original writer and audit are atomic on the admitted connection. Existing GET now masks a linked orthodontic case ID/title without that independent read grant and refuses invalid foreign references in its owning snapshot. Original problem facts and legacy routes remain preserved. No assignment, money or migration; no automatic resend or durable receipt. See [the acceptance matrix](../../review/work-problem-create-slice45-20261101.md). Final combined gates and independent review remain pending.

### Slice 46 — cephalometric correction draft

POST `/api/ceph/[id]/duplicate` requires current analysis authority, its existing imaging-read prerequisite and patient scope. It preserves the approved source, historical copy rules and one-draft constraint, with locked same-patient references and atomic canonical audit. The new draft contains copied landmarks/calibration, no copied approved results or diagnosis. Legacy remains unchanged, including its existing post-commit audit. No automatic replay or durable receipt; see [the acceptance matrix](../../review/work-ceph-copy-slice46-20261101.md). Editing, approval and rejection are separate pending contracts.

### Slice 47 — observed cephalometric draft discard

DELETE `/api/ceph/[id]` uses existing analysis authority and patient scope. The saved draft receives an opaque version of its parent and saved child rows, inside the existing RR snapshot; completed payloads are unchanged and older versionless payloads remain read-only. A fresh explicit intent must match that version after patient/source/reference/child locks. Original draft-only soft-discard and note rules remain; all saved history stays in place. Canonical effect and audit are atomic. The original legacy post-commit audit remains, with a separately reproduced failed-transaction cleanup defect repaired. List-level pending recovery persists after a draft disappears, never treats 404 as a specific request receipt, and never automatically resends. No approved-history, image, financial or migration change. Source conversion is not final acceptance.

### Slice 48 — saved routine followup agreement coverage

GET `/api/ortho/[id]/followup-coverage` requires independent `finance.agreements.manage` and patient scope. All authority, activation, saved decision and current commercial source checks use one owning RR read-only connection. Original source SQL, validity, site rules and fingerprints are shared unchanged with compatibility workflows. The full candidate context is bounded at 256 rows / 2 MiB; excess refuses without a partial applicability answer. Decision text and provenance are explicit fields; invoice names/references require independent `finance.invoices.view`. No commercial snapshot, totals, clinical detail, receipt or edit grant is projected. POST/PUT and signed proof are unchanged. On-demand read-only UI clears on refresh/hide/revocation and ignores closed-response completions; it is available in the clinical case only when both existing clinical visibility and the independent agreement grant permit it. This does not add a financial-only navigation screen or activate the writer.

### Slice 49 — pending treatment proposal summaries

GET `/api/plans/proposals` uses its mapped plan-edit authority and patient scope without legacy role fallback. Scope precedes the oldest 300-row limit; hasMore describes only the admitted scope. Current settings, proposal state, contact timing and authority use one RR snapshot. Money uses the existing independent patient-ledger projection. No care notes, item names, invoice details, dispatch choices or audit note text are returned. The canonical recall panel is read-only, clears stale data and retains the established RTL identity. No manual contact or outbound command is activated in this slice. [Acceptance and bounds](../../review/work-plan-proposals-slice49-20261101.md).

### Slice 50 — record an already completed proposal contact

POST `/api/plans/proposals` is an audit-only manual record under current plan-edit authority and patient scope. It never dispatches a message. The canonical writer locks the patient and same legacy plan, rechecks authority after waits, compares an opaque plan/contact observation and invokes the retained writer on the same transaction. Effect/audit rollback together; consent, amounts and installment reminder stamps remain unchanged. List-level pending recovery survives proposal disappearance and never automatically resends. No permanent receipt is claimed; fresh state and a new explicit intention are required after uncertainty. [Acceptance and limitations](../../review/work-proposal-contact-slice50-20261101.md).

### Slice 51 — saved pending orthodontic review queue

GET `/api/ortho/billing-decisions` uses its approved ortho-view capability and central patient scope in one owning RR snapshot. The bounded summary reads existing saved pending states; it does not infer absent coverage, dispatch work or grant a clinical/financial decision. Own scope precedes the oldest-300 plus hasMore limit; foreign or patient-unlinked visit references, invalid clinician references and oversized context refuse the whole read. The read-only UI omits visits, amounts, invoice references, notes and decision controls, and clears stale/failed/hidden responses. All legacy reads and decision writers are unchanged. [Acceptance and boundaries](../../review/work-ortho-decisions-slice51-20261101.md).

### Slice 52 — existing pending orthodontic decision command

POST `/api/ortho/adjustments/[id]/billing-decision` retains its approved independent branches: `clinical.ortho.edit` plus native responsibility/protected ownership for no_charge, or `finance.invoices.create` for linking an existing same-patient non-cancelled invoice. Both require current patient scope. The minimal queue adds only an opaque observed version and same-snapshot permitted choices, never invoice details or a reusable grant. The command checks fresh authority after patient-lock waits, stable adjustment/case/visit/invoice witnesses, unchanged original decision/audit writer, one transaction and final authority. The list-level editor never automatically resends an uncertain result; a disappeared row is not a receipt. No new price, coverage rule, invoice, migration or money movement. Local 48–52 acceptance passed 14,528 full unit and 5,264 full PG cases plus final built HTTP/runtime gates; exact-head CI and review remain separate. canonical-done describes source conversion, not deployment or whole-system completion.

### Slice 53 — explicit draft edits and structured diagnosis

PATCH `/api/ceph/[id]` uses the existing analysis capability with patient scope and the same saved draft observation. All requested calibration, known landmark upsert and diagnosis groups are validated before effects and share the admitted transaction with their original ceph.update audit events. Same-patient references and child observations remain locked; session and scope are rechecked after waits and before commit. Approved/discarded history and saved measurements are not rewritten. Unknown historical codes remain intact; an owned unavailable image retains its existing semantics without any image bytes or new retention rule. The existing 256-row / 2 MiB readable-study budget is enforced after edits, with full rollback instead of leaving an unreadable draft. UI covers explicit structured draft diagnosis only. Image tracing and interactive calibration/landmark editing, and final clinical approval, remain separate contracts. No automatic retry or durable receipt is claimed. Local final gates are pending; this is source conversion only.

### Slice 55 — native orthodontic lifecycle branches (partial PATCH)

`PATCH /api/ortho/[id]` admits phase, retainer and completed/discontinued operations under `clinical.ortho.edit` and current patient scope. Strict one-operation bodies carry an opaque observation of the native case. Patient then native-case locks, scope/session revalidation after waits, existing same-connection state writers and atomic `ortho.case_update` audit preserve the original rules. A recorded `none` retainer choice remains valid; null is not a completion decision. Closed cases cannot reopen. The independent `planId` financial branch remains held, so the method stays `existing` and ordinary conversion counts remain 75 / 269.

An acknowledged edit refreshes the summary. Unknown results never resend automatically; fresh-state review is not a durable receipt. A responsible clinician whose only patient relationship was the now-closed case does not retain access from that closed relationship. No assignment or financial side effect creates a new grant.


### Slice 56 — immutable assessment append and shared history budget

`POST /api/ortho/[id]/assessment` independently requires `clinical.ortho.edit` (including its central view prerequisite) and current patient scope. Strict schema-2 commands reuse the existing command ID, fingerprint, calculator, copy verification, immutable INSERT and atomic audit. The actual canonical identity is supplied on the admitted connection; no legacy session is fabricated. Every historical and proposed source retains independent imaging/care capabilities and same-patient ownership, including receipt replay. Patient serialization, sorted source locks, NOWAIT positive-membership/case/bridge locks and post-wait/final authority checks protect concurrent commands.

The shared legacy/canonical append now rejects a final history above the original 5000 revisions / 8 MiB budget in the same transaction. A real legacy failing witness is retained; no reader limit is raised and no history is removed. The GET projection adds only an edit-capability preview. It remains read-only with incomplete/empty source choices and the accepted historical-source policy.

The existing assessment editor and parent-owned command protocol are reused on the canonical patient page. Draft bytes stay in memory across list/detail refresh; an uncertain response can be reconciled only by explicit replay of the same immutable request. They are not persisted across reload, and universal SPA-back navigation interception is not claimed. Schema-1 promotion, new bridges, source picker, strategy writes, financial changes and migrations remain separate. Local focused evidence and full gates are recorded in the slice report; source conversion is not deployment acceptance.


### Slice 57 — immutable strategy command, separate from editor admission

`POST /api/ortho/[id]/strategy` requires the existing ortho-edit grant and patient scope, and independently requires plan view/edit when adding, retaining or removing plan links. Replay of link removal still checks the original predecessor authority. The native command fingerprint, same-actor receipt, binding engine, clinical snapshots and atomic audit are shared with legacy on the admitted connection. Patient waiting is followed by fresh authority/scope; secondary plan, item, problem and case/bridge locks use NOWAIT to refuse inverse contention. Foreign live references expose only unavailable state alongside already-authorized authored history, never foreign current content.

Canonical commands obey the accepted reader's 5000-revision / 8 MiB and 128-reference limits, including a final aggregate admission check after INSERT. The default GET, its independent plan projection and reference-only UI are unchanged. Legacy strategy resource policy remains unchanged; its larger histories can remain adoption blockers for the canonical reader. The following editor contract must explicitly request bounded editing choices and reuse the existing draft protocol. Local focused evidence: 71 distinct PG cases across70/3 then27/1 runs,36 unit/map cases,25 built HTTP/Chromium cases in4files, typecheck/build/targeted lint. Full exact-head gates and review are not inferred from this contract.

### Slice 58 — explicit strategy editing view

Default `GET /api/ortho/[id]/strategy` remains the slice32 reference contract. `edit=1` requires the central ortho edit grant inside the same fenced RR read snapshot. It returns only existing bridge-owned problem choices, and plan-item choices only with independent plan view AND edit. The complete combined choice set is capped at128 with an explicit refusal, not truncation; the default reader remains available. History bounds and source/financial redaction remain unchanged. Current status is retained without changing binding rules or clinical meaning.

The canonical UI explicitly opens editing and reuses the native legacy draft/mutation transitions through a small adapter. Parent reads retire response ownership while preserving exact in-memory draft/receipt bytes. Lost/late responses and the15-second canonical write timeout require explicit identical retry; no automatic resend or reload-persistence guarantee. Reference-only users retain their reader. No problem creation, bridge creation, plan writer, finance, migration or legacy authority change. Full evidence and acceptance are recorded separately from implemented route counts.

The slice 58 command receipt can affirm an actually empty stored plan-link set after existing authorization and binding checks, enabling the unchanged strict native matcher. This does not grant plan visibility, unmask nonempty links or alter the default GET/legacy projection. Detail-view cleanup invalidates late mutation ownership without discarding the exact parent-owned draft.

### Slice 59 — open a new empty cephalometric study (server contract)

POST `/api/patients/[id]/ceph` uses mapped `clinical.xrays.upload` with its existing view prerequisite and current patient scope. It shares native image/case checks and the original INSERT on the admitted transaction. Patient serialization precedes fresh scope and NOWAIT owned reference locks; the actual actor's ceph.create audit is atomic and final authority is rechecked. No measurements, diagnosis, file publication, treatment attribution or finance is created. The legacy route and post-commit legacy audit remain; no claim that all legacy writes became atomic.

A current draft refuses, including concurrent native writers under the existing unique constraint. This is not a permanent receipt after a later closure; clients must review unknown outcomes and obtain a new explicit intention. Duplicate warning is a same-patient count, not an unbounded list of study identities. The image picker and actual create control remain a separate contract. Implementation status is not acceptance; local HTTP/full gates, CI and review are recorded separately.

### Slice 60 — explicit new-study choices and pending-review UI

The explicit create=1 read requires upload authority inside the existing scoped RR patient read. Minimal image metadata is paged by id in100-row pages with an honest next cursor; no file URL/bytes, storage key, note or global inventory total. Cases are identities only under independent ortho.view, complete up to300; reference names/keys complete up to200. Same-snapshot draft existence and per-image previous-study counts aid a new explicit intention. Default saved summary and legacy branches remain unchanged.

The canonical form uses the established pending-review mechanism for non-idempotent ceph creation: synchronous send latch, minimal marker, bounded request, no automatic resend, fresh current-study check and explicit new intention after uncertainty. The form stays mounted at the patient list owner so section close/refresh cannot lose an in-memory pending marker when storage is unavailable. Choice and check results carry their originating list view; stale responses cannot restore a retired view. No reload guarantee without storage, file upload, tracing/image render or clinical approval is claimed. Validation is ongoing; this note does not declare acceptance.

The optional ortho link is gated on the server by the same fresh `clinical.ortho.view`, not just hidden in the chooser. A failing real-PG witness proved the missing guard before correction. Active reference choices are explicit; the native built-in default is offered only for an empty active catalogue. Empty drafts and all historical stored values remain unchanged.

### Slice 61 — exact durable followup-coverage status

PUT `/api/ortho/[id]/followup-coverage?patientId=…` is an explicit status lookup under mapped `finance.agreements.manage` and current patient scope. It shares the native actor-bound request fingerprint and immutable receipt semantics. Command-lock waiting is followed by fresh authority, current positive ownership and same-patient case locks; final proof is checked before return. A missing receipt is unresolved, never rejection or permission for a replacement request.

A bounded native receipt reader projects only the actor's exact command outcome; no financial source snapshot, invoice amounts, other actor receipt, mutation or audit write. Each row is refused above16KiB before unbounded Node materialization; exact native recovery matchers check the projected result. This command uses an owning READ COMMITTED transaction for its fences and locks; it is not described as RR or SQL READ ONLY. Legacy GET/POST/PUT behavior is retained. POST decision writer and editor remain separate. Conversion status is not CI/review or release acceptance.


### Slice 62 — explicit durable followup-coverage decision

POST `/api/ortho/[id]/followup-coverage?patientId=…` admits the mapped agreement capability and current patient scope on one owning transaction. The native immutable receipt/fingerprint, source validity, included/excluded policy and atomic audit are retained. Command-lock waits are followed by current authority; source parent ownership is checked before child locks. A terminal business refusal commits with its audit; authority/infrastructure failures roll back. Identical requests replay exactly once; altered identity conflicts. No money, prior signed-proof, migration, implicit activation or editor change. [Acceptance and limits](../../review/work-ortho-coverage-command-slice62-20261101.md).

Slice 63 adds an explicit coverage editor read context and the shared durable editor; it adds no method count. Independent invoice/plan/ortho visibility, current scope and fresh source identity remain required. Local in-memory draft retention and exact journal recovery have separate evidence in the slice report.

### Slice 64 — complete the existing case/plan link branch

The `planId` branch of PATCH `/api/ortho/[id]` independently requires plan view and edit in addition to clinical ortho edit and current patient scope, including unlink and no-op requests. The native link writer is extracted without changing its body or the legacy wrapper. Patient then case locks and sorted same-patient plan parent locks preserve current scope and source identity. A stale case observation, terminal case, cancelled target, missing/foreign source, lost authority or inverse lock refuses without effects. The native awaited audit commits atomically; finance and signed history stay unchanged. Only `{ok,caseId,changed}` is returned.

This completes the method's source conversion; the separate context/chooser UI is not implemented in64. A changed link invalidates the old case version but is not a durable receipt. Exact-head CI, independent review and broader release gates remain separate. [Evidence and limitations](../../review/work-ortho-plan-link-slice64-20261101.md).
