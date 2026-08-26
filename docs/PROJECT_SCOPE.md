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

## Later, not MVP-critical
- Advanced accounting
- Inventory
- Laboratory workflows
- Cephalometry
- AI features
- Patient portal
- Native Android apps
- Advanced notifications

## Technical constraints
- Independent Neon PostgreSQL database.
- No connection to the production `aqlan-dental` database.
- Next.js + TypeScript + Vercel-compatible architecture.
- Arabic default with RTL; English with LTR.
- `Asia/Aden` timezone.
- Responsive/mobile-first.
- No real patient data in development, CI, seeds, or preview environments.

## Release rule
Do not claim the MVP is ready until the critical patient → appointment → visit → recall workflow has been tested end-to-end against persistent storage.
