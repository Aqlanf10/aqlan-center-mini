"use client";

import { ArrowUpLeft, CalendarDays, ClipboardList, History, Wallet } from "lucide-react";
import type { Patient } from "@/lib/patient";
import { CURRENCIES, CLINIC_BASE_CURRENCY, formatMoney } from "@/lib/money";
import type { WorkspaceSummary } from "./usePatientWorkspace";
import { workflowAppointmentEmptyText, workflowCalendar, workflowCalendarAlertVisible } from "@/lib/patient-workflow-calendar";
import styles from "./workspace.module.css";

/** NEW RECONSTRUCTION: summary projections only, never a second clinical/financial writer. */
export function WorkspaceOverview({ patient, summary, onNavigate, onChanged }: {
  patient: Patient; summary: WorkspaceSummary | null; onNavigate: (target: string) => void; onChanged: () => void;
}) {
  if (!summary) return <section className={styles.panel} aria-label="ملخص المريض غير متاح"><h3 className={styles.panelTitle}>الملخص غير متاح الآن</h3><p className={styles.muted}>تعذّر تأكيد الموعد والخطط والأرصدة. لن تُعرض قيم تقديرية.</p><button type="button" className={styles.button} onClick={onChanged}>إعادة تحميل الملخص</button></section>;
  const calendar = workflowCalendar(summary);
  const next = calendar.nextAppointment;
  const alerts = summary.alerts.filter((alert) => workflowCalendarAlertVisible(alert.kind, calendar.appointmentVisibility));
  const plansVisible = summary.planVisible === true;
  const plan = plansVisible ? summary.activePlans[0] : undefined;
  const financial = summary.canSeeFinancial === true ? summary.financial : null;
  const balances = financial ? financial.byCurrency
    ? CURRENCIES.flatMap((currency) => financial.byCurrency?.[currency] && Number.isSafeInteger(financial.byCurrency[currency].balanceMinor)
      ? [{ currency, balance: financial.byCurrency[currency].balanceMinor }] : [])
    : Number.isSafeInteger(financial.balanceMinor) ? [{ currency: CLINIC_BASE_CURRENCY, balance: financial.balanceMinor }] : [] : [];
  return <div className={styles.stack} data-testid="workspace-overview">
    <section className={styles.overviewHero}>
      <div><p className={styles.eyebrow}>متابعة مترابطة</p><h3>{summary.openVisit ? "زيارة مفتوحة، وسجل واحد" : "الخطوة التالية واضحة"}</h3><p>{summary.openVisit ? `زيارة #${summary.openVisit.id} مرتبطة بملف ${patient.patientNumber}. أكمل توثيقها من زيارة اليوم.` : "راجع الموعد والخطة، ثم افتح مساحة العمل المناسبة لهذا المريض."}</p></div>
      <button type="button" className={styles.primaryButton} onClick={() => onNavigate("today")}>{summary.openVisit ? "استكمال زيارة اليوم" : "فتح زيارة اليوم"}<ArrowUpLeft size={17} aria-hidden="true" /></button>
    </section>
    {alerts.length ? <ul className={styles.summaryAlerts}>{alerts.map((alert, index) => <li key={`${alert.kind}:${index}`} className={alert.severity === "danger" ? styles.error : styles.notice}>{alert.text}</li>)}</ul> : null}
    <div className={styles.cards}>
      <section className={styles.panel}><span className={styles.cardIcon}><CalendarDays size={22} aria-hidden="true" /></span><h3 className={styles.panelTitle}>{calendar.appointmentVisibility === "scoped" ? "الموعد القادم الظاهر" : "الموعد القادم"}</h3>
        {next ? <><p className={styles.metric}><bdi>{next.date}</bdi> · <bdi>{next.time}</bdi></p><p className={styles.muted}>{next.durationMinutes} دقيقة{next.note ? ` · ${next.note}` : ""}</p></> : <p className={styles.emptyCopy}>{workflowAppointmentEmptyText(calendar.appointmentVisibility)}</p>}
        <button type="button" className={styles.textButton} onClick={() => onNavigate("today")}>فتح متابعة الزيارة<ArrowUpLeft size={16} aria-hidden="true" /></button>
      </section>
      <section className={styles.panel}><span className={styles.cardIcon}><ClipboardList size={22} aria-hidden="true" /></span><h3 className={styles.panelTitle}>الخطة العلاجية</h3>
        {!plansVisible ? <p className={styles.emptyCopy}>تفاصيل الخطط غير متاحة ضمن القراءة الحالية</p> : plan ? <><p className={styles.metric}>{plan.title}</p><p className={styles.muted}>{plan.doneItems} من {plan.itemsCount} بند مكتمل{plan.primaryDoctorName ? ` · ${plan.primaryDoctorName}` : ""}</p></> : <p className={styles.emptyCopy}>لا توجد خطة نشطة في الملخص</p>}
        {plansVisible ? <button type="button" className={styles.textButton} onClick={() => onNavigate("plans")}>مراجعة الخطط<ArrowUpLeft size={16} aria-hidden="true" /></button> : null}
      </section>
      <section className={styles.panel}><span className={styles.cardIcon}><History size={22} aria-hidden="true" /></span><h3 className={styles.panelTitle}>آخر زيارة موثّقة</h3>
        {summary.lastVisit ? <><p className={styles.metric}><bdi>{summary.lastVisit.date}</bdi></p><p className={styles.muted}>{summary.lastVisit.treatmentDone || summary.lastVisit.proceduresSummary || "لا يوجد ملخص علاج في هذه القراءة"}</p></> : <p className={styles.emptyCopy}>لا توجد زيارة سابقة في الملخص</p>}
        <button type="button" className={styles.textButton} onClick={() => onNavigate("timeline")}>فتح الخط الزمني<ArrowUpLeft size={16} aria-hidden="true" /></button>
      </section>
      <section className={styles.panel}><span className={styles.cardIcon}><Wallet size={22} aria-hidden="true" /></span><h3 className={styles.panelTitle}>حساب المريض</h3>
        {balances.length ? <ul className={styles.balanceList}>{balances.map(({ currency, balance }) => <li key={currency}><span>الرصيد · {currency}</span><bdi>{formatMoney(balance, currency)}</bdi></li>)}</ul> : <p className={styles.emptyCopy}>{summary.canSeeFinancial ? "لم تُحمّل أرصدة مؤكّدة" : "البيانات المالية غير متاحة لهذه القراءة"}</p>}
        {summary.canSeeFinancial === true ? <button type="button" className={styles.textButton} onClick={() => onNavigate("account")}>الحساب والدفعات<ArrowUpLeft size={16} aria-hidden="true" /></button> : null}
      </section>
    </div>
    <section className={styles.panel}><div className={styles.panelHeading}><div><p className={styles.eyebrow}>السجل في متناولك</p><h3 className={styles.panelTitle}>انتقل إلى العمل المطلوب</h3></div><span className={styles.context}>رقم الملف <bdi>{patient.patientNumber}</bdi></span></div>
      <div className={styles.quickLinks}>{[["specialties", "التخصصات والحالات"], ["chart", "المخطط السني"], ["files", "الأشعة والملفات"], ["reports", "التقارير والطباعة"]].map(([target, label]) => <button type="button" key={target} className={styles.button} onClick={() => onNavigate(target)}>{label}<ArrowUpLeft size={16} aria-hidden="true" /></button>)}</div>
    </section>
  </div>;
}
