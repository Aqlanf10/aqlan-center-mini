"use client";

import { useState } from "react";
import type { ClinicalProgressView } from "@/lib/historical-clinical-projection";
import { HistoricalClinicalNote } from "../HistoricalClinicalNote";
import type { AssessmentCase, LegacyCase } from "@/lib/patient-workflow-cases";
import { ReceiptCorrectionLauncher } from "@/components/ReceiptCorrectionLauncher";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import { friendlyDate, friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { getAppointmentTypeLabel } from "@/lib/schedule";
import { PLANNED_VISIT_STATUS_LABEL, type PlannedVisitStatus } from "@/lib/workflow";
import { CollectPaymentModal } from "../CollectPaymentModal";
import { PortalInviteRow } from "../PortalInviteRow";
import { PatientTimeline } from "./PatientTimeline";
import { PatientIntakeHistory } from "./PatientIntakeHistory";
import { PatientPremiumAccountOverview } from "./PatientPremiumAccountOverview";
import styles from "./PatientOverview.module.css";
import { Icon } from "../Icon";

/**
 * تبويب الملخص — «ما وضع هذا المريض، وما المطلوب مني الآن؟» (المواصفة §٥).
 *
 * يجيب فورًا: الموعد القادم، وآخر زيارة، والخطة النشطة وتقدّمها، والجلسة التالية،
 * والحساب **للمخوّل ماليًا فقط** (الملخص يصله بلا أرصدة من الخادم أصلًا)، والتنبيهات.
 * ومن هنا تُجدول الجلسة المخطَّطة (تاريخٌ ووقت فقط) ويُفتح التحصيل الموحَّد.
 */

export interface WorkflowSummary {
  openVisit: { id: number; status: string; chair: number | null; arrivedAt: string; plannedTitle: string | null } | null;
  lastVisit: { id: number; date: string; treatmentDone: string | null; proceduresSummary: string | null; nextPlan: string | null } | null;
  nextAppointment: {
    id: number; date: string; time: string; durationMinutes: number;
    appointmentType: string | null; note: string | null; status: string;
  } | null;
  activePlans: {
    id: number; title: string; specialty: string | null; primaryDoctorName: string | null;
    consentAt: string | null; itemsCount: number; doneItems: number;
    totalMinor: number; doneMinor: number; remainingMinor: number;
    nextDueDate: string | null; overdueMinor: number;
    /* (TD-05) عملة اتفاق الخطة. */
    baseCurrency?: "YER" | "SAR" | "USD";
    clinicalProgress?: ClinicalProgressView;
  }[];
  plannedVisits: {
    id: number; planTitle: string | null; sequence: number; title: string;
    doctorName: string | null; durationMinutes: number; status: PlannedVisitStatus;
    appointmentDate: string | null; appointmentTime: string | null; note: string | null;
  }[];
  counts: { visits: number; openLabOrders: number; documents: number; orthoCase: boolean };
  /** (INV-LINK D) حالاتٌ فتحتها فاتورة علاجية وتنتظر تقييم الطبيب. */
  assessmentCases?: AssessmentCase[];
  legacyCases?: LegacyCase[];
  financial: {
    balanceMinor: number; invoicedMinor: number; paidMinor: number; openingMinor: number;
    agreedMinor: number; treatmentDoneMinor: number; remainingTreatmentMinor: number;
    clinicalProgress?: ClinicalProgressView;
    agreementPaidMinor?: number; agreementRemainingMinor?: number;
    /* (TD-05) نفس الحقول لكل عملةٍ ذات نشاط — المفرد هو دلو العملة الأساسية. */
    byCurrency?: Record<"YER" | "SAR" | "USD", {
      balanceMinor: number; invoicedMinor: number; paidMinor: number; openingMinor: number;
      agreedMinor: number; treatmentDoneMinor: number; remainingTreatmentMinor: number;
      clinicalProgress?: ClinicalProgressView;
      agreementPaidMinor?: number; agreementRemainingMinor?: number;
    }>;
  } | null;
  alerts: { kind: string; severity: "info" | "warning" | "danger"; text: string }[];
  canSeeFinancial: boolean;
}

const SEVERITY_STYLE: Record<string, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-800",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  danger: "border-red-300 bg-red-50 text-red-700",
};

export function SummaryTab({
  summary,
  patientId,
  patientName,
  patientNumber,
  patientPhone,
  base,
  onVisitStarted,
  onChanged,
  onGoToTab,
  workflowIsCurrent,
}: {
  summary: WorkflowSummary;
  workflowIsCurrent?: () => boolean;
  patientId: number;
  patientName: string;
  /** رقم الملف — مفتاح بوّابة المريض نصفه، وبطاقته المطبوعة تحمله كاملًا. */
  patientNumber: string;
  patientPhone: string | null;
  base: Currency;
  onVisitStarted: () => void;
  onChanged: () => void;
  onGoToTab: (tab: string) => void;
}) {
  const [scheduleFor, setScheduleFor] = useState<number | null>(null);
  const [scheduleDate, setScheduleDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  });
  const [scheduleTime, setScheduleTime] = useState("16:00");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const financial = summary.canSeeFinancial ? summary.financial : null;
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const primaryPlan = summary.activePlans.find(plan => plan.id === selectedPlanId) ?? summary.activePlans[0] ?? null;
  const progress = primaryPlan && primaryPlan.itemsCount > 0 && !primaryPlan.clinicalProgress?.historicalItems ? Math.min(100, Math.round(primaryPlan.doneItems / primaryPlan.itemsCount * 100)) : null;
  const nextPlanned = summary.plannedVisits.find((visit) => !visit.appointmentDate) ?? null;
  const scheduledNext = summary.plannedVisits.find((visit) => visit.appointmentDate) ?? null;

  const schedule = async (plannedVisitId: number) => {
    if (scheduleBusy || workflowIsCurrent?.() === false) return;
    setScheduleBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/planned-visits/${plannedVisitId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: scheduleDate, time: scheduleTime }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(payload?.message ?? "تعذّر حجز الجلسة.");
        return;
      }
      setScheduleFor(null);
      setMessage("تم حجز الجلسة القادمة — العلاج يُقرأ من الخطة بلا إعادة إدخال.");
      onChanged();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setScheduleBusy(false);
    }
  };

  const startPlannedVisit = async (plannedVisitId: number) => {
    if (scheduleBusy || workflowIsCurrent?.() === false) return;
    setScheduleBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plannedVisitId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(payload?.message ?? "تعذّر بدء الزيارة.");
        return;
      }
      onVisitStarted();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setScheduleBusy(false);
    }
  };

  return (
    <div className={styles.summary} data-testid="patient-executive-summary">
      {message ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800">
          {message}
        </p>
      ) : null}

      <PatientPremiumAccountOverview summary={summary} base={base} />
      {summary.alerts.length > 0 ? (
        <ul className={styles.alerts}>
          {summary.alerts.map((alert, index) => (
            <li key={index} className={`rounded-xl border px-3 py-2 text-xs font-bold ${SEVERITY_STYLE[alert.severity]}`}>
              {alert.text}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.workGrid} data-testid="summary-current-work">
        <section className={styles.card} aria-label="ملخص الحالة السريرية">
          <h2 className={styles.heading}><Icon name="clipboard" className="h-4 w-4" />ملخص الحالة السريرية</h2>
          <div className={styles.body}>
            <dl className={styles.facts}>
              <div><dt>الزيارات المسجلة</dt><dd>{summary.counts.visits}</dd></div>
              <div><dt>الخطط النشطة</dt><dd>{summary.activePlans.length}</dd></div>
              <div><dt>طلبات المعمل المفتوحة</dt><dd>{summary.counts.openLabOrders}</dd></div>
              <div><dt>الأشعة والمستندات</dt><dd>{summary.counts.documents}</dd></div>
              <div><dt>آخر زيارة</dt><dd>{summary.lastVisit ? friendlyDate(summary.lastVisit.date) : "لا زيارات سابقة"}</dd></div>
            </dl>
            <button type="button" className={`${styles.action} mt-3`} onClick={() => onGoToTab("chart")}>عرض مخطط الأسنان</button>
          </div>
        </section>
        <section className={styles.card} aria-label="تقدم الخطة المختارة">
          <h2 className={styles.heading}><Icon name="tooth" className="h-4 w-4" />خطة العلاج النشطة</h2>
          <div className={styles.body}>
            {summary.activePlans.length > 1 ? <label className={styles.planSelect}>الخطة المعروضة
              <select aria-label="الخطة المعروضة في الملخص" value={primaryPlan?.id ?? ""} onChange={event => setSelectedPlanId(Number(event.target.value))}>
                {summary.activePlans.map(plan => <option key={plan.id} value={plan.id}>{plan.title}</option>)}
              </select>
            </label> : null}
            <div className={styles.progress}>
              <div><p>{primaryPlan?.title ?? "لا خطة جارية"}</p><small>{primaryPlan?.primaryDoctorName ?? "لم يحدد طبيب الخطة"}</small>
                {primaryPlan ? <small>{primaryPlan.doneItems} من {primaryPlan.itemsCount} إجراءات مسجلة</small> : <small>أنشئ خطة من تبويب العلاج</small>}
              </div>
              {progress !== null ? <div className={styles.progressTrack} role="progressbar" aria-label="تقدم الخطة المعروضة" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className={styles.progressLabel}><span>نسبة الإجراءات المنفّذة</span><strong>{progress}%</strong></div><div className={styles.progressRail}><span style={{ width: `${progress}%` }} /></div></div> : null}
            </div>
            {primaryPlan?.clinicalProgress?.historicalItems ? <p className={styles.note}><HistoricalClinicalNote progress={primaryPlan.clinicalProgress} currency={primaryPlan.baseCurrency ?? base} /></p> : progress === null && primaryPlan ? <p className={styles.note}>لا تتوفر بنود كافية لحساب تقدم الخطة.</p> : null}
            {primaryPlan && !primaryPlan.consentAt ? <p className="my-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">موافقة العلاج لم تُسجّل</p> : null}
            <dl className={styles.facts}><div><dt>الجلسة التالية المخططة</dt><dd>{(nextPlanned ?? scheduledNext)?.title ?? "لا جلسة مخطَّطة"}</dd></div></dl>
            <button type="button" className={`${styles.action} ${styles.primary} mt-3`} onClick={() => onGoToTab("plans")}>عرض تفاصيل خطة العلاج</button>
          </div>
        </section>
        <section className={styles.card} aria-label="الإجراء القادم">
          <h2 className={styles.heading}><Icon name="calendar" className="h-4 w-4" />الإجراء القادم</h2>
          <div className={styles.body}>
            <p className="mb-1 text-xs font-bold text-slate-500">الموعد القادم</p>
            <p className="mb-3 text-sm font-bold">{summary.nextAppointment ? `${friendlyDate(summary.nextAppointment.date)} · ${friendlyTime(summary.nextAppointment.time)}` : "لا يوجد موعد قادم"}</p>
            {summary.nextAppointment ? <p className="mb-3 text-xs text-slate-500">{getAppointmentTypeLabel(summary.nextAppointment.appointmentType) ?? "زيارة"}</p> : null}
            <button type="button" className={`${styles.action} ${styles.orange}`} onClick={() => onGoToTab("today")}>{summary.openVisit ? "استكمال زيارة اليوم" : "فتح زيارة اليوم"}</button>
            <button type="button" className={styles.action} onClick={() => onGoToTab("ortho")} data-testid="summary-open-ortho">التقويم {summary.counts.orthoCase ? "· حالة قائمة" : ""}</button>
            <button type="button" className={styles.action} onClick={() => onGoToTab("files")}>الأشعة والمستندات</button>
          </div>
        </section>
      </div>
      {summary.lastVisit ? <section className={styles.card} aria-label="ملخص آخر زيارة"><h2 className={styles.heading}>آخر زيارة — {friendlyDateLong(summary.lastVisit.date)}</h2><p className={styles.body}>{summary.lastVisit.proceduresSummary ?? summary.lastVisit.treatmentDone ?? "زيارة كشف"}</p></section> : null}
      {/* جدولة الجلسة / بدؤها — تاريخ ووقت فقط، والعلاج من الخطة */}
      {summary.plannedVisits.length > 0 && !summary.openVisit ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card" aria-label="الجلسات المخطَّطة">
          <h3 className="mb-2 text-xs font-extrabold text-navy-900">
            الجلسات المخطَّطة ({summary.plannedVisits.length})
          </h3>
          <ul className="space-y-2">
            {summary.plannedVisits.map((visit) => (
              <li key={visit.id} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-navy-900">
                      {visit.title}
                      {visit.planTitle ? <span className="text-[11px] font-normal text-slate-500"> · {visit.planTitle}</span> : null}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {PLANNED_VISIT_STATUS_LABEL[visit.status]} · {visit.durationMinutes} دقيقة
                      {visit.doctorName ? ` · ${visit.doctorName}` : ""}
                      {visit.appointmentDate ? ` · محجوزة ${friendlyDate(visit.appointmentDate)} ${visit.appointmentTime}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    {!visit.appointmentDate && scheduleFor !== visit.id ? (
                      <button
                        type="button"
                        onClick={() => setScheduleFor(visit.id)}
                        className="rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-navy-50"
                      >
                        جدولها
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void startPlannedVisit(visit.id)}
                      disabled={scheduleBusy}
                      className="rounded-xl bg-brand-orange px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      ابدأ الزيارة
                    </button>
                  </div>
                </div>

                {scheduleFor === visit.id ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-2.5">
                    <label className="text-[11px] font-bold text-slate-600">
                      التاريخ
                      <input type="date" value={scheduleDate}
                        onChange={(event) => setScheduleDate(event.target.value)}
                        className="mt-1 block w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
                    </label>
                    <label className="text-[11px] font-bold text-slate-600">
                      الوقت
                      <input type="time" value={scheduleTime}
                        onChange={(event) => setScheduleTime(event.target.value)}
                        className="mt-1 block w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
                    </label>
                    <button type="button" onClick={() => void schedule(visit.id)} disabled={scheduleBusy}
                      className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">
                      {scheduleBusy ? "جارٍ الحجز…" : "احجز"}
                    </button>
                    <button type="button" onClick={() => setScheduleFor(null)}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600">
                      إلغاء
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* الحساب — للمخوّل ماليًا فقط؛ الخادم أرسل الرصيد لمن يملكه */}
      {financial ? (
        <section className={styles.card} aria-label="الحساب">
          <div className={styles.body}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-extrabold text-navy-900">الحساب</h3>
            <div className={styles.accountActions}>
              <button type="button" onClick={() => setCollectOpen(true)}
                className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white">
                تحصيل دفعة
              </button>
              <a href={`/print/statement/${patientId}`} target="_blank" rel="noopener"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800">
                كشف حساب
              </a>
              <button type="button" onClick={() => onGoToTab("account")}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800">
                تفاصيل الحركات
              </button>
            </div>
          </div>

          <div className={styles.accountCurrencies}>
          {CURRENCIES.filter((currency) => {
            const row = financial.byCurrency?.[currency] ?? (currency === base ? financial : null);
            return row && (Object.values(row).some((value) => typeof value === "number" && value !== 0) || (row.clinicalProgress?.historicalItems ?? 0) > 0 || currency === base && !financial.byCurrency);
          }).map((currency) => {
            const row = financial.byCurrency?.[currency] ?? financial;
            return <div key={currency} className={styles.currencyCard}>
              <p className="text-xs font-bold">{CURRENCY_LABEL[currency]}</p>
              <p className="mt-1 text-lg font-black">
                {row.balanceMinor > 0 ? `المستحق الحالي: ${formatMoney(row.balanceMinor, currency)}` : row.balanceMinor < 0 ? `رصيد لصالح المريض: ${formatMoney(-row.balanceMinor, currency)}` : "المستحق الحالي مسدّد"}
                {(row.agreementRemainingMinor ?? 0) > 0 ? <span className="block text-sm text-amber-700">متبقّي من اتفاق العلاج: {formatMoney(row.agreementRemainingMinor!, currency)}</span> : null}
              </p>
              <details className={styles.amountDetails}><summary>تفاصيل الاتفاق والفوترة بهذه العملة</summary>
              <dl className={styles.amountRows}>
                {[
                  ["قيمة العلاج المتفق عليه", row.agreedMinor],
                  ["المسدّد من الاتفاق", row.agreementPaidMinor],
                  ["المتبقي من الاتفاق", row.agreementRemainingMinor],
                  [row.clinicalProgress?.historicalItems ? "تم تنفيذ علاج معروف خارج التاريخي" : "تم تنفيذ علاج", row.clinicalProgress?.historicalItems ? row.clinicalProgress.knownDoneMinor : row.treatmentDoneMinor],
                  [row.clinicalProgress?.historicalItems ? "باقي علاج معروف خارج التاريخي" : "علاج غير منفّذ", row.clinicalProgress?.historicalItems ? row.clinicalProgress.knownRemainingMinor : row.remainingTreatmentMinor],
                  ["تم فوترة", row.invoicedMinor],
                  ["تم دفع", row.paidMinor],
                  ["المديونية الحالية", row.balanceMinor],
                ].map(([label, value]) => <div key={label as string} className={styles.amountRow}>
                  <dt className="text-[10px] font-bold text-slate-500">{label}</dt>
                  <dd className="mt-0.5 break-words font-extrabold text-navy-900 [overflow-wrap:anywhere]">{typeof value === "number" && Number.isFinite(value) ? formatMoney(value, currency) : "غير متاح"}</dd>
                </div>)}
              </dl></details>
              {row.clinicalProgress?.historicalItems ? <p className="mt-2 text-xs text-slate-600"><HistoricalClinicalNote progress={row.clinicalProgress} currency={currency} /></p> : null}
            </div>;
          })}
          </div>
          {!CURRENCIES.some((currency) => financial.byCurrency?.[currency] && Object.values(financial.byCurrency[currency]).some((value) => typeof value === "number" && value !== 0)) && financial.byCurrency ? <p className="mt-2 font-bold">لا مبالغ مستحقة ولا اتفاق متبقٍّ</p> : null}
          </div>
        </section>
      ) : null}

      {lastReceipt ? (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
          <p className="mb-2 text-sm font-bold text-emerald-800">سُجّلت الدفعة.</p>
          <div className="flex flex-wrap items-start justify-center gap-2">
            <a href={`/print/receipt/${lastReceipt}`} target="_blank" rel="noopener"
              onClick={() => setLastReceipt(null)}
              className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
              اطبع السند
            </a>
            {/* (RC-2) أُدخل المبلغ خطأً؟ يُصحَّح هنا فورًا — للمدير. */}
            <ReceiptCorrectionLauncher key={lastReceipt} paymentId={lastReceipt} patientId={patientId} label="المبلغ خطأ؟ صحّح السند"
              onDone={(_message, replacementId) => { setLastReceipt(replacementId); onChanged(); }} />
          </div>
        </div>
      ) : null}

      <details className={styles.disclosure} data-testid="summary-history-details">
        <summary>التاريخ الطبي المصرّح به وبطاقة الملف والتواصل</summary>
        <div className="space-y-3">
          <PatientIntakeHistory patientId={patientId} />
          <a href={`/print/patient-card/${patientId}`} target="_blank" rel="noopener" className={styles.action}>بطاقة الملف</a>
          <PortalInviteRow patientNumber={patientNumber} phone={patientPhone} />
        </div>
      </details>
      {/* الخط الزمني الموحَّد (§٢٩-٣٠) — يُحمَّل عند فتحه، والفلترة تُجيب تاريخ
          العلاج وتاريخ المال من مكان واحد. */}
      <PatientTimeline patientId={patientId} base={base} />

      <CollectPaymentModal
        patientId={patientId}
        patientName={patientName}
        isOpen={collectOpen}
        onClose={() => setCollectOpen(false)}
        onSuccess={(paymentId) => {
          setCollectOpen(false);
          setLastReceipt(paymentId);
          onChanged();
        }}
        suggestedMinor={primaryPlan?.overdueMinor && primaryPlan.overdueMinor > 0 ? primaryPlan.overdueMinor : null}
        /* (TD-05 owner review) المتأخر بعملة خطة الاتفاق — يُقترح بعملته لا بعملة
           الدفاتر، فلا يُقبض نصيبُ خطةٍ دولاريةٍ وكأنه يمنيّ. */
        suggestedCurrency={primaryPlan?.baseCurrency ?? null}
        contextLabel={
          financial && financial.balanceMinor > 0
            ? `الرصيد الحالي المستحق: ${formatMoney(financial.balanceMinor, base)}`
            : null
        }
      />
    </div>
  );
}


