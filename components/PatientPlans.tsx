"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  formatMoney,
  isCurrency,
  type Currency,
} from "@/lib/money";
import { PLAN_STATUS_LABEL, splitInstallments, type PlanItemStatus, type PlanStatus } from "@/lib/plans";
import { useSetting } from "./SettingsProvider";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";

/**
 * خطط علاج المريض.
 *
 * الشاشة التي تجيب سؤالي مريض التقويم في كل زيارة: **كم بقي عليّ، وكم أدفع اليوم؟**
 * وبلا خطة كان الجواب اجتهادًا يختلف بين موظفة وأخرى.
 */

interface Service { id: number; name: string; category: string | null; priceMinor: number }

interface PlanItem {
  id: number; serviceName: string; toothCode: number | null; surfaces: string | null;
  quantity: number; unitPriceMinor: number; totalMinor: number;
  status: PlanItemStatus; visitId: number | null;
}

interface Plan {
  id: number; title: string; totalMinor: number; baseCurrency: Currency;
  status: PlanStatus; startDate: string; note: string | null;
  items: PlanItem[];
  itemsProgress: { count: number; doneCount: number; totalMinor: number; doneMinor: number; remainingMinor: number };
  totalFromItems: boolean;
  consentAt: string | null; consentBy: string | null; consentNote: string | null;
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
  const [adding, setAdding] = useState<"clinical" | "financial" | null>(null);
  const [payFor, setPayFor] = useState<number | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payCurrency, setPayCurrency] = useState<Currency>(fallback);
  const [lastReceipt, setLastReceipt] = useState<number | null>(null);
  const [consentFor, setConsentFor] = useState<number | null>(null);

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

      {/*
        * طريقان لخطةٍ واحدة — لا نوعان من الخطط.
        *
        * «سريرية»: تُبنى ببنودها فيُشتقّ إجماليّها منها — لمريضٍ يريد أن يعرف ماذا
        * سيُعمل له وعلى أيّ سن. و«بمبلغ متفق عليه»: رقمٌ واحد يُقسَّط — وهو ما يكفي
        * مريض التقويم. والكائن واحد في الحالتين، لأن المريض قد يبدأ بهذه وينتهي بتلك.
        */}
      <div className="mb-3 flex gap-2">
        <button onClick={() => { setAdding((open) => (open === "clinical" ? null : "clinical")); }}
          className="flex-[2] rounded-2xl bg-navy-800 py-2.5 text-sm font-extrabold text-white">
          {adding === "clinical" ? "إغلاق" : "+ خطة سريرية ببنودها"}
        </button>
        <button onClick={() => { setAdding((open) => (open === "financial" ? null : "financial")); }}
          className="flex-1 rounded-2xl border border-navy-800 bg-white py-2.5 text-sm font-bold text-navy-800">
          {adding === "financial" ? "إغلاق" : "بمبلغ متفق عليه"}
        </button>
      </div>

      {adding ? (
        <NewPlanForm
          patientId={patientId} base={base} busy={busy} mode={adding}
          onSaved={() => { setAdding(null); void load(); }}
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

              {/*
                * أرقامٌ مختلفة لخطتين مختلفتين — لأن السؤال نفسه مختلف.
                *
                * خطةُ الأقساط تُفوتَر بأقساطها، فسؤالها **مالي**: كم دفع وكم بقي.
                * والخطة السريرية تُفوتَر بزياراتها، فمالُها في كشف الحساب لا فيها،
                * وسؤالها **علاجي**: كم أُنجز وكم بقي من العمل. وعرضُ «المدفوع ٠
                * والباقي ٢٨٬٠٠٠» على خطةٍ سُدّد جزءٌ منها بفاتورة زيارة يقول للمريض
                * رقمًا يخالف كشف حسابه — وهو الرقم الذي يُجادَل عليه.
                */}
              <div className="mb-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="text-sm font-bold">{formatMoney(plan.totalMinor, base)}</p>
                  <p className="text-[11px] text-slate-500">
                    {plan.installments.length > 0 ? "الإجمالي" : "المتفق عليه"}
                  </p>
                </div>
                {plan.installments.length > 0 ? (
                  <>
                    <div className="rounded-xl bg-emerald-50 p-2">
                      <p className="text-sm font-extrabold text-emerald-800">{formatMoney(plan.progress.paidMinor, base)}</p>
                      <p className="text-[11px] text-emerald-700">المدفوع</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-2">
                      <p className="text-sm font-bold">{formatMoney(plan.progress.remainingMinor, base)}</p>
                      <p className="text-[11px] text-slate-500">الباقي</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-xl bg-emerald-50 p-2">
                      <p className="text-sm font-extrabold text-emerald-800">{formatMoney(plan.itemsProgress.doneMinor, base)}</p>
                      <p className="text-[11px] text-emerald-700">أُنجز</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-2">
                      <p className="text-sm font-bold">{formatMoney(plan.itemsProgress.remainingMinor, base)}</p>
                      <p className="text-[11px] text-slate-500">باقي العلاج</p>
                    </div>
                  </>
                )}
              </div>

              {/*
                * شريط التقدّم: مريض التقويم يسأل «كم بقي» أكثر مما يسأل عن رقم.
                * ولا يظهر لخطةٍ بلا أقساط: «٠ من ٠ أقساط» تحت شريطٍ فارغ ليس معلومة.
                */}
              {plan.installments.length > 0 ? (
                <>
                  <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full bg-emerald-500"
                      style={{ width: `${Math.min(100, Math.round((plan.progress.paidMinor / Math.max(1, plan.totalMinor)) * 100))}%` }} />
                  </div>
                  <p className="mb-2 text-[11px] text-slate-500">
                    {plan.progress.paidCount} من {plan.progress.count} أقساط
                    {plan.progress.nextDueDate ? ` · القادم ${friendlyDateLong(plan.progress.nextDueDate)}` : ""}
                    {" · "}
                    <a href={`?tab=ledger`}
                      className="font-bold text-navy-800 underline decoration-navy-300 underline-offset-4">
                      سنداتها فواتير ودفعات في كشف الحساب
                    </a>
                  </p>
                </>
              ) : null}

              {plan.progress.overdueMinor > 0 ? (
                <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
                  متأخر: {formatMoney(plan.progress.overdueMinor, base)}
                </p>
              ) : null}

              {/*
                * «تحصيل قسط» لخطة الأقساط وحدها — لا لكل خطة.
                *
                * لأنه يُصدر فاتورةً بقيمة القسط. وخطةٌ سريرية بلا أقساط تُفوتَر
                * بزياراتها أصلًا، فتحصيلُ «قسط» عليها يُصدر فاتورةً ثانيةً للعمل
                * نفسه — وهي الفوترة المزدوجة التي نحذّر منها عند التوقيع، فلا يصحّ
                * أن يفتح لها البرنامج بابًا من هنا. والمسوّدة أولى بالمنع: ما لم
                * يوافق المريض بعد ليس اتفاقًا يُقبض عليه.
                */}
              {plan.status === "active" && plan.installments.length > 0 ? (
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

              {plan.items.length > 0 || (plan.status === "active" && !plan.consentAt) ? (
                <PlanItems plan={plan} base={base}
                  onChanged={() => void load()} onError={setError} />
              ) : null}

              {plan.status === "active" && !plan.consentAt && plan.items.length > 0 ? (
                consentFor === plan.id ? (
                  <ConsentForm plan={plan} base={base}
                    onDone={() => { setConsentFor(null); void load(); }} onError={setError} />
                ) : (
                  <button onClick={() => setConsentFor(plan.id)}
                    className="mt-2 w-full rounded-xl border border-emerald-500 bg-emerald-50 py-2 text-xs font-extrabold text-emerald-800">
                    سجّل موافقة المريض — ويُقفل الاتفاق
                  </button>
                )
              ) : null}

              {plan.status === "active" && plan.installments.length === 0 && plan.consentAt ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="flex-1 text-[11px] text-slate-500">
                    تُفوتَر هذه الخطة بزياراتها — والمال في{" "}
                    <a href={`?tab=ledger`}
                      className="font-bold text-navy-800 underline decoration-navy-300 underline-offset-4">
                      كشف الحساب
                    </a>
                    .
                  </p>
                  <button
                    onClick={async () => {
                      await fetch(`/api/plans/${plan.id}`, {
                        method: "PATCH", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ status: "completed" }),
                      });
                      void load();
                    }}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-600">
                    إنهاء الخطة
                  </button>
                </div>
              ) : null}

              {plan.consentAt ? (
                <p className="mt-2 text-[10px] font-semibold text-slate-400">
                  وافق المريض في {friendlyDateLong(plan.consentAt.slice(0, 10))}
                  {plan.consentBy ? ` · سجّلها ${plan.consentBy}` : ""}
                  {plan.consentNote ? ` · ${plan.consentNote}` : ""}
                </p>
              ) : null}

              {plan.installments.length > 0 ? (
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
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewPlanForm({ patientId, base, busy, mode, onSaved, onError }: {
  patientId: number; base: Currency; busy: boolean; mode: "clinical" | "financial";
  onSaved: () => void; onError: (message: string | null) => void;
}) {
  const clinical = mode === "clinical";
  const today = clinicDateString(new Date(), "Asia/Aden");
  const [title, setTitle] = useState(clinical ? "خطة علاج ترميمي" : "تقويم ثابت — فكّان");
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
        body: JSON.stringify(clinical
          ? { patientId, title, mode: "clinical", startDate }
          : { patientId, title, total, count: Number(count), everyDays: Number(everyDays), startDate }),
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
      <h3 className="mb-1 text-sm font-bold">
        {clinical ? "خطة سريرية جديدة" : "خطة بمبلغ متفق عليه"}
      </h3>
      <p className="mb-3 text-[11px] leading-4 text-slate-500">
        {clinical
          ? "تُنشأ فارغة، ثم تُضاف بنودها من دليل الخدمات — والإجمالي يُحسب منها. والخطة اتفاقٌ لا دَين: لا تُدين على الحساب حتى تُنفَّذ بنودها وتُوقَّع زياراتها — وعندها تظهر فواتيرها في كشف الحساب."
          : "مبلغٌ واحد متفق عليه يُقسَّط — كخطة التقويم. كل قسطٍ يُقبض يُصدر فاتورةً ودفعةً على الحساب فورًا."}
      </p>
      <input value={title} onChange={(event) => setTitle(event.target.value)}
        placeholder="اسم الخطة" aria-label="اسم الخطة"
        className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <div className={`mb-2 flex flex-wrap gap-2 ${clinical ? "hidden" : ""}`}>
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

      {preview.length > 0 && !clinical ? (
        <p className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
          {preview.length} قسطًا · الأول {formatMoney(preview[0].amountMinor, base)} في{" "}
          {friendlyDateLong(preview[0].dueDate)} · الأخير في {friendlyDateLong(preview[preview.length - 1].dueDate)}
        </p>
      ) : null}

      <button type="submit" disabled={saving || busy || (!clinical && !total.trim())}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
        {clinical ? "أنشئ الخطة ثم أضف بنودها" : "احفظ الخطة"}
      </button>
    </form>
  );
}

/**
 * بنود الخطة — المسوّدة تُبنى، ثم تُقفل بالموافقة.
 *
 * قبل الموافقة: تُضاف البنود وتُحذف بحرّية، والإجمالي يتحرّك معها. وبعدها: قائمةٌ
 * للقراءة تُطبع ويُوقّع عليها المريض. والفرق بين الحالتين ظاهرٌ في الشاشة نفسها —
 * لا في رأس من يستعملها.
 */
function PlanItems({ plan, base, onChanged, onError }: {
  plan: Plan; base: Currency; onChanged: () => void; onError: (message: string | null) => void;
}) {
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [tooth, setTooth] = useState("");
  const [surfaces, setSurfaces] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = Boolean(plan.consentAt);

  useEffect(() => {
    if (locked) return;
    void (async () => {
      const response = await fetch("/api/services", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const list = (payload.services ?? payload) as Service[];
      setServices(list);
      setServiceId((current) => current ?? list[0]?.id ?? null);
    })();
  }, [locked]);

  const chosen = services.find((service) => service.id === serviceId) ?? null;

  const add = async () => {
    if (!serviceId || busy) return;
    setBusy(true);
    onError(null);
    try {
      const response = await fetch(`/api/plans/${plan.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId, quantity: 1,
          toothCode: tooth.trim() ? Number(tooth.trim()) : null,
          surfaces: surfaces.trim() || null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر إضافة البند."); return; }
      setTooth("");
      setSurfaces("");
      onChanged();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (itemId: number) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/plans/${plan.id}/items?itemId=${itemId}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر حذف البند."); return; }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p className="mb-2 text-[11px] font-bold text-slate-500">
        بنود الخطة {locked ? "— موافَقٌ عليها فلا تُعدَّل" : "— الإجمالي يُحسب منها"}
      </p>

      {plan.items.length === 0 ? (
        <p className="text-xs text-slate-400">لا بنود بعد.</p>
      ) : (
        <ul className="mb-2 space-y-1">
          {plan.items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {item.status === "done" ? <span className="text-emerald-600">✓</span> : null}
                <span className={`truncate font-bold ${item.status === "done" ? "text-emerald-700" : ""}`}>
                  {item.serviceName}
                </span>
                {item.toothCode ? (
                  <span className="shrink-0 text-slate-500">
                    · سن {item.toothCode}{item.surfaces ? ` (${item.surfaces})` : ""}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-bold">{formatMoney(item.totalMinor, base)}</span>
              {locked ? null : (
                <button onClick={() => void remove(item.id)} disabled={busy}
                  aria-label={`احذف ${item.serviceName}`}
                  className="shrink-0 rounded-md px-1.5 text-slate-400 hover:text-red-600 disabled:opacity-40">
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {locked ? (
        plan.itemsProgress.count > 0 ? (
          <p className="text-[11px] font-bold text-slate-500">
            أُنجز {plan.itemsProgress.doneCount} من {plan.itemsProgress.count} بنود ·{" "}
            {formatMoney(plan.itemsProgress.doneMinor, base)} من {formatMoney(plan.itemsProgress.totalMinor, base)}
          </p>
        ) : null
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[10rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">الخدمة</span>
            <select value={serviceId ?? ""} onChange={(event) => setServiceId(Number(event.target.value))}
              aria-label="خدمة الخطة"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} · {formatMoney(service.priceMinor, base)}
                </option>
              ))}
            </select>
          </label>
          <label className="w-20">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">السن</span>
            <input value={tooth} onChange={(event) => setTooth(event.target.value)}
              aria-label="سن البند" inputMode="numeric" dir="ltr" placeholder="16"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
          <label className="w-20">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">الأسطح</span>
            <input value={surfaces} onChange={(event) => setSurfaces(event.target.value)}
              aria-label="أسطح البند" dir="ltr" placeholder="MO"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
          <button onClick={() => void add()} disabled={busy || !serviceId}
            className="rounded-lg bg-navy-800 px-3 py-1.5 text-xs font-extrabold text-white disabled:opacity-40">
            + أضف
          </button>
          {chosen ? (
            <span className="text-[10px] text-slate-400">
              يُسعَّر من الدليل: {formatMoney(chosen.priceMinor, base)}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * تسجيل الموافقة — والتقسيط معها إن أراد المريض.
 *
 * يُسألان في النَّفَس نفسه على الكرسي: «موافق؟» ثم «أقدر أقسّطها؟». وفصلُهما إلى
 * خطوتين يجعل نصف الخطط تُوافَق ولا تُجدوَل.
 */
function ConsentForm({ plan, base, onDone, onError }: {
  plan: Plan; base: Currency; onDone: () => void; onError: (message: string | null) => void;
}) {
  const today = clinicDateString(new Date(), "Asia/Aden");
  const [note, setNote] = useState("توقيع ورقي محفوظ بالملف");
  const [split, setSplit] = useState(false);
  const [count, setCount] = useState("6");
  const [everyDays, setEveryDays] = useState("30");
  const [firstDueDate, setFirstDueDate] = useState(today);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      const response = await fetch(`/api/plans/${plan.id}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note,
          ...(split ? { count: Number(count), everyDays: Number(everyDays), firstDueDate } : {}),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر تسجيل الموافقة."); return; }
      onDone();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3">
      <p className="mb-2 text-xs font-bold text-emerald-900">
        موافقة المريض على {formatMoney(plan.totalMinor, base)} — وبعدها تُقفل البنود.
      </p>
      <input value={note} onChange={(event) => setNote(event.target.value)}
        aria-label="كيف وُثّقت الموافقة"
        className="mb-2 w-full rounded-lg border border-emerald-200 bg-white px-2.5 py-1.5 text-xs" />

      <label className="mb-2 flex items-center gap-2 text-xs font-bold text-emerald-900">
        <input type="checkbox" checked={split} onChange={(event) => setSplit(event.target.checked)} />
        قسّطها
      </label>

      {split ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <input value={count} onChange={(event) => setCount(event.target.value)}
            aria-label="عدد الأقساط" inputMode="numeric" dir="ltr"
            className="w-20 rounded-lg border border-emerald-200 px-2 py-1.5 text-xs" />
          <input value={everyDays} onChange={(event) => setEveryDays(event.target.value)}
            aria-label="كل كم يوم" inputMode="numeric" dir="ltr"
            className="w-20 rounded-lg border border-emerald-200 px-2 py-1.5 text-xs" />
          <input type="date" value={firstDueDate} onChange={(event) => setFirstDueDate(event.target.value)}
            aria-label="أول قسط"
            className="flex-1 rounded-lg border border-emerald-200 px-2 py-1.5 text-xs" />
        </div>
      ) : null}

      <button onClick={() => void submit()} disabled={busy || plan.totalMinor <= 0}
        className="w-full rounded-lg bg-emerald-600 py-2 text-xs font-extrabold text-white disabled:opacity-40">
        سجّل الموافقة
      </button>
    </div>
  );
}
