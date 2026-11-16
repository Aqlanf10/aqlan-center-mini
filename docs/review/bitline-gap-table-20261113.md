# BitLine screens — gap table (request 6837184113)

Date: 2026-11-13. Source: the three public gallery images named in the request (17 clinical visit, 4 patient
file, 13 waiting list). They are used as a pattern reference only: no assets, text, names or data are copied.
The people's names shown in those images are not repeated here.

Every "exists" row cites the file where the pattern already lives on the integration branch
(`feat/claude-integration-finance-ortho-20261112`). A row says "missing" only when a code search found no
equivalent. Nothing in this table is implemented yet; implementation waits for the owner to pick rows.

Status key: **exists** · **needs improvement** (present but weaker than the pattern) · **missing**.

## Image 17 — clinical visit

| # | Pattern in the image | Our system | Status | Evidence |
|---|---|---|---|---|
| 17.1 | Medical-history warning on the visit itself ("not reviewed with the patient yet") | Medical alerts and the "time to update the history" reminder are shown only in the patient file's history panel; the visit screen shows neither | **missing** | `components/MedicalHistoryPanel.tsx` (alerts, review reminder); no history or alert reference in `components/ClinicalVisit.tsx` |
| 17.2 | Patient strip on the visit: age, sex, file number, visit type, appointment time, minutes since the visit started | Visit header shows the patient's name, the visit number and the save state only | **needs improvement** | `components/ClinicalVisit.tsx` header block ("زيارة مفتوحة — …") |
| 17.3 | Save state in the header ("no changes") + save draft + finish visit | "تعديلات غير محفوظة" / current-read state, leave-page confirmation, review-and-sign step | **exists** | `components/ClinicalVisit.tsx` (dirty state, `window.confirm` on leave, sign step) |
| 17.4 | Section progress chips (complaint / exam / diagnosis-and-plan done) | Step strip with done marks; a separate reduced strip for ortho follow-up and return visits | **exists** | `components/ClinicalVisit.tsx` `VisitSteps` |
| 17.5 | Quick phrase chips under each note | Phrase chips per note field | **exists** | `components/ClinicalVisit.tsx` (`phrases.chiefComplaint`, `phrases.diagnosis`, …) |
| 17.6 | Character count per note | Length limit is enforced; no visible running count per field | **needs improvement** | note fields in `components/ClinicalVisit.tsx` |
| 17.7 | Launch tiles from the visit: chart, treatment plan, ortho, finance file | Ortho entry and procedures are inside the visit; chart, plan and finance are reached from the patient file, not from the visit | **needs improvement** | `components/ClinicalVisit.tsx` (`orthodonticEntry`, procedures), `app/patients/[id]/page.tsx` |
| 17.8 | Prescription from the visit | Prescription and patient-instructions buttons on the visit header | **exists** | `components/ClinicalVisit.tsx` (`setRxOpen`, `setPostOpOpen`) |
| 17.9 | X-ray request from the visit | No imaging-request workflow; images are uploaded as documents | **missing** | no request entity or screen found; uploads in `components/PatientDocuments.tsx` |

## Image 4 — patient file

| # | Pattern in the image | Our system | Status | Evidence |
|---|---|---|---|---|
| 4.1 | Header actions: print, ortho, finance file, book appointment, edit | Patient file header and tabs carry these actions | **exists** | `app/patients/[id]/page.tsx`, print dossier `app/print/dossier/[id]/page.tsx` |
| 4.2 | Summary cards: visits, completed procedures, paid, due, remaining plan cost | Visit count, remaining planned sessions, ledger balance and approved-agreement paid/remaining (finance-permitted users only); no "completed procedures" count card | **needs improvement** | `components/patient/SummaryTab.tsx` (`إجمالي الزيارات`, `الجلسات المتبقّية`, `المتبقي من الاتفاق المعتمد`) |
| 4.3 | Tabs: basic data, sessions and prescriptions, chart, current plan, x-rays, family | Equivalent tabs exist (treatment, ortho, documents, families) | **exists** | `app/patients/[id]/page.tsx`, families on the canonical runtime |
| 4.4 | Interactive 3D tooth model with view buttons | 2D dental chart only | **missing** — not proposed: no clinical need shown; the 2D chart is the recorded source | dental chart components |

Our patient file deliberately shows money only to finance-permitted roles and separates the ledger balance
from agreement and installment remainders. A single "due" card like the image's must keep that separation.

## Image 13 — waiting list

| # | Pattern in the image | Our system | Status | Evidence |
|---|---|---|---|---|
| 13.1 | Day header with date and a waiting-room display button | "اليوم" header; display screen at `/display` | **exists** | `app/page.tsx`, `app/display/page.tsx` |
| 13.2 | Count cards: total, waiting, in visit, completed | Eight counters: waiting, called, in chair, done, remaining appointments, late, no-show, cancelled | **exists** (richer) | `app/page.tsx` "عدّادات اليوم" |
| 13.3 | Day completion progress bar | No completion percentage | **missing** (low value; the counters carry the same facts) | `app/page.tsx` |
| 13.4 | Status filter chips with counts | Status filter buttons plus doctor and chair filters; counts are in the counter row, not on the chips | **needs improvement** (counts on chips) | `app/page.tsx` "مرشّحات اليوم" |
| 13.5 | Per-patient queue number (#3, #4) | No queue number; order is by arrival time with minutes waited | **missing** | no queue-number field found |
| 13.6 | Call button with a megaphone, start visit, continue visit | Call to a chair, re-call with minutes since the call, enter chair, open visit | **exists** | `app/page.tsx` (CHAIR-1 readiness gate, "إعادة النداء") |
| 13.7 | "Not arrived yet" rows with a check-in button | Expected-today section with arrival and late flags; check-in at `/checkin` | **exists** | `app/page.tsx` "مُنتظَرو اليوم", `app/checkin/page.tsx` |

## Proposed order if the owner approves (no code before approval)

1. 17.1: the medical-history warning on the visit. It is a safety gap, and the data already exists. The visit
   would read the same derived alerts the history panel uses. This needs no schema change.
2. 17.2: the patient strip on the visit (age, file number, minutes since start). This is read-only.
3. 13.4 and 13.5: counts on the filter chips and a daily queue number. The queue number needs a decision on
   who assigns it and when it resets, so it needs a spec first.
4. 17.9: an X-ray request. This is a new workflow (request → capture → attach) and needs a spec and an owner
   decision.

Items 4.4 and 13.3 are listed for completeness and are not proposed.
