"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Patient } from "@/lib/patient";
import type { Visit } from "@/lib/flow";
import type { Appointment } from "@/lib/schedule";
import type { WorkflowSummary } from "@/components/patient/SummaryTab";
import { workflowCalendar, workflowCalendarAlertVisible } from "@/lib/patient-workflow-calendar";
import { workflowDocuments } from "@/lib/patient-workflow-documents";
import { readPatientAppointmentVisibility, type PatientAppointmentReadVisibility } from "@/lib/appointment-read-scope";

export interface PatientWorkspaceFile {
  patient: Patient; visits: Visit[]; appointments: Appointment[];
  /** Optional only for legacy callers; absence never grants calendar visibility. */
  appointmentVisibility?: PatientAppointmentReadVisibility;
}
export interface WorkspaceSummary extends WorkflowSummary { today?: string }

// Match the workflow route's least-authority projection when narrowing an
// already accepted snapshot. Keep clinical visit identity stable while its peer
// read is pending, but never retain plan amounts or alerts behind a revoked flag.
const CLINICAL_ALERT_KINDS = new Set(["unscheduled_visit", "lab_open", "plan_ready", "plan_blocked", "case_waiting", "referral_blocker", "referral_returned", "active_problems"]);
const NON_PLAN_ALERT_KINDS = new Set(["lab_open", "case_waiting", "referral_blocker", "referral_returned", "active_problems"]);
type WorkflowFinancial = NonNullable<WorkspaceSummary["financial"]>;
function withoutPlanAmounts(row: WorkflowFinancial) {
  return { balanceMinor: row.balanceMinor, invoicedMinor: row.invoicedMinor, paidMinor: row.paidMinor, openingMinor: row.openingMinor,
    agreedMinor: null, treatmentDoneMinor: null, remainingTreatmentMinor: null, agreementPaidMinor: null, agreementRemainingMinor: null };
}
function projectWorkflow(snapshot: WorkspaceSummary, planVisible: boolean, canSeeFinancial: boolean,
  appointmentVisibility = readPatientAppointmentVisibility(snapshot.appointmentVisibility),
  documentsVisible = workflowDocuments(snapshot).documentsVisible,
): WorkspaceSummary {
  const documents = workflowDocuments({ ...snapshot, documentsVisible });
  const calendar = workflowCalendar({ ...snapshot, appointmentVisibility });
  const financial = !canSeeFinancial || !snapshot.financial ? null : planVisible ? snapshot.financial : {
    ...withoutPlanAmounts(snapshot.financial),
    ...(snapshot.financial.byCurrency ? { byCurrency: Object.fromEntries(Object.entries(snapshot.financial.byCurrency)
      .map(([currency, row]) => [currency, withoutPlanAmounts(row)])) as WorkflowFinancial["byCurrency"] } : {}),
  };
  return { today: snapshot.today, planVisible, canSeeFinancial,
    openVisit: !planVisible && snapshot.openVisit ? { ...snapshot.openVisit, plannedTitle: null } : snapshot.openVisit,
    lastVisit: snapshot.lastVisit, nextAppointment: calendar.nextAppointment,
    counts: { ...snapshot.counts, documents: documents.documents }, documentsVisible: documents.documentsVisible,
    appointmentVisibility: calendar.appointmentVisibility,
    activePlans: !planVisible ? [] : canSeeFinancial ? snapshot.activePlans : snapshot.activePlans.map((plan) => ({
      id: plan.id, title: plan.title, specialty: plan.specialty, primaryDoctorName: plan.primaryDoctorName,
      consentAt: plan.consentAt, itemsCount: plan.itemsCount, doneItems: plan.doneItems,
      totalMinor: null, doneMinor: null, remainingMinor: null, overdueMinor: null, nextDueDate: null, financialVisible: false,
    })),
    plannedVisits: planVisible ? calendar.plannedVisits : [], financial,
    alerts: Array.isArray(snapshot.alerts) ? snapshot.alerts.filter((alert) =>
      (canSeeFinancial || CLINICAL_ALERT_KINDS.has(alert.kind)) && (planVisible || NON_PLAN_ALERT_KINDS.has(alert.kind))
      && workflowCalendarAlertVisible(alert.kind, calendar.appointmentVisibility)) : [],
  };
}

/** Reads the two canonical patient endpoints; owns no clinical or financial state. */
export function usePatientWorkspace(id: string) {
  const [file, setFile] = useState<PatientWorkspaceFile | null>(null);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // Child read invalidation follows this existing two-peer sequence. This is
  // readiness only, never an authority grant; each child route rechecks access.
  const [readBoundary, setReadBoundary] = useState({ revision: 0, ready: false });
  const [confirmedAlert, setConfirmedAlert] = useState<{ revision: number; value: string | null }>();
  const sequence = useRef(0);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    if (!mounted.current) return;
    const current = ++sequence.current;
    setReadBoundary({ revision: current, ready: false });
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    const active = () => mounted.current && current === sequence.current && !controller.signal.aborted;
    // Header denials revoke their own cached projection immediately. The other
    // endpoint (or its JSON body) may never settle; it cannot delay revocation.
    const workflowRead = (async (): Promise<WorkspaceSummary | null> => {
      try {
        const response = await fetch(`/api/patients/${id}/workflow`, { cache: "no-store", signal: controller.signal });
        if (!active()) return null;
        if ([401, 403, 404].includes(response.status)) {
          setSummary(null);
          setSummaryError("ملخص المريض غير متاح ضمن الوصول الحالي. أعد التحقق قبل المتابعة.");
          return null;
        }
        const payload = await response.json().catch(() => null);
        if (!active()) return null;
        if (!response.ok || !payload?.counts || !Array.isArray(payload.activePlans) || !Array.isArray(payload.plannedVisits)) {
          setSummary(null);
          setSummaryError(payload?.message ?? "الملخص غير متاح الآن؛ لا تُعرض قيم تقديرية.");
          return null;
        }
        const workflow = projectWorkflow(payload as WorkspaceSummary, payload.planVisible === true, payload.canSeeFinancial === true);
        // Calendar scopes do not carry row evidence for a cached snapshot. Even
        // scoped -> scoped can change the readable provider/ownership set. Revoke
        // its identities immediately while the peer patient headers/body wait;
        // only publish this new positive projection after that peer validates.
        setSummary((previous) => active() && previous ? projectWorkflow(previous,
          previous.planVisible === true && workflow.planVisible,
          previous.canSeeFinancial === true && workflow.canSeeFinancial,
          workflow.appointmentVisibility === "hidden" ? "hidden" : "unknown",
          // New denied/unknown document authority revokes the old count before
          // the patient peer settles. A positive grant still needs both reads.
          previous.documentsVisible === false || workflow.documentsVisible === false ? false
            : previous.documentsVisible === true && workflow.documentsVisible === true && workflow.counts.documents !== null ? true : null) : previous);
        return workflow;
      } catch {
        if (active()) {
          setSummary(null);
          setSummaryError("تعذّر تحديث ملخص المريض.");
        }
        return null;
      }
    })();
    try {
      const patientResponse = await fetch(`/api/patients/${id}`, { cache: "no-store", signal: controller.signal });
      if (!active()) return;
      if ([401, 403, 404].includes(patientResponse.status)) {
        // Fence both requests before any later success/body can restore the file.
        ++sequence.current;
        controller.abort();
        setFile(null); setSummary(null); setSummaryError(null);
        setError("ملف المريض غير متاح ضمن الوصول الحالي. أعد التحقق قبل المتابعة.");
        setLoading(false);
        return;
      }
      const patientPayload = await patientResponse.json().catch(() => null);
      if (!active()) return;
      if (!patientResponse.ok) throw new Error(patientPayload?.message ?? "تعذّر تحميل ملف المريض.");
      if (String(patientPayload?.patient?.id) !== id || !Array.isArray(patientPayload?.visits) || !Array.isArray(patientPayload?.appointments)) {
        setFile(null); setSummary(null);
        throw new Error("استجابة ملف المريض غير مكتملة. أعد التحميل.");
      }
      const appointmentVisibility = readPatientAppointmentVisibility(patientPayload.appointmentVisibility);
      const calendarReadable = appointmentVisibility === "all" || appointmentVisibility === "scoped";
      setFile({
        patient: patientPayload.patient,
        visits: calendarReadable ? patientPayload.visits : patientPayload.visits.map((visit: Visit) => ({ ...visit, appointmentId: null })),
        appointments: calendarReadable ? patientPayload.appointments : [],
        appointmentVisibility,
      });
      // The peer calendar policy can narrow independently while workflow is
      // still pending. Revoke cached summary identities; never derive a positive
      // workflow grant or a no-appointment claim from the file's list/row count.
      setSummary((previous) => active() && previous ? projectWorkflow(previous,
        previous.planVisible === true, previous.canSeeFinancial === true,
        appointmentVisibility === "hidden" ? "hidden" : "unknown") : previous);
      // This accepted GET started after any local save (saves invalidate sequence).
      // Advance, never reset, the confirmed generation when another staff member
      // changes the alert. With no today visit there is no readiness snapshot to
      // supersede it; a pre-GET readiness response must not restore the old text.
      const returnedAlert = typeof patientPayload.patient.medicalAlert === "string" || patientPayload.patient.medicalAlert === null
        ? patientPayload.patient.medicalAlert as string | null : undefined;
      if (returnedAlert !== undefined) setConfirmedAlert((previous) => previous && previous.value !== returnedAlert
        ? { revision: previous.revision + 1, value: returnedAlert } : previous);
      setError(null);
      const workflow = await workflowRead;
      if (!active() || !workflow) return;
      const workflowVisibility = readPatientAppointmentVisibility(workflow.appointmentVisibility);
      // Hidden/unknown peer authority cannot restore a broader successful read.
      // An all -> scoped mismatch needs fresh row evidence, not relabeling all rows.
      const acceptedVisibility = appointmentVisibility === "hidden" || appointmentVisibility === "unknown"
        ? appointmentVisibility
        : appointmentVisibility === "scoped" && workflowVisibility === "all" ? "unknown" : workflowVisibility;
      setSummary(projectWorkflow(workflow, workflow.planVisible === true, workflow.canSeeFinancial === true, acceptedVisibility));
      setSummaryError(null);
      setReadBoundary({ revision: current, ready: true });
    } catch (failure) {
      if (!active()) return;
      setError(failure instanceof Error ? failure.message : "تعذّر الاتصال بالخادم.");
      // Failed reads never retain stale financial privileges or balances.
      setSummary(null);
    } finally {
      if (active()) setLoading(false);
    }
  }, [id]);

  const invalidateRequests = useCallback(() => { mounted.current = false; ++sequence.current; request.current?.abort(); }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const refresh = () => { if (document.visibilityState === "visible") void reload(); };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => { invalidateRequests(); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [reload, invalidateRequests]);

  const updatePatient = useCallback((patient: Patient) => {
    if (String(patient.id) !== id) return;
    // A pre-save request cannot overwrite the newly confirmed patient snapshot.
    ++sequence.current; request.current?.abort();
    setReadBoundary({ revision: sequence.current, ready: false });
    setLoading(false);
    setFile((previous) => previous ? { ...previous, patient } : previous);
  }, [id]);
  const confirmMedicalAlert = useCallback((value: string | null) => {
    ++sequence.current; request.current?.abort();
    setReadBoundary({ revision: sequence.current, ready: false });
    setLoading(false);
    setFile((previous) => previous ? { ...previous, patient: { ...previous.patient, medicalAlert: value } } : previous);
    setConfirmedAlert((previous) => ({ revision: (previous?.revision ?? 0) + 1, value }));
  }, []);
  return { file, summary, loading, error, summaryError, readBoundary, confirmedAlert, reload, updatePatient, confirmMedicalAlert };
}
