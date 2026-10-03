"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { useSession } from "@/components/SessionProvider";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { canDoctorViewCostPrices, canDoctorViewClinicProfits } from "@/lib/doctor-permissions";
import { isRestrictedRole } from "@/lib/role-routes";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { createPatientNavigation, patientDestination, readPatientLocation, type PatientLocation } from "@/lib/patient-navigation";
import { focusDestination, focusFitsLocation, isPatientRecordFocus, patientRecordFocusKey, readPatientRecordFocus, type PatientFocusRead, type PatientRecordFocus } from "@/lib/patient-workspace-focus";
import { WORKSPACE_SECTIONS, workspaceSection, type WorkspaceSection } from "@/lib/patient-workspace-navigation";
import { usePatientWorkspace } from "./usePatientWorkspace";
import { usePatientReadiness } from "./usePatientReadiness";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { WorkspaceSectionContent } from "./WorkspaceSections";
import { WorkspaceDialogs, type WorkspaceAction } from "./WorkspaceDialogs";
import styles from "./workspace.module.css";

const focusReadKey = (value: PatientFocusRead) => value.status === "valid" ? patientRecordFocusKey(value.focus) : value.status;

/** Authority is part of the cache/draft identity, just like patient identity. */
export function PatientWorkspace({ id }: { id: string }) {
  const session = useSession();
  if (!session) return <main className={styles.workspace} dir="rtl"><div className={styles.loading}>جارٍ التحقق من الجلسة…</div></main>;
  if (isRestrictedRole(session.role)) return <main className={styles.workspace} dir="rtl"><div className={styles.notice}>الملف السريري غير متاح لهذا الدور. <a href="/finance">افتح المالية</a></div></main>;
  const authorityKey = `${session.username}:${session.role}:${JSON.stringify(session.permissions ?? {})}`;
  return <PatientWorkspaceContext key={`${id}:${authorityKey}`} id={id} authorityKey={authorityKey} session={session} />;
}

function PatientWorkspaceContext({ id, authorityKey, session }: { id: string; authorityKey: string; session: NonNullable<ReturnType<typeof useSession>> }) {
  const data = usePatientWorkspace(id);
  const { file, summary, reload, confirmMedicalAlert } = data;
  const [location, setLocation] = useState<PatientLocation>(() => readPatientLocation(typeof window === "undefined" ? "" : window.location.search));
  const [focusRead, setFocusRead] = useState<PatientFocusRead>(() => readPatientRecordFocus(typeof window === "undefined" ? "" : window.location.search, Number(id)));
  const active = workspaceSection(location);
  const [visited, setVisited] = useState<WorkspaceSection[]>([active]);
  const [action, setAction] = useState<WorkspaceAction | null>(null);
  const [structuredRefreshKey, setStructuredRefreshKey] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigation = useRef<ReturnType<typeof createPatientNavigation> | null>(null);
  const endoGuard = useRef<(() => boolean) | null>(null);
  const endoDraft = useRef(false);
  const perioGuard = useRef<(() => boolean) | null>(null);
  const perioDraft = useRef(false);
  const filesDraft = useRef(false);
  const filesGuard = useRef<(() => boolean) | null>(null);
  const casesGuard = useRef<(() => boolean) | null>(null);
  const todayGuard = useRef<(() => boolean) | null>(null);
  const plansGuard = useRef<(() => boolean) | null>(null);
  const consentGuard = useRef<(() => boolean) | null>(null);
  const consentDraft = useRef(false);
  const admin = isAdmin(session.role);
  const canWrite = admin || session.role === "doctor";
  const canOperate = admin || session.role === "reception" || session.role === "doctor";
  const canEditPatient = admin || session.role === "reception" || (session.role === "doctor" && session.permissions?.canEditPatient !== false);
  const canEditPlans = admin || session.permissions?.canEditPlans === true;
  const canViewPlans = summary?.planVisible === true && !(session.role === "doctor" && session.permissions?.canViewPlans === false);
  const canViewAccount = summary?.canSeeFinancial === true;
  const canViewProfitability = admin || (session.role === "doctor" && canDoctorViewCostPrices(session.permissions, session.role) && canDoctorViewClinicProfits(session.permissions, session.role));
  const canCollect = canHandleMoney(session.role) && canViewAccount;
  const onChanged = useCallback(() => { void reload(); }, [reload]);
  // Refresh saved structured records without remounting or reloading Today drafts.
  // Ordinary summary reads never advance this token.
  const refreshStructuredRecords = useCallback(() => {
    setStructuredRefreshKey((revision) => revision + 1);
    void reload();
  }, [reload]);
  const readiness = usePatientReadiness({ patientId: Number(id), patientName: file?.patient.fullName ?? "", patientPhone: file?.patient.phone ?? null,
    fallbackAlert: file?.patient.medicalAlert ?? null, summary, onChanged, confirmedAlert: data.confirmedAlert });
  const trackEndoDraft = useCallback((pending: boolean) => { endoDraft.current = pending; }, []);
  const trackEndoGuard = useCallback((guard: (() => boolean) | null) => { endoGuard.current = guard; }, []);

  const trackPerioDraft = useCallback((pending: boolean) => { perioDraft.current = pending; }, []);
  const trackPerioGuard = useCallback((guard: (() => boolean) | null) => { perioGuard.current = guard; }, []);
  const trackFilesDraft = useCallback((pending: boolean) => { filesDraft.current = pending; }, []);
  const trackFilesGuard = useCallback((guard: (() => boolean) | null) => { filesGuard.current = guard; }, []);
  const trackCasesGuard = useCallback((guard: (() => boolean) | null) => { casesGuard.current = guard; }, []);
  const trackTodayGuard = useCallback((guard: (() => boolean) | null) => { todayGuard.current = guard; }, []);
  const trackPlansGuard = useCallback((guard: (() => boolean) | null) => { plansGuard.current = guard; }, []);
  const trackConsentGuard = useCallback((guard: (() => boolean) | null) => { consentGuard.current = guard; }, []);
  const trackConsentDraft = useCallback((pending: boolean) => { consentDraft.current = pending; }, []);
  const openAction = useCallback((next: WorkspaceAction) => {
    if (consentGuard.current ? !consentGuard.current() : consentDraft.current) return;
    setAction(next);
  }, [setAction]);
  useEffect(() => {
    const controller = createPatientNavigation(window, {
      canLeave: () => {
        if (consentGuard.current ? !consentGuard.current() : consentDraft.current) return false;
        const current = workspaceSection(readPatientLocation(window.location.search));
        if (current === "endo") return endoGuard.current ? endoGuard.current() : !endoDraft.current || window.confirm("هناك عمل علاج جذور غير محفوظ. هل تريد تجاهله؟");
        if (current === "perio") return perioGuard.current ? perioGuard.current() : !perioDraft.current;
        if (current === "files") return filesGuard.current ? filesGuard.current() : !filesDraft.current;
        if (current === "cases") return casesGuard.current?.() ?? true;
        if (current === "today") return todayGuard.current?.() ?? true;
        if (current === "plans") return plansGuard.current?.() ?? true;
        return true;
      },
      onChange: (next) => {
        const target = workspaceSection(next);
        setLocation(next);
        const nextFocus = readPatientRecordFocus(window.location.search, Number(id));
        setFocusRead((previous) => focusReadKey(previous) === focusReadKey(nextFocus) ? previous : nextFocus);
        // These specialty guards confirm discard; accepted leave must unmount their drafts.
        setVisited((previous) => [...new Set([...previous.filter((section) => !["endo", "perio"].includes(section) || target === section), target])]);
      },
    });
    navigation.current = controller;
    if (session.role === "assistant" && readPatientLocation(window.location.search).tab === "summary") {
      controller.navigate(patientDestination("today", readPatientLocation(window.location.search)));
    }
    return () => { navigation.current = null; };
  }, [session.role, id]);
  const goTo = useCallback((target: string) => {
    const next = patientDestination(target, readPatientLocation(window.location.search));
    const before = window.location.href;
    if (navigation.current?.navigate(next, null) && window.location.href !== before) { setAction(null); setActionError(null); }
  }, [setAction, setActionError]);
  const focusRecord = useCallback((focus: PatientRecordFocus) => {
    if (!isPatientRecordFocus(focus) || focus.patientId !== Number(id)) { setActionError("طلب عرض السجل غير صالح لهذا المريض."); return; }
    const before = window.location.href;
    if (navigation.current?.navigate(focusDestination(focus), focus) && window.location.href !== before) { setAction(null); setActionError(null); }
  }, [id, setAction, setActionError]);
  const medicalSaved = useCallback((value: string | null) => {
    confirmMedicalAlert(value);
    setMessage("تم حفظ التنبيه الطبي. تُحدّث بيانات الملف من مصدرها.");
    void reload();
  }, [confirmMedicalAlert, reload, setMessage]);

  // No hooks below this point: loading→ready and permission refresh keep hook order stable.
  if (!file) return <main className={styles.workspace} dir="rtl"><div className={data.error ? styles.error : styles.loading} role={data.error ? "alert" : "status"}>
    {data.error ?? "جارٍ تحميل ملف المريض…"}{data.error ? <button type="button" onClick={onChanged}>أعد المحاولة</button> : null}
  </div><a className={styles.button} href="/patients">العودة إلى المرضى</a></main>;
  const patient = file.patient;
  const sections = WORKSPACE_SECTIONS.map((section) => section.id).filter((section) => {
    if (section === "account") return canViewAccount;
    if (session.role === "assistant") return section === "today";
    if (section === "plans" && !canViewPlans) return false;
    if (section === "files" && session.role === "doctor" && session.permissions?.canViewXrays === false) return false;
    return true;
  });
  const current = WORKSPACE_SECTIONS.find((section) => section.id === active)!;
  const permitted = sections.includes(active);
  const coherentFocus = focusRead.status === "valid" && focusFitsLocation(focusRead.focus, location) ? focusRead.focus : null;
  const invalidFocus = focusRead.status !== "none" && coherentFocus === null;
  const today = summary?.today ?? clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  return <main className={styles.workspace} dir="rtl" data-testid="patient-workspace" data-patient-id={patient.id}>
    <div className={styles.breadcrumb}><a href="/patients">المرضى</a><ChevronLeft size={13} aria-hidden="true" /><span>ملف المريض</span><ChevronLeft size={13} aria-hidden="true" /><span>{patient.patientNumber}</span></div>
    <WorkspaceHeader patient={patient} today={today} readiness={readiness} canEdit={canEditPatient} canOperate={canOperate} onBook={() => openAction("book")} onNavigate={goTo} onVitals={() => openAction("vitals")} />
    {data.error ? <div role="alert" className={styles.error}>{data.error}<button type="button" onClick={onChanged}>إعادة المحاولة</button></div> : null}
    {data.summaryError ? <div role="alert" className={styles.notice}>{data.summaryError}<button type="button" onClick={onChanged}>إعادة المحاولة</button></div> : null}
    {actionError ? <div role="alert" className={styles.error}>{actionError}</div> : null}
    {message ? <div role="status" className={styles.notice}>{message}<button type="button" onClick={() => setMessage(null)}>إغلاق</button></div> : null}
    <div className={styles.layout}>
      <WorkspaceNavigation current={active} sections={sections} summary={summary} onNavigate={goTo} />
      <div className={styles.content}>
        <div className={styles.sectionHeading}>
          <div><p className={styles.eyebrow}>{current.eyebrow}</p><h2 id="workspace-section-heading">{current.label}</h2><p className={styles.description}>{current.description}</p></div>
          <div className={styles.actions}><span className={styles.context}>{patient.patientNumber}{summary?.openVisit ? ` · زيارة #${summary.openVisit.id}` : ""}</span><button type="button" className={styles.button} onClick={refreshStructuredRecords} disabled={data.loading} aria-label="تحديث ملف المريض"><RefreshCw size={14} className={data.loading ? "animate-spin" : ""} /></button></div>
        </div>
        {invalidFocus ? <div role="alert" data-testid="workspace-focus-invalid" className={styles.notice}>رابط السجل المحدد غير صالح لهذا المريض أو القسم؛ لم يُفتح سجل بديل. اختر قسمًا من القائمة للمتابعة.</div> : null}
        {!permitted ? <div role="status" className={styles.notice}>القسم المطلوب غير متاح ضمن الصلاحية الحالية أو لم يكتمل التحقق من إتاحته.</div> : null}
        {visited.filter((section) => sections.includes(section) && !(section === active && invalidFocus)).map((section) => <div key={section} hidden={active !== section} className={styles.sectionBody} aria-labelledby={active === section ? "workspace-section-heading" : undefined} data-workspace-section={section}>
          <WorkspaceSectionContent section={section} active={section === active} focus={coherentFocus} onFocus={focusRecord} file={file} summary={summary} authorityKey={authorityKey} canWrite={canWrite} isAdministrator={admin} canEditPatient={canEditPatient} canEditPlans={canEditPlans} canViewPlans={canViewPlans}
            canCollect={canCollect} canViewAccount={canViewAccount} canViewProfitability={canViewProfitability} timelineReadBoundary={data.readBoundary} prescriptionDialogOpen={action === "prescription"} onNavigate={goTo} onChanged={onChanged} structuredRefreshKey={structuredRefreshKey} onSpecialtyPersisted={refreshStructuredRecords} onAction={openAction} onPatientChange={data.updatePatient} onMedicalSaved={medicalSaved}
            onError={setActionError} onEndoDraft={trackEndoDraft} onEndoGuard={trackEndoGuard} onFilesDraft={trackFilesDraft} onFilesGuard={trackFilesGuard} onCasesGuard={trackCasesGuard} onPlansGuard={trackPlansGuard} onTodayGuard={trackTodayGuard} onPerioDraft={trackPerioDraft} onPerioGuard={trackPerioGuard} />
        </div>)}
      </div>
    </div>
    <WorkspaceDialogs authorityKey={authorityKey} onConsentDraft={trackConsentDraft} onConsentGuard={trackConsentGuard} action={action} patient={patient} openVisitId={summary?.openVisit?.id ?? null} canWrite={canWrite} canEditPatient={canEditPatient} canViewProfitability={canViewProfitability} onClose={() => setAction(null)} onChanged={onChanged} onMedicalSaved={medicalSaved} />
  </main>;
}
