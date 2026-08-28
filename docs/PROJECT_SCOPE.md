# Aqlan Center Mini — MVP Scope

## Product objective
A lightweight clinic operations system for **مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان** that reduces missed follow-ups and gives staff a reliable daily workflow.

## MVP success criteria
The first usable version must support this end-to-end flow with real database persistence:

1. Staff user logs in.
2. Reception creates or finds a patient.
3. Reception creates an appointment.
4. Today's screen shows the appointment.
5. Patient is marked Arrived / In Treatment / Completed.
6. Doctor records a visit.
7. A next appointment or recall due date is recorded.
8. Overdue and no-next-appointment patients appear in Follow-up.
9. Staff can log contact attempts and reschedule.

## Must-have modules
### Authentication
Roles initially:
- ADMIN
- DOCTOR
- RECEPTION

### Patients
Core fields:
- id
- fileNumber
- fullName
- gender
- dateOfBirth (nullable)
- mobile
- alternateMobile (nullable)
- address (nullable)
- treatingDoctorId (nullable)
- treatmentType (nullable)
- treatmentStatus
- recallIntervalDays
- active
- notes (nullable)
- createdAt
- updatedAt

### Appointments
Statuses:
- SCHEDULED
- CONFIRMED
- ARRIVED
- IN_TREATMENT
- COMPLETED
- CANCELLED
- NO_SHOW

### Visits
A visit should capture the treatment performed, clinical notes, next-visit plan, and optional next appointment date.

### Today
Operational view for:
- Today's appointments
- Arrived/waiting
- In treatment
- Completed
- No-show
- Patients needing follow-up today

### Follow-up / Recall
Queues:
- Due today
- Due soon
- Overdue
- No next appointment
- Missed appointments

### Contact tracking
Contact methods:
- PHONE
- WHATSAPP
- IN_PERSON
- OTHER

Results:
- CONTACTED
- NO_ANSWER
- RESCHEDULED
- WILL_CALL_BACK
- CANCELLED
- OTHER

## Daily operations & finance module (added 2026-08, owner-approved)
Expanded on the stable MVP core (see docs/FINANCE_DESIGN.md for the full data model):

- **Services catalog** — admin-managed services + editable categories (bilingual names, default price/currency, commission flags).
- **Visit work items** — multiple structured items per visit (service, doctor, qty, price, discount, server-computed total); `treatmentPerformed` stays free-text.
- **Treasury** — cash/bank accounts, one currency each; balances always derived from voucher rows.
- **Vouchers** — numbered receipt (RCPT-YYYY-NNNNNN) and payment (PV-YYYY-NNNNNN) vouchers; append-only after creation; corrections via linked reversal entries with mandatory reason; idempotency keys against double-submits.
- **Doctor commissions** — per-doctor / per-service plans (percent or fixed, work-value or collected basis), snapshotted at generation; PENDING → APPROVED → PAID (payment voucher) / REVERSED.
- **Labs** — labs directory, lab cases linked to patient/visit/doctor/service, case invoicing, payments via vouchers, per-lab balances.
- **Suppliers & materials** — directories, multi-line purchase invoices (server-computed totals), payments via vouchers, per-supplier balances. No stock levels yet (tables designed so inventory can be added later).
- **Reports** — daily closing (opening/net/closing per account, per currency & payment method, legacy collections shown separately), daily work report, period financial report, patient/doctor/lab/supplier statements, voucher registers.
- **Printing** — standalone print pages: A5 vouchers with clinic identity + signature rows, A4 statements/reports; RTL-correct; reprint logged in audit (no sensitive data).

Financial invariants: currencies never mixed; numeric(12,2) in PostgreSQL + integer minor-unit math; every movement + its audit row in ONE transaction; reports derive from real rows, never stored totals.

## Later, not MVP-critical
- Full inventory / stock movements / warehouses
- Cephalometry
- AI features
- Patient portal
- Native Android apps
- Advanced notifications

## Technical constraints
- Independent PostgreSQL database on Railway (dedicated project, never shared).
- No connection to the production `aqlan-dental` database.
- Next.js + TypeScript, deployed on Railway (web + PostgreSQL in one project).
- Arabic default with RTL; English with LTR.
- `Asia/Aden` timezone.
- Responsive/mobile-first.
- No real patient data in development, CI, seeds, or preview environments.

## Release rule
Do not claim the MVP is ready until the critical patient → appointment → visit → recall workflow has been tested end-to-end against persistent storage.
