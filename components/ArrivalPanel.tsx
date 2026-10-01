"use client";

import { useCallback, useEffect, useState } from "react";
import { CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import type { ArrivalPanel as ArrivalPanelData } from "@/lib/arrival-panel-db";
import type { ArrivalSuggestion } from "@/lib/arrival-panel";
import { CollectPaymentModal } from "./CollectPaymentModal";

const SOURCE_LABEL: Record<string, string> = {
  opening: "رصيد سابق",
  invoice: "فواتير",
  plan: "خطة اتفاق",
};

interface LedgerTargets {
  invoices: { id: number; invoiceNumber: string; totalMinor: number; discountMinor: number; baseCurrency?: Currency; status?: string }[];
  plans: { id: number; title: string; baseCurrency?: Currency; status?: string }[];
}

/**
 * (P0-D) لوحة الوصول — تظهر للاستقبال لحظة «وصل» لمريضٍ عائد.
 *
 * كل ما يلزم في نظرة: موعد اليوم، والحالة النشطة، والمال **بكل عملة على حدة**، واقتراح التحصيل من
 * مصدره (قسط الرصيد السابق على opening_currency، أو قسط خطة الاتفاق). التحصيل عبر نافذة التحصيل
 * القائمة نفسها — لا محرك دفعٍ ثانٍ — والدفع ليس شرطًا: «الدفع بعد العلاج» و«إلى الانتظار» متاحان دائمًا.
 */
export function ArrivalPanel({ patientId, onClose }: { patientId: number; onClose: () => void }) {
  const [panel, setPanel] = useState<ArrivalPanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collect, setCollect] = useState<{ suggestion: ArrivalSuggestion | null } | null>(null);
  const [targets, setTargets] = useState<LedgerTargets | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/patients/${patientId}/arrival-panel`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر تحميل لوحة الوصول.");
        return;
      }
      setPanel(payload as ArrivalPanelData);
      setError(null);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  /* أهداف نافذة التحصيل (الفواتير المفتوحة وخطط الاتفاق) من كشف الحساب القائم — عند فتح التحصيل فقط. */
  const openCollect = async (suggestion: ArrivalSuggestion | null) => {
    if (!targets) {
      try {
        const response = await fetch(`/api/patients/${patientId}/ledger`, { cache: "no-store" });
        if (response.ok) {
          const ledger = await response.json() as LedgerTargets;
          setTargets({
            invoices: (ledger.invoices ?? []).filter((invoice) => invoice.status === "open"),
            plans: (ledger.plans ?? []).filter((plan) => plan.status === "active"),
          });
        }
      } catch {
        // بلا أهداف تبقى النافذة قادرة على التحصيل على الحساب وعلى الرصيد السابق.
      }
    }
    setCollect({ suggestion });
  };

  const money = panel?.money ?? null;
  const openings = money?.lines
    .filter((line) => line.openingRemainingMinor > 0)
    .map((line) => ({ currency: line.currency, dueMinor: line.openingRemainingMinor })) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="لوحة الوصول">
      <section className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-4 shadow-2xl sm:rounded-3xl">
        <header className="mb-3 flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-bold text-emerald-700">✓ تم تسجيل الوصول</p>
            <h2 className="text-base font-extrabold text-navy-900">{panel?.patientName ?? "…"}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">✕</button>
        </header>

        {error ? <p className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</p> : null}
        {notice ? <p className="mb-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">{notice}</p> : null}

        {panel ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs">
              {panel.appointments.length > 0 ? panel.appointments.map((appointment) => (
                <p key={appointment.id} className="font-bold text-navy-900">
                  موعد اليوم {appointment.time}{appointment.plannedTitle ? ` · ${appointment.plannedTitle}` : appointment.type ? ` · ${appointment.type}` : ""}
                  {appointment.doctorName ? <span className="font-semibold text-slate-500"> · {appointment.doctorName}</span> : null}
                </p>
              )) : <p className="font-semibold text-slate-500">بلا موعد اليوم — زيارة مباشرة.</p>}
              {panel.ortho ? (
                <p className="mt-1 font-bold text-violet-800">
                  حالة تقويم {panel.ortho.legacy ? "(سابقة للنظام) " : ""}· {panel.ortho.phase}
                  {panel.ortho.upperWire || panel.ortho.lowerWire
                    ? <span className="font-semibold text-slate-600"> · علوي {panel.ortho.upperWire ?? "—"} / سفلي {panel.ortho.lowerWire ?? "—"}</span> : null}
                </p>
              ) : null}
              {panel.cases.filter((one) => !panel.ortho || one.specialty !== "ortho").map((one) => (
                <p key={one.title} className="mt-1 font-semibold text-slate-700">حالة نشطة: {one.title}</p>
              ))}
            </div>

            {money === null ? (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-500">الحساب يظهر لمن يملك صلاحية المال.</p>
            ) : money.lines.length === 0 ? (
              <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">لا رصيد ولا مستحقات على المريض.</p>
            ) : (
              money.lines.map((line) => (
                <div key={line.currency} className="rounded-2xl border border-slate-200 p-3 text-xs">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-black text-slate-500">{CURRENCY_LABEL[line.currency]}
                      {line.sources.length > 0 ? <span className="font-semibold"> · {line.sources.map((one) => SOURCE_LABEL[one]).join("، ")}</span> : null}
                    </span>
                    <span className={`text-base font-black ${line.balanceMinor > 0 ? "text-amber-800" : line.balanceMinor < 0 ? "text-emerald-700" : "text-slate-600"}`}>
                      {line.balanceMinor < 0 ? `رصيد دائن ${formatMoney(-line.balanceMinor, line.currency)}` : formatMoney(line.balanceMinor, line.currency)}
                    </span>
                  </div>
                  {line.openingRemainingMinor > 0 ? (
                    <p className="text-slate-600">منه رصيد سابق: <b>{formatMoney(line.openingRemainingMinor, line.currency)}</b></p>
                  ) : null}
                  {line.legacy ? (
                    <p className="text-slate-600">
                      القسط المقترح: <b>{formatMoney(line.legacy.suggestedMinor, line.currency)}</b>
                      {" · "}المتأخر: <b className={line.legacy.overdueMinor > 0 ? "text-rose-700" : ""}>{formatMoney(line.legacy.overdueMinor, line.currency)}</b>
                      {line.legacy.nextDueDate ? ` · القادم ${line.legacy.nextDueDate}` : line.legacy.cadence === "per_visit" ? " · مع كل زيارة" : ""}
                    </p>
                  ) : null}
                  {line.planInstallments.map((plan) => (
                    <p key={plan.planId} className="text-slate-600">
                      {plan.title}: {plan.overdueMinor > 0
                        ? <>متأخر <b className="text-rose-700">{formatMoney(plan.overdueMinor, line.currency)}</b></>
                        : <>قسط اليوم <b>{formatMoney(plan.nextDueAmountMinor, line.currency)}</b></>}
                    </p>
                  ))}
                  {line.openInvoices > 0 ? <p className="text-slate-600">فواتير مفتوحة: {line.openInvoices}</p> : null}
                </div>
              ))
            )}

            <div className="grid gap-2">
              {/* الرؤية ليست تحصيلًا: أزرار القبض لمن يملكه فعلًا (الخادم يقرر canCollect). */}
              {panel.canCollect && money?.suggestions.map((suggestion) => (
                <button key={`${suggestion.kind}-${suggestion.currency}-${suggestion.planId ?? 0}`} type="button"
                  onClick={() => void openCollect(suggestion)}
                  className="w-full rounded-2xl bg-emerald-700 py-3 text-sm font-extrabold text-white">
                  تحصيل {formatMoney(suggestion.amountMinor, suggestion.currency)} · {suggestion.label}
                </button>
              ))}
              {money && panel.canCollect ? (
                <button type="button" onClick={() => void openCollect(null)}
                  className="w-full rounded-2xl border border-emerald-700 bg-white py-3 text-sm font-extrabold text-emerald-800">
                  تحصيل مبلغ آخر
                </button>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={onClose}
                  className="rounded-2xl border border-slate-300 bg-white py-3 text-sm font-bold text-slate-700">
                  الدفع بعد العلاج
                </button>
                <button type="button" onClick={onClose}
                  className="rounded-2xl bg-navy-900 py-3 text-sm font-extrabold text-white">
                  {panel.activeVisit ? "إلى الانتظار ✓" : "إغلاق"}
                </button>
              </div>
            </div>
          </div>
        ) : !error ? (
          <p className="py-6 text-center text-xs font-semibold text-slate-400">جارٍ تحميل لوحة الوصول…</p>
        ) : null}
      </section>

      {collect && panel ? (
        <CollectPaymentModal
          patientId={patientId}
          patientName={panel.patientName}
          isOpen
          onClose={() => setCollect(null)}
          onSuccess={() => {
            setCollect(null);
            setNotice("سُجّل التحصيل.");
            void load();
          }}
          suggestedMinor={collect.suggestion?.amountMinor ?? null}
          suggestedCurrency={collect.suggestion?.currency ?? null}
          contextLabel={collect.suggestion?.label ?? null}
          presetOpeningCurrency={collect.suggestion?.kind === "legacy" ? collect.suggestion.currency : null}
          presetPlanId={collect.suggestion?.kind === "plan" ? collect.suggestion.planId : null}
          invoices={targets?.invoices ?? []}
          plans={targets?.plans ?? []}
          openings={openings}
        />
      ) : null}
    </div>
  );
}
