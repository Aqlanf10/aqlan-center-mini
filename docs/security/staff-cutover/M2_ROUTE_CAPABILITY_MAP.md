# M2 — route → capability map, for review

Status: **proposal**. This is the first M2 deliverable required by `M1_ENTRY_SLICE_DESIGN.md` §6 ("M2 proposes a per-route capability map for review"). Nothing here grants anything or activates a route.

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
| existing | 197 |
| proposed | 142 |
| owner-only | 20 |
| excluded | 12 |
| entry | 4 |
| self | 3 |
| canonical-done | 5 |

| Record scope | Routes |
|---|---|
| patient | 149 |
| appointment | 11 |

## 2. Proposed capability names (decision needed: owner, with Dot's review)

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

**Proposed owner-only operations** (never delegable):
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

