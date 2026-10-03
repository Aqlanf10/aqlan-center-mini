"use client";

import type { ComponentProps } from "react";
import { FileText, Pill, Printer, ShieldCheck, Stethoscope } from "lucide-react";
import { DentalChart } from "@/components/DentalChart";
import { PatientPlans } from "@/components/PatientPlans";
import { PatientCases } from "@/components/PatientCases";
import { PatientEndo } from "@/components/PatientEndo";
import { PatientOrtho } from "@/components/PatientOrtho";
import { PatientDocuments } from "@/components/PatientDocuments";
import { PatientLabOrders } from "@/components/PatientLabOrders";
import { PatientReferrals } from "@/components/PatientReferrals";
import { PatientMaterials } from "@/components/PatientMaterials";
import { PatientLedger } from "@/components/PatientLedger";
import { LegacyHistory } from "@/components/LegacyHistory";
import { MedicalHistoryPanel } from "@/components/MedicalHistoryPanel";
import { PatientContactPanel } from "@/components/PatientContactPanel";
import { PatientFamilyPanel } from "@/components/PatientFamilyPanel";
import { TodayVisitTab } from "@/components/patient/TodayVisitTab";
import { PatientTimeline } from "@/components/patient/PatientTimeline";
import { PatientSpecialtyDirectory } from "@/components/patient-specialties/PatientSpecialtyDirectory";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import type { Patient } from "@/lib/patient";
import type { PatientRecordFocus } from "@/lib/patient-workspace-focus";
import type { WorkspaceSection } from "@/lib/patient-workspace-navigation";
import { PatientAdministration } from "./PatientAdministration";
import { PatientIdentityEditor } from "./PatientIdentityEditor";
import { PatientPrescriptionHistory } from "./PatientPrescriptionHistory";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { WorkspacePeriodontics } from "./WorkspacePeriodontics";
import type { PatientWorkspaceFile, WorkspaceSummary } from "./usePatientWorkspace";
import type { WorkspaceAction } from "./WorkspaceDialogs";
import styles from "./workspace.module.css";

export function WorkspaceSectionContent({ section, active, focus, onFocus, file, summary, authorityKey, canWrite, isAdministrator, canEditPatient, canEditPlans, canViewPlans, canCollect, canViewAccount, canViewProfitability, onNavigate, onChanged, timelineReadBoundary, prescriptionDialogOpen = false, structuredRefreshKey = 0, onSpecialtyPersisted, onAction, onPatientChange, onMedicalSaved, onError, onEndoDraft, onEndoGuard, onFilesDraft, onFilesGuard, onCasesGuard, onPlansGuard, onTodayGuard, onPerioDraft, onPerioGuard }: {
  section: WorkspaceSection; active: boolean; focus?: PatientRecordFocus | null; onFocus?: (focus: PatientRecordFocus) => void; file: PatientWorkspaceFile; summary: WorkspaceSummary | null;
  authorityKey: string; canWrite: boolean; isAdministrator: boolean; canEditPatient: boolean; canEditPlans: boolean; canViewPlans: boolean; canCollect: boolean; canViewAccount: boolean; canViewProfitability: boolean;
  timelineReadBoundary?: { revision: number; ready: boolean };
  prescriptionDialogOpen?: boolean;
  structuredRefreshKey?: number | string; onSpecialtyPersisted?: () => void;
  onNavigate: (target: string) => void; onChanged: () => void; onAction: (action: WorkspaceAction) => void;
  onPatientChange: (patient: Patient) => void; onMedicalSaved: (value: string | null) => void;
  onError: (message: string | null) => void; onEndoDraft: (pending: boolean) => void;
  onPerioDraft?: (pending: boolean) => void;
  onPerioGuard?: (guard: (() => boolean) | null) => void;
  onFilesDraft?: (pending: boolean) => void;
  onFilesGuard?: (guard: (() => boolean) | null) => void;
  onCasesGuard?: (guard: (() => boolean) | null) => void;
  onPlansGuard?: (guard: (() => boolean) | null) => void;
  onTodayGuard?: (guard: (() => boolean) | null) => void;
  onEndoGuard: NonNullable<ComponentProps<typeof PatientEndo>["onNavigationGuardChange"]>;
}) {
  const { patient } = file;
  switch (section) {
    case "summary": return <WorkspaceOverview patient={patient} summary={summary} onNavigate={onNavigate} onChanged={onChanged} />;
    case "today": return <TodayVisitTab patientId={patient.id} patientName={patient.fullName} summary={summary} base={CLINIC_BASE_CURRENCY} visits={file.visits}
      workFocus={focus?.kind === "visit_work" ? focus : null} onNavigationGuardChange={onTodayGuard} canCollect={canCollect} structuredRefreshKey={structuredRefreshKey} onVisitStarted={onChanged} onChanged={onChanged} onOpenTabletMode={() => onAction("tablet")} />;
    case "plans": return <PatientPlans patientId={patient.id} openVisitId={summary?.openVisit?.id ?? null} onFocus={onFocus} focus={focus?.kind === "plan_item" ? focus : null} onNavigationGuardChange={onPlansGuard} />;
    case "specialties": return <PatientSpecialtyDirectory patientId={patient.id} authorityKey={authorityKey} canViewPlans={canViewPlans} openVisitId={summary?.openVisit?.id ?? null} onNavigate={onNavigate} onFocus={onFocus} active={active} />;
    case "cases": return <PatientCases patientId={patient.id} canWrite={canWrite} focus={focus?.kind === "case" ? focus : null} onNavigationGuardChange={onCasesGuard} />;
    case "chart": return <DentalChart patientId={patient.id} onOpenPeriodontics={() => onNavigate("perio")} />;
    case "endo": return <PatientEndo patientId={patient.id} authorityKey={authorityKey} canWrite={canWrite} canEditPlans={canEditPlans}
      openVisitId={summary?.openVisit?.id ?? null} onPersisted={onSpecialtyPersisted} onDraftChange={onEndoDraft} onNavigationGuardChange={onEndoGuard}
      onReviewWork={onFocus} onOpenToday={() => onNavigate("today")} onOpenPlans={() => onNavigate("plans")} onOpenAccount={canViewAccount ? () => onNavigate("account") : undefined} />;
    case "perio": return <WorkspacePeriodontics patientId={patient.id} patientName={patient.fullName} authorityKey={authorityKey} editable={canWrite}
      summary={summary} structuredRefreshKey={structuredRefreshKey} onRefresh={onChanged} onPersisted={onSpecialtyPersisted}
      onDraftChange={onPerioDraft} onNavigationGuardChange={onPerioGuard} />;
    case "ortho": return <PatientOrtho patientId={patient.id} />;
    case "files": return <div className={styles.stack}>
      <PatientDocuments visits={file.visits} authorityKey={authorityKey} onDraftChange={onFilesDraft} onNavigationGuardChange={onFilesGuard} patientId={patient.id} patientName={patient.fullName} patientPhone={patient.phone} photoDocumentId={patient.photoDocumentId ?? null} onPhotoChange={canEditPatient ? onPatientChange : undefined} />
      <div className={styles.panel}><h3 className={styles.panelTitle}>دراسات السيفالومتري</h3><p className={styles.muted}>تُدار الدراسات من حالة التقويم الأصلية، مع صلاحيات الصور والسجلات نفسها</p><button className={styles.softButton} type="button" onClick={() => onNavigate("ortho")}>افتح التقويم والسيفالو</button></div>
    </div>;
    case "lab": return <PatientLabOrders patientId={patient.id} patientName={patient.fullName} base={CLINIC_BASE_CURRENCY} />;
    case "referrals": return <PatientReferrals patientId={patient.id} canIssue={canWrite} appointments={file.appointments} appointmentVisibility={file.appointmentVisibility} />;
    case "materials": return <PatientMaterials patientId={patient.id} visits={file.visits.map((visit) => ({ id: visit.id, arrivedAt: visit.arrivedAt }))} />;
    case "account": return canViewAccount ? <div className={styles.stack}><PatientLedger patientId={patient.id} /><LegacyHistory patientId={patient.id} /></div> : <PermissionNotice />;
    case "timeline": return <PatientTimeline patientId={patient.id} base={CLINIC_BASE_CURRENCY} authorityKey={authorityKey}
      refreshKey={timelineReadBoundary?.revision ?? 0} readable={timelineReadBoundary?.ready === true} onRefresh={onChanged} />;
    case "identity": return <div className={styles.stack}>
      <MedicalHistoryPanel patientId={patient.id} />
      {canEditPatient ? <details className={styles.disclosure}><summary>تعديل البيانات الأساسية والتنبيه الطبي</summary><div><PatientIdentityEditor patient={patient} onSaved={(updated) => { onPatientChange(updated); onMedicalSaved(updated.medicalAlert); }} onError={onError} /></div></details> : null}
      <PatientContactPanel patient={patient} canEdit={canEditPatient} onPatientChange={onPatientChange} />
      <PatientFamilyPanel patientId={patient.id} patientName={patient.fullName} patientPhone={patient.phone} />
      {isAdministrator ? <PatientAdministration file={file} onError={onError} /> : null}
    </div>;
    case "prescriptions": return <div className={styles.stack}>
      <div className={styles.notice}>تُحفظ الوصفة بهوية المُصدر التي يتحقق منها الخادم. راجع المريض والتنبيهات والجرعة قبل الإصدار؛ لا يُستنتج الطبيب المعالج من اسم المستخدم الحالي.</div>
      <div className={styles.cards}>
        {canWrite ? <button type="button" className={styles.linkCard} onClick={() => onAction("prescription")}><span className={styles.cardIcon}><Pill size={22} /></span><span><h3>وصفة دوائية</h3><p className={styles.muted}>النموذج المحفوظ وفحوص السلامة الدوائية المعتمدة</p></span></button> : null}
        <button type="button" className={styles.linkCard} onClick={() => onAction("consent")}><span className={styles.cardIcon}><ShieldCheck size={22} /></span><span><h3>موافقة علاجية</h3><p className={styles.muted}>الموافقة والتوقيع المرتبطان بملف المريض</p></span></button>
        <button type="button" className={styles.linkCard} onClick={() => onAction("postop")}><span className={styles.cardIcon}><FileText size={22} /></span><span><h3>تعليمات ما بعد العلاج</h3><p className={styles.muted}>إرشادات الإجراء من النموذج الحالي</p></span></button>
        <button type="button" className={styles.linkCard} onClick={() => onNavigate("referrals")}><span className={styles.cardIcon}><Stethoscope size={22} /></span><span><h3>إحالة إلى أخصائي</h3><p className={styles.muted}>الجهة المستقبلة والموعد ونتيجة الإحالة</p></span></button>
      </div>
      {canWrite ? <PatientPrescriptionHistory patientId={patient.id} authorityKey={authorityKey} canRead={canWrite} active={active}
        readRevision={timelineReadBoundary?.revision ?? 0} readable={timelineReadBoundary?.ready === true} prescriptionDialogOpen={prescriptionDialogOpen} /> : <PermissionNotice />}
    </div>;
    case "reports": return <div className={styles.stack}>
      {canViewProfitability ? <div className={styles.panel}><h3 className={styles.panelTitle}>محاكاة ربحية الحالة</h3><p className={styles.muted}>أداة تقديرية منفصلة عن الحساب والسجل السريري؛ تبدأ دون إجراءات مفترضة</p><button type="button" className={styles.button} onClick={() => onAction("profitability")}>فتح المحاكاة التقديرية</button></div> : null}
      <div className={styles.cards}>
        <a className={styles.linkCard} href={`/print/dossier/${patient.id}`} target="_blank" rel="noopener noreferrer"><span className={styles.cardIcon}><Printer size={22} /></span><span><h3>ملخص سريري للمريض</h3><p className={styles.muted}>البيانات والتنبيهات والمخطط وأحدث الزيارات وعلاج الجذور؛ الأقسام غير المكتملة موضّحة داخل التقرير</p></span></a>
        <a className={styles.linkCard} href={`/print/patient-card/${patient.id}`} target="_blank" rel="noopener noreferrer"><span className={styles.cardIcon}><FileText size={22} /></span><span><h3>بطاقة المريض</h3><p className={styles.muted}>اسم المريض ورقم الملف وبيانات البطاقة</p></span></a>
        {canViewAccount ? <a className={styles.linkCard} href={`/print/statement/${patient.id}`} target="_blank" rel="noopener noreferrer"><span className={styles.cardIcon}><Printer size={22} /></span><span><h3>كشف الحساب</h3><p className={styles.muted}>حركات وأرصدة كل عملة من الدفتر الأصلي</p></span></a> : null}
      </div>
      <p className={styles.muted}>تُفتح التقارير في نافذة مستقلة. تقارير الحالة والجلسة متاحة داخل مساحتها الأصلية مع سياق السجل نفسه.</p>
    </div>;
  }
}
function PermissionNotice() { return <div className={styles.panel} role="status"><h3 className={styles.panelTitle}>هذا القسم غير متاح لهذه الصلاحية</h3><p className={styles.muted}>لا يتم تحميل بيانات القسم أو افتراض أرصدته</p></div>; }
