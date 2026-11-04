"use client";

import { useEffect, useState } from "react";
import { CLINIC_BASE_CURRENCY, formatMoney, isCurrency, type Currency } from "@/lib/money";

/**
 * شاشة الزيارة على المسار الموحّد (M2 slice 84) — قراءة.
 *
 * تعرض ما يعيده الخادم بعد إسقاط ما لا يملكه الحساب: الأسعار والمجاميع والعملات ومرجع
 * الفاتورة تظهر فقط إن أعادها الخادم (صلاحية عرض الفواتير أو المالك)، ولا تُستنتج ولا تُعرض
 * أصفارًا مكانها. بيانات التقويم تظهر فقط بصلاحية عرض التقويم.
 */
type Line = {
  id: number; serviceName: string; toothCode: number | null; surfaces: string | null; quantity: number;
  note: string | null; planItemId: number | null; unitPriceMinor?: number; totalMinor?: number; planCurrency?: Currency | null;
};
type Outstanding = {
  planItemId: number; planTitle: string; serviceName: string; toothCode: number | null;
  sessionCount: number; doneSessions: number; status: string; unmetRequirements: string[];
};
type CockpitVisit = {
  id: number; patientId: number | null; patientName: string; status: "open" | "signed";
  signedAt: string | null; signedBy: string | null; arrivedAt: string;
  chiefComplaint: string | null; examination: string | null; diagnosis: string | null;
  treatmentDone: string | null; nextPlan: string | null; addendum: string | null;
  procedures: Line[]; outstanding: Outstanding[];
  previousVisit: { date: string; treatmentDone: string | null; proceduresSummary: string | null; nextPlan: string | null; diagnosis: string | null } | null;
  latestDiagnosis: { text: string; date: string } | null;
  activeCases: { id: number | null; kind: string; title: string; status: string; nextStep: string | null }[];
  labOrders: { id: number; workType: string; toothCode: number | null; status: string; labName: string }[];
  referral: { fromName: string | null; reason: string } | null;
  ortho?: { appliance: string; phase: string; upperWire: string | null; lowerWire: string | null; lastAdjustment: string | null } | null;
  totalMinor?: number; billingCurrency?: Currency | null; invoiceId?: number | null;
};

const NOTE_LABELS: [keyof CockpitVisit, string][] = [
  ["chiefComplaint", "الشكوى الرئيسية"], ["examination", "الفحص"], ["diagnosis", "التشخيص"],
  ["treatmentDone", "العلاج المنفّذ"], ["nextPlan", "الخطة القادمة"], ["addendum", "الملحق"],
];

export function CanonicalVisitClinical({ visitId }: { visitId: number }) {
  const [visit, setVisit] = useState<CockpitVisit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const fail = (message: string) => { if (live) { setVisit(null); setError(message); } };
    fetch(`/api/visits/${visitId}/clinical`, { cache: "no-store" })
      .then(async response => {
        const payload = await response.json().catch(() => null) as (CockpitVisit & { message?: string }) | null;
        if (!response.ok || !payload || payload.id !== visitId) return fail(typeof payload?.message === "string" ? payload.message : "تعذّر تحميل الزيارة.");
        if (live) { setVisit(payload); setError(null); }
      })
      .catch(() => fail("تعذّر تحميل الزيارة."));
    return () => { live = false; };
  }, [visitId, attempt]);

  if (error) {
    return (
      <div role="alert" data-testid="canonical-visit-error" className="rounded-2xl border border-danger-300 bg-danger-50 p-4 text-sm font-semibold text-danger-700">
        <p>{error}</p>
        <button type="button" onClick={() => { setError(null); setAttempt(n => n + 1); }} className="mt-2 min-h-10 rounded-xl border border-danger-300 px-3 text-xs font-bold">إعادة المحاولة</button>
      </div>
    );
  }
  if (!visit) return <p className="p-4 text-center text-sm text-slate-500" data-testid="canonical-visit-loading">جارٍ تحميل الزيارة…</p>;

  const base: Currency = isCurrency(visit.billingCurrency) ? visit.billingCurrency : CLINIC_BASE_CURRENCY;
  const showMoney = typeof visit.totalMinor === "number";
  const signed = visit.status === "signed";
  return (
    <div className="space-y-3" data-testid="canonical-visit">
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-navy-900" data-testid="canonical-visit-patient">{visit.patientName}</h2>
          <span data-testid="canonical-visit-status" className={`rounded-full px-3 py-1 text-xs font-bold ${signed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
            {signed ? `موقَّعة${visit.signedBy ? ` — ${visit.signedBy}` : ""}` : "مفتوحة"}
          </span>
        </div>
        {visit.patientId === null ? <p className="mt-1 text-xs text-slate-600">زيارة غير مربوطة بملف مريض.</p> : null}
        {visit.referral ? <p className="mt-2 rounded-xl bg-sky-50 p-2 text-xs text-sky-900">محال{visit.referral.fromName ? ` من ${visit.referral.fromName}` : ""}: {visit.referral.reason}</p> : null}
        <p className="mt-2 text-xs text-slate-500">هذه الشاشة للعرض؛ الحفظ والتوقيع على الحساب الموحّد غير مفعّلين بعد.</p>
      </section>

      {visit.previousVisit || visit.latestDiagnosis ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm" data-testid="canonical-visit-history">
          <h3 className="mb-1 text-sm font-bold text-navy-900">ما سبق</h3>
          {visit.latestDiagnosis ? <p>آخر تشخيص ({visit.latestDiagnosis.date}): {visit.latestDiagnosis.text}</p> : null}
          {visit.previousVisit ? (
            <p className="mt-1 text-slate-700">الزيارة السابقة ({visit.previousVisit.date}): {visit.previousVisit.proceduresSummary ?? visit.previousVisit.treatmentDone ?? "—"}
              {visit.previousVisit.nextPlan ? ` · الخطة: ${visit.previousVisit.nextPlan}` : ""}</p>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="canonical-visit-notes">
        <h3 className="mb-2 text-sm font-bold text-navy-900">التوثيق</h3>
        <dl className="grid gap-2 text-sm">
          {NOTE_LABELS.map(([key, label]) => (
            <div key={key}><dt className="text-xs font-bold text-slate-500">{label}</dt>
              <dd className="whitespace-pre-wrap text-navy-900">{(visit[key] as string | null) || "—"}</dd></div>
          ))}
        </dl>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="canonical-visit-procedures">
        <h3 className="mb-2 text-sm font-bold text-navy-900">الإجراءات</h3>
        {visit.procedures.length === 0 ? <p className="text-sm text-slate-500">لا إجراءات مسجّلة.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {visit.procedures.map(line => (
              <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="canonical-visit-procedure">
                <span>{line.serviceName}{line.toothCode ? ` — سن ${line.toothCode}` : ""}{line.surfaces ? ` (${line.surfaces})` : ""}{line.quantity > 1 ? ` × ${line.quantity}` : ""}</span>
                {typeof line.totalMinor === "number" ? (
                  <span className="font-bold tabular-nums" data-testid="canonical-visit-line-price">{formatMoney(line.totalMinor, isCurrency(line.planCurrency) ? line.planCurrency : base)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {showMoney ? <p className="mt-2 text-sm font-bold" data-testid="canonical-visit-total">المجموع: {formatMoney(visit.totalMinor!, base)}</p> : null}
      </section>

      {visit.outstanding.length > 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="canonical-visit-outstanding">
          <h3 className="mb-2 text-sm font-bold text-navy-900">العلاج المتبقّي</h3>
          <ul className="space-y-1 text-sm">
            {visit.outstanding.map(item => (
              <li key={item.planItemId}>{item.serviceName}{item.toothCode ? ` — سن ${item.toothCode}` : ""} · {item.planTitle} · {item.doneSessions}/{item.sessionCount}
                {item.unmetRequirements.length > 0 ? <span className="text-amber-700"> · يتطلب: {item.unmetRequirements.join("، ")}</span> : null}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {visit.activeCases.length > 0 || visit.labOrders.length > 0 || visit.ortho ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm" data-testid="canonical-visit-context">
          {visit.ortho ? <p data-testid="canonical-visit-ortho">التقويم: {visit.ortho.appliance} · {visit.ortho.phase}
            {visit.ortho.upperWire || visit.ortho.lowerWire ? ` · الأسلاك ${visit.ortho.upperWire ?? "—"} / ${visit.ortho.lowerWire ?? "—"}` : ""}</p> : null}
          {visit.activeCases.map(one => <p key={`${one.kind}-${one.id ?? one.title}`}>{one.title}{one.nextStep ? ` — التالي: ${one.nextStep}` : ""}</p>)}
          {visit.labOrders.map(order => <p key={order.id}>مختبر: {order.workType}{order.toothCode ? ` — سن ${order.toothCode}` : ""} · {order.labName}</p>)}
        </section>
      ) : null}
    </div>
  );
}
