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
- **`canonical-done`** — already migrated: the procurement route in M3a.

### Unchanged business rules that still apply
Cashier shift for money movements, treasury balance rule, signed-visit addenda, capacity override. They are listed in each entry's `note`.

### Counts (383 held routes)

| Status | Routes |
|---|---|
| existing | 200 |
| proposed | 142 |
| owner-only | 20 |
| excluded | 12 |
| entry | 4 |
| self | 3 |
| canonical-done | 2 |

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
