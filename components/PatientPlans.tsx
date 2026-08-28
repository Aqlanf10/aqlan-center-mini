"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  formatMoney,
  isCurrency,
  type Currency,
} from "@/lib/money";
import { PLAN_STATUS_LABEL, splitInstallments, type PlanStatus } from "@/lib/plans";
import { useSetting } from "./SettingsProvider";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";

/**
 * خطط علاج المريض.
 *
 * الشاشة التي تجيب سؤالي مريض التقويم في كل زيارة: **كم بقي عليّ، وكم أدفع اليوم؟**
 * وبلا خطة كان الجواب اجتهادًا يختلف بين موظفة وأخرى.
 */

interface Plan {
  id: number; title: string; totalMinor: number; baseCurrency: Currency;
  status: PlanStatus; startDate: string; note: string | null;
  installments: { id: number; number: number; dueDate: string; amountMinor: number }[];
  paidMinor: number;
  progress: {
    totalMinor: number; dueToDateMinor: number; paidMinor: number; remainingMinor: number;
    overdueMinor: number; nextDueDate: string | null; nextDueAmountMinor: number;
    paidCount: number; count: number;
  };
}

export function PatientPlans({ patientId }: { patientId: number }) {
  const baseSetting = useSetting("finance.base_currency");
  const fallback: Currency = isCurrency(baseSetting) ? baseSetting : "YER";
  const [plans, setPlans] = useState<Plan[]>([]);
  const [base, setBase] = useState<Currency>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [payFor, setPayFor] = useState<number | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payCurrency, setPayCurrency] = useState<Currency>(fallback);
  const [lastReceipt, setLastReceipt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/plans?patientId=${patientId}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setPlans(payload.plans as Plan[]);
      if (isCurrency(payload.baseCurrency)) setBase(payload.baseCurrency);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const collect = async (plan: Plan) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: payAmount, currency: payCurrency }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر التحصيل."); return; }
      setLastReceipt((payload as { paymentId: number }).paymentId);
      setPayFor(null);
      setPayAmount("");
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {lastReceipt ? (
        <div className="mb-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
          <p className="mb-2 text-sm font-bold text-emerald-800">سُجّل القسط.</p>
          <a href={`/print/receipt/${lastReceipt}`} target="_blank" rel="noopener"
            onClick={() => setLastReceipt(null)}
            className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
            اطبع السند
          </a>
        </div>
      ) : null}

      <button onClick={() => setAdding((open) => !open)}
        className="mb-3 w-full rounded-2xl bg-navy-800 py-2.5 text-sm font-extrabold text-white">
        {adding ? "إغلاق" : "+ خطة علاج جديدة"}
      </button>

      {adding ? (
        <NewPlanForm
          patientId={patientId} base={base} busy={busy}
          onSaved={() => { setAdding(false); void load(); }}
          onError={setError}
        />
      ) : null}

      {loading && plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا خطط علاج. أنشئ خطة لمريض التقويم ليعرف كم بقي عليه ومتى.
        </p>
      ) : (
        <ul className="space-y-3">
          {plans.map((plan) => (
            <li key={plan.id} className={`rounded-2xl border p-4 ${
              plan.status === "active" ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
            }`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-base font-extrabold">{plan.title}</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
                  {PLAN_STATUS_LABEL[plan.status]}
                </span>
              </div>

              <div className="mb-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="text-sm font-bold">{formatMoney(plan.totalMinor, base)}</p>
                  <p className="text-[11px] text-slate-500">الإجمالي</p>
                </div>
                <div className="rounded-xl bg-emerald-50 p-2">
                  <p className="text-sm font-extrabold text-emerald-800">{formatMoney(plan.progress.paidMinor, base)}</p>
                  <p className="text-[11px] text-emerald-700">المدفوع</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="text-sm font-bold">{formatMoney(plan.progress.remainingMinor, base)}</p>
                  <p className="text-[11px] text-slate-500">الباقي</p>
                </div>
              </div>

              {/* شريط التقدّم: مريض التقويم يسأل «كم بقي» أكثر مما يسأل عن رقم. */}
              <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full bg-emerald-500"
                  style={{ width: `${Math.min(100, Math.round((plan.progress.paidMinor / Math.max(1, plan.totalMinor)) * 100))}%` }} />
              </div>
              <p className="mb-2 text-[11px] text-slate-500">
                {plan.progress.paidCount} من {plan.progress.count} أقساط
                {plan.progress.nextDueDate ? ` · القادم ${friendlyDateLong(plan.progress.nextDueDate)}` : ""}
              </p>

              {plan.progress.overdueMinor > 0 ? (
                <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
                  متأخر: {formatMoney(plan.progress.overdueMinor, base)}
                </p>
              ) : null}

              {plan.status === "active" ? (
                payFor === plan.id ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex flex-wrap gap-2">
                      <input value={payAmount} onChange={(event) => setPayAmount(event.target.value)}
                        placeholder="مبلغ القسط" aria-label="مبلغ القسط" inputMode="decimal" dir="ltr" autoFocus
                        className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
                      <select value={payCurrency} onChange={(event) => setPayCurrency(event.target.value as Currency)}
                        aria-label="العملة"
                        className="w-32 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                        {CURRENCIES.map((currency) => (
                          <option key={currency} value={currency}>{CURRENCY_LABEL[currency]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => collect(plan)} disabled={busy || !payAmount.trim()}
                        className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
                        سجّل القسط واطبع السند
                      </button>
                      <button onClick={() => setPayFor(null)}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600">
                        إلغاء
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        setPayFor(plan.id);
                        // المقترح: القسط القادم — أكثر ما يُدفع فعلًا.
                        const suggested = plan.progress.nextDueAmountMinor || plan.installments[0]?.amountMinor || 0;
                        setPayAmount(suggested ? String(suggested / (base === "YER" ? 1 : 100)) : "");
                        setPayCurrency(base);
                      }}
                      className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white">
                      تحصيل قسط
                    </button>
                    <button
                      onClick={async () => {
                        await fetch(`/api/plans/${plan.id}`, {
                          method: "PATCH", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ status: "completed" }),
                        });
                        void load();
                      }}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600">
                      إنهاء الخطة
                    </button>
                  </div>
                )
              ) : null}

              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-bold text-slate-500">جدول الأقساط</summary>
                <ul className="mt-2 space-y-1">
                  {plan.installments.map((installment) => (
                    <li key={installment.id} className="flex justify-between gap-2 text-xs">
                      <span className={installment.number <= plan.progress.paidCount ? "text-emerald-700" : "text-slate-600"}>
                        {installment.number <= plan.progress.paidCount ? "✓ " : ""}
                        قسط {installment.number} · {friendlyDateLong(installment.dueDate)}
                      </span>
                      <span className="font-bold">{formatMoney(installment.amountMinor, base)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewPlanForm({ patientId, base, busy, onSaved, onError }: {
  patientId: number; base: Currency; busy: boolean;
  onSaved: () => void; onError: (message: string | null) => void;
}) {
  const today = clinicDateString(new Date(), "Asia/Aden");
  const [title, setTitle] = useState("تقويم ثابت — فكّان");
  const [total, setTotal] = useState("");
  const [count, setCount] = useState("12");
  const [everyDays, setEveryDays] = useState("30");
  const [startDate, setStartDate] = useState(today);
  const [saving, setSaving] = useState(false);

  const preview = (() => {
    const totalMinor = Number(total.replace(/,/g, "")) * (base === "YER" ? 1 : 100);
    if (!Number.isFinite(totalMinor) || totalMinor <= 0) return [];
    return splitInstallments(Math.round(totalMinor), Number(count) || 1, startDate, Number(everyDays) || 30);
  })();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId, title, total, count: Number(count), everyDays: Number(everyDays), startDate }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر الحفظ."); return; }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-3 rounded-2xl border border-navy-800 bg-white p-4">
      <h3 className="mb-3 text-sm font-bold">خطة علاج جديدة</h3>
      <input value={title} onChange={(event) => setTitle(event.target.value)}
        placeholder="اسم الخطة" aria-label="اسم الخطة"
        className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <div className="mb-2 flex flex-wrap gap-2">
        <input value={total} onChange={(event) => setTotal(event.target.value)}
          placeholder="المبلغ الإجمالي" aria-label="المبلغ الإجمالي" inputMode="decimal" dir="ltr"
          className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
        <input value={count} onChange={(event) => setCount(event.target.value)}
          placeholder="عدد الأقساط" aria-label="عدد الأقساط" inputMode="numeric" dir="ltr"
          className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <input value={everyDays} onChange={(event) => setEveryDays(event.target.value)}
          aria-label="كل كم يوم" inputMode="numeric" dir="ltr"
          className="w-20 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      </div>
      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] font-bold text-slate-500">أول قسط</span>
        <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      </label>

      {preview.length > 0 ? (
        <p className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
          {preview.length} قسطًا · الأول {formatMoney(preview[0].amountMinor, base)} في{" "}
          {friendlyDateLong(preview[0].dueDate)} · الأخير في {friendlyDateLong(preview[preview.length - 1].dueDate)}
        </p>
      ) : null}

      <button type="submit" disabled={saving || busy || !total.trim()}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
        احفظ الخطة
      </button>
    </form>
  );
}
