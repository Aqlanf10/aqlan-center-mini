"use client";

import { DentalChart } from "@/components/DentalChart";
import { friendlyDate, friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { PLANNED_VISIT_STATUS_LABEL } from "@/lib/workflow";
import type { WorkflowSummary } from "./SummaryTab";

/**
 * Presentation-only overview of the existing, authoritative treatment record.
 *
 * No local clinical/financial state, new API, command, session, or invoice.
 * The odontogram remains the canonical DentalChart; actions only navigate to
 * the existing guarded workspaces. Absent/stale summary is not interpreted as 0.
 */
export function TreatmentChartWorkspace({
  patientId, summary, onOpenPlans, onOpenOrtho, onOpenToday, onOpenFiles,
}: {
  patientId: number;
  summary: WorkflowSummary | null;
  onOpenPlans: () => void;
  onOpenOrtho: () => void;
  onOpenToday: () => void;
  onOpenFiles: () => void;
}) {
  const activePlans = summary?.activePlans ?? [];
  const plan = activePlans[0] ?? null;
  const hasHistoricalUncertainty = (plan?.clinicalProgress?.historicalItems ?? 0) > 0;
  const knownProgress = plan && !hasHistoricalUncertainty && plan.itemsCount > 0
    ? Math.min(100, Math.round((plan.doneItems / plan.itemsCount) * 100)) : null;
  const appointments = summary?.plannedVisits.slice(0, 3) ?? [];

  return (
    <div className="space-y-3" data-testid="patient-treatment-overview">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-100 bg-white px-4 py-3 shadow-card">
        <div className="min-w-0">
          <h2 className="text-base font-black text-navy-900">نظرة على العلاج ومخطط الأسنان</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            بيانات الحالة والخطة المعتمدة من السجلات نفسها، دون إنشاء علاج أو فاتورة جديدة
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onOpenPlans}
            className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-brand-blue hover:bg-sky-100">
            فتح خطط العلاج
          </button>
          <button type="button" onClick={onOpenToday}
            className="rounded-xl bg-brand-orange px-3 py-2 text-xs font-bold text-white hover:bg-accent-600">
            زيارة اليوم
          </button>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-3" aria-label="السياق السريري">
          <section className="rounded-2xl border border-sky-100 bg-white p-3.5 shadow-card">
            <h3 className="border-b border-slate-100 pb-2 text-sm font-extrabold text-brand-blue">الحالة السريرية</h3>
            {summary ? (
              <>
                <p className="mt-2 text-[11px] font-bold text-slate-500">{activePlans.length > 1 ? `الخطة الأولى المعروضة من ${activePlans.length} خطط نشطة` : "الخطة النشطة"}</p>
                <p className="mt-1 break-words text-sm font-black text-navy-900">{plan?.title ?? "لا توجد خطة نشطة"}</p>
                {plan?.specialty ? (
                  <p className="mt-2 break-words text-xs text-slate-600">التخصص: {plan.specialty}</p>
                ) : null}
                {plan?.primaryDoctorName ? (
                  <p className="mt-1 break-words text-xs text-slate-600">الطبيب المسؤول: {plan.primaryDoctorName}</p>
                ) : null}
                {plan && !plan.consentAt ? (
                  <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] font-bold text-amber-900">
                    موافقة العلاج لم تُسجّل بعد
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mt-2 text-xs font-bold text-amber-800">تعذّر التحقق من بيانات الحالة حالياً.</p>
            )}
            <button type="button" onClick={onOpenOrtho}
              className="mt-3 w-full rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-brand-blue hover:bg-sky-100">
              فتح وحدة التقويم
            </button>
          </section>

          <section className="rounded-2xl border border-sky-100 bg-white p-3.5 shadow-card">
            <h3 className="border-b border-slate-100 pb-2 text-sm font-extrabold text-brand-blue">الزيارة القادمة</h3>
            {summary?.nextAppointment ? (
              <>
                <p className="mt-2 text-sm font-extrabold text-navy-900">
                  {friendlyDate(summary.nextAppointment.date)} · {friendlyTime(summary.nextAppointment.time)}
                </p>
                <p className="mt-1 break-words text-xs text-slate-600">{summary.nextAppointment.note ?? "موعد قائم"}</p>
              </>
            ) : (
              <p className="mt-2 text-xs text-slate-500">{summary ? "لا يوجد موعد قادم" : "الموعد غير معروف حالياً"}</p>
            )}
          </section>
        </aside>

        <div className="min-w-0 space-y-3">
          <section className="rounded-2xl border border-sky-100 bg-white p-4 shadow-card" aria-label="تقدم العلاج">
            <h3 className="text-sm font-extrabold text-brand-blue">تقدم {plan ? `خطة ${plan.title}` : "الخطة العلاجية"}</h3>
            {activePlans.length > 1 ? (
              <p className="mt-1 text-[11px] leading-5 text-slate-600">هذه نسبة الخطة الأولى فقط؛ تُعرض الخطط الأخرى منفصلة ولا تُجمع نسب إنجازها.</p>
            ) : null}
            {knownProgress !== null && plan ? (
              <>
                <div className="mt-3 flex justify-between gap-2 text-xs font-bold text-navy-900">
                  <span>{plan.doneItems} من {plan.itemsCount} بنود مكتملة</span>
                  <span>{knownProgress}%</span>
                </div>
                <div role="progressbar" aria-label="نسبة بنود العلاج المنجزة"
                  aria-valuenow={knownProgress} aria-valuemin={0} aria-valuemax={100}
                  className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-brand-blue" style={{ width: `${knownProgress}%` }} />
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                {hasHistoricalUncertainty
                  ? "تقدم العلاج يحتاج مراجعة السجل السابق، ولا يمكن اعتباره نسبة مكتملة."
                  : summary ? "لا تتوفر بنود كافية لحساب تقدم الخطة." : "تقدم الخطة غير متاح الآن."}
              </p>
            )}
          </section>

          <section className="min-w-0 overflow-hidden rounded-2xl border border-sky-100 bg-white p-2 shadow-card sm:p-3" aria-label="مخطط الأسنان الفعلي">
            <h3 className="mb-2 px-1 text-sm font-extrabold text-brand-blue">مخطط الأسنان — FDI</h3>
            <DentalChart patientId={patientId} />
          </section>
        </div>

        <aside className="min-w-0 space-y-3" aria-label="الزيارة والمتابعة">
          <section className="rounded-2xl border border-sky-100 bg-white p-3.5 shadow-card">
            <h3 className="border-b border-slate-100 pb-2 text-sm font-extrabold text-brand-blue">معلومات الخطة</h3>
            {activePlans.length > 0 ? (
              <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto" aria-label="الخطط العلاجية النشطة" data-testid="patient-active-plans">
                {activePlans.map((activePlan, index) => (
                  <li key={activePlan.id} className="min-w-0 rounded-xl border border-sky-100 bg-sky-50/40 p-2.5">
                    <div className="flex flex-wrap items-start justify-between gap-1">
                      <p className="min-w-0 break-words text-xs font-black text-navy-900">{activePlan.title}</p>
                      {activePlans.length > 1 ? (
                        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-brand-blue">الخطة {index + 1}</span>
                      ) : null}
                    </div>
                    {activePlan.specialty ? (
                      <p className="mt-1 break-words text-[11px] text-slate-600">التخصص: {activePlan.specialty}</p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-slate-600">بنود العلاج: {activePlan.itemsCount} · المنجز المسجل: {activePlan.doneItems}</p>
                    {(activePlan.clinicalProgress?.historicalItems ?? 0) > 0 ? (
                      <p className="mt-1 text-[11px] font-bold leading-5 text-amber-800">توجد أعمال علاجية سابقة تحتاج مراجعة؛ لا تُحتسب مكتملة تلقائياً.</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-500">{summary ? "لا توجد خطة نشطة" : "لا تتوفر بيانات موثوقة حالياً"}</p>
            )}
            <button type="button" onClick={onOpenPlans}
              className="mt-3 w-full rounded-lg bg-brand-blue px-3 py-2 text-xs font-bold text-white hover:bg-navy-600">
              عرض تفاصيل الخطة
            </button>
          </section>
          <section className="rounded-2xl border border-sky-100 bg-white p-3.5 shadow-card">
            <h3 className="border-b border-slate-100 pb-2 text-sm font-extrabold text-brand-blue">آخر زيارة</h3>
            {summary?.lastVisit ? (
              <>
                <p className="mt-2 text-xs font-bold text-navy-900">{friendlyDateLong(summary.lastVisit.date)}</p>
                <p className="mt-1 break-words text-xs leading-6 text-slate-600">
                  {summary.lastVisit.proceduresSummary ?? summary.lastVisit.treatmentDone ?? "زيارة سابقة"}
                </p>
              </>
            ) : (
              <p className="mt-2 text-xs text-slate-500">{summary ? "لا توجد زيارة سابقة" : "لا تتوفر قراءة مؤكدة"}</p>
            )}
            <button type="button" onClick={onOpenFiles}
              className="mt-3 w-full rounded-lg border border-sky-200 bg-white px-3 py-2 text-xs font-bold text-brand-blue hover:bg-sky-50">
              فتح الأشعة والملفات
            </button>
          </section>
          {appointments.length > 0 ? (
            <section className="rounded-2xl border border-sky-100 bg-white p-3.5 shadow-card">
              <h3 className="border-b border-slate-100 pb-2 text-sm font-extrabold text-brand-blue">الجلسات المخططة</h3>
              <ul className="mt-2 space-y-2">
                {appointments.map((visit) => (
                  <li key={visit.id} className="rounded-lg bg-slate-50 p-2">
                    <p className="break-words text-xs font-bold text-navy-900">{visit.title}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {PLANNED_VISIT_STATUS_LABEL[visit.status]}
                      {visit.appointmentDate ? ` · ${friendlyDate(visit.appointmentDate)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
