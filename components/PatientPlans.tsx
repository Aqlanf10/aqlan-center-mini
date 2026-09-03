"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  formatAmount,
  formatMoney,
  isCurrency,
  parseAmount,
  toInputAmount,
  type Currency,
} from "@/lib/money";
import { PLAN_STATUS_LABEL, groupItemsByVisit, splitInstallments, type BillingStatus, type PlanItemStatus, type PlanStatus } from "@/lib/plans";
import {
  BILLING_RULE_LABEL, BILLING_RULES, PLANNED_VISIT_STATUS_LABEL,
  type BillingRule, type PlannedVisitStatus,
} from "@/lib/workflow";
import { useSetting } from "./SettingsProvider";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { ServiceSelect } from "./ServiceSelect";
import { useSession } from "./SessionProvider";

/**
 * خطط علاج المريض — زرٌّ واحد، والتعقيد خيارٌ داخل النموذج (المواصفة §٧).
 *
 * كان إنشاء الخطة طريقين ظاهرين للمستخدم (سريرية ببنود / مالية بأقساط)؛ والآن
 * زرٌّ واحد «+ إنشاء خطة علاج» يفتح نموذجًا واحدًا: الاسم والتخصص والطبيب والبنود،
 * ثم طريقة التسعير (بنودٌ مسعَّرة أو مبلغٌ متفق عليه)، ثم طريقة الدفع (حسب
 * المنفَّذ أو أقساط أو جدول مخصص). والكائن في القاعدة واحد في الحالتين.
 *
 * والطبيب يرى خططه سريريًا (البنود والجلسات والزيارات المخطَّطة) — وكل ما هو
 * مالي يُخفى عنه في الخادم إلا بإذنٍ صريح.
 */

interface Service { id: number; name: string; category: string | null; priceMinor: number }
interface Doctor { id: number; name: string }

interface PlanItem {
  id: number; serviceId: number | null; serviceName: string; toothCode: number | null; surfaces: string | null;
  quantity: number; unitPriceMinor: number; totalMinor: number;
  status: PlanItemStatus; visitId: number | null;
  /* تنظيم الجلسات: رقم الجلسة المخططة وقاعدة الفوترة وحالتها والجلسات المنجزة وطبيب البند. */
  plannedVisitNumber?: number; billingRule?: BillingRule;
  billingStatus?: BillingStatus; sessionCount?: number;
  sessionsCompleted?: number; doctorId?: number | null; doctorName?: string | null;
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
interface PlannedVisit {
  id: number; planTitle: string | null; sequence: number; title: string;
  doctorName: string | null; durationMinutes: number; status: PlannedVisitStatus;
  appointmentDate: string | null; appointmentTime: string | null; note: string | null;
}

const SPECIALTIES = ["علاج عام", "تقويم", "زراعة", "تركيبات", "جراحة", "تجميل"];

export function PatientPlans({ patientId }: { patientId: number }) {
  const baseSetting = useSetting("finance.base_currency");
  const fallback: Currency = isCurrency(baseSetting) ? baseSetting : "YER";
  const session = useSession();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plannedVisits, setPlannedVisits] = useState<PlannedVisit[]>([]);
  const [canSeeFinancial, setCanSeeFinancial] = useState(true);
  const [base, setBase] = useState<Currency>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [payFor, setPayFor] = useState<number | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payCurrency, setPayCurrency] = useState<Currency>(fallback);
  const [lastReceipt, setLastReceipt] = useState<number | null>(null);
  const [consentFor, setConsentFor] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/plans`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setPlans(payload.plans as Plan[]);
      setPlannedVisits(payload.plannedVisits ?? []);
      setCanSeeFinancial(payload.canSeeFinancial ?? false);
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
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-red-700 text-red-700">{error}</p>
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

      {/* زرٌّ واحد — والنموذج يحمل الخيارات كلها (المواصفة §٧) */}
      <div className="mb-3">
        <button onClick={() => setCreating((open) => !open)}
          className="w-full rounded-2xl bg-navy-800 py-2.5 text-sm font-extrabold text-white">
          {creating ? "إغلاق نموذج الإنشاء" : "+ إنشاء خطة علاج"}
        </button>
      </div>

      {creating ? (
        <NewPlanFormV2
          patientId={patientId} base={base} busy={busy}
          onSaved={() => { setCreating(false); void load(); }}
          onError={setError}
        />
      ) : null}

      {loading && plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا خطط علاج بعد. أنشئ خطةً واحدة يُوزَّع علاجها على الجلسات والزيارات تلقائيًا.
        </p>
      ) : (
        <ul className="space-y-3">
          {plans.map((plan) => (
            <li key={plan.id} className={`rounded-2xl border p-4 ${
              plan.status === "active" ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
            }`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-base font-extrabold">{plan.title}</span>
                <span className="flex items-center gap-1.5">
                  {!plan.consentAt ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">مسوّدة</span>
                  ) : null}
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
                    {PLAN_STATUS_LABEL[plan.status]}
                  </span>
                </span>
              </div>

              <div className="mb-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="text-sm font-bold">{formatMoney(plan.totalMinor, base)}</p>
                  <p className="text-[11px] text-slate-500">
                    {plan.installments.length > 0 ? "الإجمالي" : "المتفق عليه"}
                  </p>
                </div>
                {plan.installments.length > 0 && canSeeFinancial ? (
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

              {plan.installments.length > 0 && canSeeFinancial ? (
                <>
                  <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full bg-emerald-500"
                      style={{ width: `${Math.min(100, Math.round((plan.progress.paidMinor / Math.max(1, plan.totalMinor)) * 100))}%` }} />
                  </div>
                  <p className="mb-2 text-[11px] text-slate-500">
                    {plan.progress.paidCount} من {plan.progress.count} أقساط
                    {plan.progress.nextDueDate ? ` · القادم ${friendlyDateLong(plan.progress.nextDueDate)}` : ""}
                    {" · "}
                    <a href={`?tab=account`}
                      className="font-bold text-navy-800 underline decoration-navy-300 underline-offset-4">
                      سنداتها فواتير ودفعات في كشف الحساب
                    </a>
                  </p>
                </>
              ) : null}

              {canSeeFinancial && plan.progress.overdueMinor > 0 ? (
                <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
                  متأخر: {formatMoney(plan.progress.overdueMinor, base)}
                </p>
              ) : null}

              {canSeeFinancial && plan.status === "active" && plan.installments.length > 0 ? (
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
                        setPayAmount(suggested ? toInputAmount(suggested, base) : "");
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
                <PlanItems plan={plan} base={base} canSeeFinancial={canSeeFinancial}
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

              {plan.consentAt ? (
                <p className="mt-2 text-[10px] font-semibold text-slate-400">
                  وافق المريض في {friendlyDateLong(plan.consentAt.slice(0, 10))}
                  {plan.consentBy ? ` · سجّلها ${plan.consentBy}` : ""}
                  {plan.consentNote ? ` · ${plan.consentNote}` : ""}
                </p>
              ) : null}

              {canSeeFinancial && plan.installments.length > 0 ? (
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

      {/* الزيارات المخطَّطة — توزيع الخطة على الزيارات (المواصفة §١٠) */}
      {plannedVisits.length > 0 ? (
        <section className="mt-4" aria-label="توزيع الخطة على الزيارات">
          <h3 className="mb-2 text-xs font-extrabold text-navy-900">
            توزيع الخطة على الزيارات ({plannedVisits.length})
          </h3>
          <ul className="space-y-1.5">
            {plannedVisits.map((visit) => (
              <li key={visit.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-navy-900">
                    زيارة {visit.sequence}: {visit.title}
                    {visit.planTitle ? <span className="font-normal text-slate-500"> · {visit.planTitle}</span> : null}
                  </span>
                  <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                    {PLANNED_VISIT_STATUS_LABEL[visit.status]} · {visit.durationMinutes} دقيقة
                  </span>
                </div>
                {visit.appointmentDate ? (
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    محجوزة {friendlyDateLong(visit.appointmentDate)} · {visit.appointmentTime}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    تُجدوَل بتاريخٍ ووقت فقط من تبويب الملخص
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * نموذج الخطة الموحَّد — الرحلة V2.
 *
 * الأقسام الثلاثة (§٧): البيانات، البنود العلاجية بقواعد الفوترة وجلساتها، ثم
 * طريقة التسعير وطريقة الدفع. والإجمالي يُشتقّ من البنود حيثما وُجدت بنود —
 * رقمان لعملٍ واحد هما بذرة كل خلافٍ لاحق مع المريض.
 */
function NewPlanFormV2({ patientId, base, busy, onSaved, onError }: {
  patientId: number; base: Currency; busy: boolean;
  onSaved: () => void; onError: (message: string | null) => void;
}) {
  const today = clinicDateString(new Date(), "Asia/Aden");
  const [title, setTitle] = useState("خطة علاج ترميمي");
  const [specialty, setSpecialty] = useState(SPECIALTIES[0]);
  const [doctorId, setDoctorId] = useState<string>("");
  const [startDate, setStartDate] = useState(today);
  const [rows, setRows] = useState<PlanItemDraftRow[]>([]);
  const [pricingMode, setPricingMode] = useState<"items" | "agreed">("items");
  const [agreedTotal, setAgreedTotal] = useState("");
  const [paymentMode, setPaymentMode] = useState<"per_procedure" | "installments" | "custom">("per_procedure");
  const [installmentCount, setInstallmentCount] = useState("12");
  const [everyDays, setEveryDays] = useState("30");
  const [customInstallments, setCustomInstallments] = useState<{ dueDate: string; amount: string }[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const [services, setServices] = useState<Service[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);

  useEffect(() => {
    void (async () => {
      const [serviceResponse, doctorResponse] = await Promise.all([
        fetch("/api/services", { cache: "no-store" }),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }),
      ]);
      if (serviceResponse.ok) {
        const payload = await serviceResponse.json();
        setServices((payload.services ?? payload) as Service[]);
      }
      if (doctorResponse.ok) {
        const payload = await doctorResponse.json();
        setDoctors(Array.isArray(payload) ? payload : payload.balances ?? []);
      }
    })();
  }, []);

  const itemsTotalMinor = rows.reduce((sum, row) => {
    const service = services.find((item) => String(item.id) === row.serviceId);
    const typed = row.price.trim() ? parseAmount(row.price, base) : null;
    const unit = typed ?? (service ? service.priceMinor : 0);
    return sum + unit * Math.max(1, Math.round(Number(row.quantity) || 1));
  }, 0);
  const agreedTotalMinor = pricingMode === "agreed" ? (parseAmount(agreedTotal, base) ?? 0) : 0;
  const planTotalMinor = pricingMode === "items" ? itemsTotalMinor : agreedTotalMinor;

  const previewInstallments = paymentMode === "installments" && planTotalMinor > 0
    ? splitInstallments(planTotalMinor, Number(installmentCount) || 1, startDate, Number(everyDays) || 30)
    : [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || busy) return;
    setSaving(true);
    onError(null);

    const items = rows
      .filter((row) => row.serviceId)
      .map((row) => {
        const service = services.find((item) => String(item.id) === row.serviceId);
        const typed = row.price.trim() ? parseAmount(row.price, base) : null;
        return {
          serviceId: Number(row.serviceId),
          serviceName: service?.name ?? "",
          category: service?.category ?? null,
          toothCode: row.tooth.trim() ? Number(row.tooth.trim()) : null,
          surfaces: row.surfaces.trim() || null,
          quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
          unitPriceMinor: typed ?? (service ? service.priceMinor : 0),
          billingRule: row.billingRule,
          sessionCount: Math.max(1, Math.round(Number(row.sessions) || 1)),
          note: null,
        };
      });

    if (items.length === 0 && paymentMode !== "installments" && pricingMode !== "agreed") {
      onError("أضف بندًا واحدًا على الأقل، أو اختر طريقة تسعيرٍ بمبلغٍ متفق عليه.");
      setSaving(false);
      return;
    }

    const installments =
      paymentMode === "installments"
        ? splitInstallments(planTotalMinor, Number(installmentCount) || 1, startDate, Number(everyDays) || 30)
            .map((part) => ({ dueDate: part.dueDate, amountMinor: part.amountMinor }))
        : paymentMode === "custom"
          ? customInstallments
              .map((row) => ({
                dueDate: row.dueDate,
                amountMinor: parseAmount(row.amount, base) ?? 0,
              }))
              .filter((row) => row.dueDate && row.amountMinor > 0)
          : [];

    try {
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "v2",
          patientId,
          title, specialty,
          primaryDoctorId: doctorId ? Number(doctorId) : null,
          startDate,
          note: note.trim() || null,
          items,
          billingMode: paymentMode === "per_procedure" ? "per_procedure"
            : paymentMode === "installments" ? "installments" : "custom_schedule",
          total: pricingMode === "agreed" ? agreedTotal : undefined,
          count: paymentMode === "installments" ? Number(installmentCount) : undefined,
          everyDays: paymentMode === "installments" ? Number(everyDays) : undefined,
          installments: installments.length > 0 ? installments : undefined,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر حفظ الخطة."); return; }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-4 rounded-2xl border border-navy-800 bg-white p-4">
      <h3 className="mb-1 text-sm font-extrabold text-navy-900">خطة علاج جديدة</h3>
      <p className="mb-3 text-[11px] leading-4 text-slate-500">
        تُبنى بالبنود والجلسات والزيارات المخطَّطة في عمليةٍ واحدة. الخطة اتفاقٌ لا
        دَين: لا يدخل الحساب إلا ما نُفِّذ ووُلِّد استحقاقه وفق قاعدة الفوترة.
      </p>

      {/* ١) البيانات */}
      <input value={title} onChange={(event) => setTitle(event.target.value)}
        placeholder="اسم الخطة — مثل: علاج ترميمي شامل" aria-label="اسم الخطة"
        className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <div className="mb-3 flex flex-wrap gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">التخصص</span>
          <select value={specialty} onChange={(event) => setSpecialty(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            {SPECIALTIES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className="flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب المعالج</span>
          <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="">—</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
        <label className="w-40">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">تاريخ البدء</span>
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
      </div>

      {/* ٢) البنود العلاجية — بقاعدة فوترةٍ وعدد جلسات لكل بند */}
      {rows.map((row, index) => {
        const service = services.find((item) => String(item.id) === row.serviceId);
        const typed = row.price.trim() ? parseAmount(row.price, base) : null;
        const unit = typed ?? (service ? service.priceMinor : 0);
        const sessions = Math.max(1, Math.round(Number(row.sessions) || 1));
        return (
          <div key={index} className="mb-2 space-y-1.5 rounded-xl border border-slate-100 bg-slate-50/50 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[12rem] flex-1">
                <ServiceSelect
                  services={services}
                  value={row.serviceId ? Number(row.serviceId) : null}
                  onChange={(id, srv) => {
                    setRows((current) => current.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            serviceId: id ? String(id) : "",
                            price: srv ? formatAmount(srv.priceMinor, base) : "",
                          }
                        : item));
                  }}
                  base={base}
                  placeholder="— اختر الإجراء من الدليل —"
                  ariaLabel="الإجراء"
                />
              </div>
              <input value={row.tooth} onChange={(event) =>
                setRows((current) => current.map((item, i) => i === index ? { ...item, tooth: event.target.value } : item))}
                placeholder="السن" aria-label="رقم السن" inputMode="numeric" dir="ltr"
                className="w-20 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm" />
              <input value={row.quantity} onChange={(event) =>
                setRows((current) => current.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))}
                placeholder="1" aria-label="الكمية" inputMode="numeric" dir="ltr"
                className="w-16 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm" />
              <input value={row.price} onChange={(event) =>
                setRows((current) => current.map((item, i) => i === index ? { ...item, price: event.target.value } : item))}
                placeholder="السعر" aria-label="السعر" inputMode="decimal" dir="ltr"
                className="w-24 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-bold" />
              <button type="button"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-bold text-red-500 hover:bg-red-50"
                title="حذف البند">✕</button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <label className="flex items-center gap-1 font-bold text-slate-600">
                قاعدة الفوترة:
                <select value={row.billingRule}
                  onChange={(event) => setRows((current) => current.map((item, i) =>
                    i === index ? { ...item, billingRule: event.target.value as BillingRule } : item))}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px]">
                  {BILLING_RULES.map((rule) => <option key={rule} value={rule}>{BILLING_RULE_LABEL[rule]}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1 font-bold text-slate-600">
                الجلسات:
                <input value={row.sessions} inputMode="numeric" dir="ltr"
                  onChange={(event) => setRows((current) => current.map((item, i) =>
                    i === index ? { ...item, sessions: event.target.value } : item))}
                  className="w-12 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px]" />
              </label>
              {unit > 0 && sessions > 1 && row.billingRule === "per_session" ? (
                <span className="text-slate-500">
                  لكل جلسة ≈ {formatAmount(Math.floor(unit / sessions), base)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap gap-2">
        <button type="button"
          onClick={() => setRows((current) => [
            ...current,
            { serviceId: "", tooth: "", quantity: "1", price: "", sessions: "1", surfaces: "", billingRule: "on_completion" },
          ])}
          className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
          + بند علاجي
        </button>
      </div>

      {/* ٣) طريقة التسعير */}
      <fieldset className="mt-3 mb-2 rounded-xl border border-slate-200 p-2.5">
        <legend className="px-1 text-[11px] font-extrabold text-slate-600">طريقة التسعير</legend>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setPricingMode("items")}
            className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
              pricingMode === "items" ? "border-navy-800 bg-navy-50 text-navy-900" : "border-slate-200 bg-white text-slate-600"
            }`}>
            حسب البنود — الإجمالي مشتقّ منها
          </button>
          <button type="button" onClick={() => setPricingMode("agreed")}
            className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
              pricingMode === "agreed" ? "border-navy-800 bg-navy-50 text-navy-900" : "border-slate-200 bg-white text-slate-600"
            }`}>
            مبلغ إجمالي متفق عليه
          </button>
        </div>
        {pricingMode === "agreed" ? (
          <input value={agreedTotal} onChange={(event) => setAgreedTotal(event.target.value)}
            placeholder="المبلغ الإجمالي المتفق عليه" aria-label="المبلغ المتفق عليه"
            inputMode="decimal" dir="ltr"
            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
        ) : (
          <p className="mt-1.5 text-[11px] text-slate-500">
            الإجمالي من البنود: <span className="font-extrabold text-navy-900">{formatMoney(itemsTotalMinor, base)}</span>
          </p>
        )}
      </fieldset>

      {/* ٤) طريقة الدفع */}
      <fieldset className="mb-3 rounded-xl border border-slate-200 p-2.5">
        <legend className="px-1 text-[11px] font-extrabold text-slate-600">طريقة الدفع</legend>
        <div className="flex flex-wrap gap-2">
          {([
            ["per_procedure", "حسب الخدمات المنفَّذة"],
            ["installments", "دفعة أولى + أقساط"],
            ["custom", "جدول دفعات مخصص"],
          ] as const).map(([mode, label]) => (
            <button key={mode} type="button" onClick={() => setPaymentMode(mode)}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
                paymentMode === mode ? "border-navy-800 bg-navy-50 text-navy-900" : "border-slate-200 bg-white text-slate-600"
              }`}>
              {label}
            </button>
          ))}
        </div>

        {paymentMode === "installments" ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <input value={installmentCount} onChange={(event) => setInstallmentCount(event.target.value)}
              placeholder="عدد الأقساط" aria-label="عدد الأقساط" inputMode="numeric" dir="ltr"
              className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            <input value={everyDays} onChange={(event) => setEveryDays(event.target.value)}
              placeholder="كل كم يوم" aria-label="المدة بين الأقساط" inputMode="numeric" dir="ltr"
              className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          </div>
        ) : null}

        {paymentMode === "custom" ? (
          <div className="mt-2 space-y-1.5">
            {customInstallments.map((row, index) => (
              <div key={index} className="flex gap-2">
                <input type="date" value={row.dueDate}
                  onChange={(event) => setCustomInstallments((current) =>
                    current.map((item, i) => i === index ? { ...item, dueDate: event.target.value } : item))}
                  aria-label="تاريخ الدفعة"
                  className="w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                <input value={row.amount} inputMode="decimal" dir="ltr"
                  onChange={(event) => setCustomInstallments((current) =>
                    current.map((item, i) => i === index ? { ...item, amount: event.target.value } : item))}
                  placeholder="المبلغ" aria-label="مبلغ الدفعة"
                  className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
                <button type="button"
                  onClick={() => setCustomInstallments((current) => current.filter((_, i) => i !== index))}
                  className="rounded-xl border border-slate-200 px-2.5 py-2 text-sm font-bold text-red-500">✕</button>
              </div>
            ))}
            <button type="button"
              onClick={() => setCustomInstallments((current) => [...current, { dueDate: startDate, amount: "" }])}
              className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
              + دفعة
            </button>
          </div>
        ) : null}

        {previewInstallments.length > 0 ? (
          <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            {previewInstallments.length} قسطًا · الأول {formatMoney(previewInstallments[0].amountMinor, base)} في{" "}
            {friendlyDateLong(previewInstallments[0].dueDate)} · الأخير في{" "}
            {friendlyDateLong(previewInstallments[previewInstallments.length - 1].dueDate)}
          </p>
        ) : null}
      </fieldset>

      <input value={note} onChange={(event) => setNote(event.target.value)}
        placeholder="ملاحظة (اختياري)" aria-label="ملاحظة"
        className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />

      <p className="mb-3 text-sm font-extrabold text-navy-900">
        إجمالي الخطة: {formatMoney(planTotalMinor, base)}
      </p>

      <button type="submit" disabled={saving || busy || planTotalMinor <= 0}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
        {saving ? "جارٍ الحفظ…" : "أنشئ الخطة بجلساتها وزياراتها"}
      </button>
    </form>
  );
}

interface PlanItemDraftRow {
  serviceId: string; tooth: string; quantity: string;
  price: string; sessions: string; surfaces: string; billingRule: BillingRule;
}

/**
 * بنود الخطة — المسوّدة تُبنى، ثم تُقفل بالموافقة.
 *
 * قبل الموافقة: تُضاف البنود وتُحذف بحرّية، والإجمالي يتحرّك معها. وبعدها: قائمةٌ
 * للقراءة تُطبع ويُوقّع عليها المريض. والفرق بين الحالتين ظاهرٌ في الشاشة نفسها —
 * لا في رأس من يستعملها.
 */
function PlanItems({ plan, base, canSeeFinancial, onChanged, onError }: {
  plan: Plan; base: Currency; canSeeFinancial: boolean;
  onChanged: () => void; onError: (message: string | null) => void;
}) {
  const [services, setServices] = useState<Service[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [tooth, setTooth] = useState("");
  const [surfaces, setSurfaces] = useState("");
  /* تنظيم الجلسات: الجلسة الهدف وعدد جلسات البند وقاعدة فوترته وطبيبه. */
  const [targetVisitNumber, setTargetVisitNumber] = useState("1");
  const [sessionCount, setSessionCount] = useState("1");
  const [billingRule, setBillingRule] = useState<BillingRule>("on_completion");
  const [doctorId, setDoctorId] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = Boolean(plan.consentAt);
  const visitGroups = groupItemsByVisit(plan.items);

  useEffect(() => {
    if (locked) return;
    void (async () => {
      try {
        const [servRes, docRes] = await Promise.all([
          fetch("/api/services", { cache: "no-store" }),
          fetch("/api/parties?kind=doctor", { cache: "no-store" }),
        ]);
        if (servRes.ok) {
          const payload = await servRes.json();
          const list = (payload.services ?? payload) as Service[];
          setServices(list);
          setServiceId((current) => current ?? list[0]?.id ?? null);
        }
        if (docRes.ok) {
          const docPayload = await docRes.json();
          setDoctors(Array.isArray(docPayload) ? docPayload : (docPayload.balances ?? []));
        }
      } catch {
        /* قوائم مساعدة — فشلها لا يعطّل البنود. */
      }
    })();
  }, [locked]);

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
          plannedVisitNumber: Math.max(1, Number(targetVisitNumber) || 1),
          sessionCount: Math.max(1, Number(sessionCount) || 1),
          billingRule,
          doctorId: doctorId ? Number(doctorId) : null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر إضافة البند."); return; }
      setTooth("");
      setSurfaces("");
      setSessionCount("1");
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
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-bold text-slate-500">
          بنود الخطة {locked ? "— موافَقٌ عليها فلا تُعدَّل" : "— الإجمالي يُحسب منها"}
        </p>
        <span className="text-[10px] font-bold text-slate-400">
          {visitGroups.length > 0 ? `${visitGroups.length} جلسات مخططة` : ""}
        </span>
      </div>

      {visitGroups.length === 0 ? (
        <p className="text-xs text-slate-400">لا بنود بعد.</p>
      ) : (
        <div className="mb-2 space-y-2">
          {visitGroups.map((group) => {
            const allDone = group.allDone;
            const hasDone = group.doneCount > 0;
            return (
              <div key={group.visitNumber}
                className={`rounded-xl border p-2.5 ${
                  allDone
                    ? "border-emerald-200 bg-emerald-50/40"
                    : hasDone
                      ? "border-amber-200 bg-amber-50/20"
                      : "border-slate-200 bg-white/60"
                }`}>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/60 pb-1.5">
                  <div className="flex items-center gap-2">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-lg text-[10px] font-black ${
                      allDone ? "bg-emerald-600 text-white" : "bg-navy-800 text-white"
                    }`}>
                      {allDone ? "✓" : group.visitNumber}
                    </span>
                    <span className="text-[11px] font-black text-navy-900">الجلسة المخططة {group.visitNumber}</span>
                    <span className="text-[10px] text-slate-500">
                      ({group.items.length} إجراء · {formatMoney(group.totalMinor, base)})
                    </span>
                  </div>
                  {group.allDone ? (
                    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">مكتملة</span>
                  ) : null}
                </div>
                <ul className="space-y-1">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
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
                        {(item.sessionCount ?? 1) > 1 ? (
                          <span className="shrink-0 text-slate-400">· جلسة {item.sessionsCompleted ?? 0}/{item.sessionCount ?? 1}</span>
                        ) : null}
                        {item.billingStatus === "billed" ? (
                          <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[9px] font-bold text-sky-700">مفوتر</span>
                        ) : item.billingStatus === "included_in_package" ? (
                          <span className="shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold text-purple-700">ضمن الباقة</span>
                        ) : item.billingStatus === "waived" ? (
                          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">معفى</span>
                        ) : null}
                        {item.doctorName ? (
                          <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">{item.doctorName}</span>
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
              </div>
            );
          })}
        </div>
      )}

      {locked ? (
        plan.itemsProgress.count > 0 ? (
          <p className="text-[11px] font-bold text-slate-500">
            أُنجز {plan.itemsProgress.doneCount} من {plan.itemsProgress.count} بنود ·{" "}
            {formatMoney(plan.itemsProgress.doneMinor, base)} من {formatMoney(plan.itemsProgress.totalMinor, base)}
          </p>
        ) : null
      ) : (
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">اختر الخدمة (مصنفة حسب الاختصاص)</span>
              <ServiceSelect
                services={services}
                value={serviceId}
                onChange={(id) => setServiceId(id || null)}
                base={base}
                placeholder="— اختر الخدمة لإضافتها للخطة —"
                ariaLabel="خدمة الخطة"
              />
            </div>
            <label className="w-16">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">الجلسة #</span>
              <input value={targetVisitNumber} onChange={(event) => setTargetVisitNumber(event.target.value)}
                aria-label="رقم الجلسة المخططة" inputMode="numeric" dir="ltr" placeholder="1" min="1"
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-semibold text-center" />
            </label>
            <label className="w-20">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">السن</span>
              <input value={tooth} onChange={(event) => setTooth(event.target.value)}
                aria-label="سن البند" inputMode="numeric" dir="ltr" placeholder="16"
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-semibold text-center" />
            </label>
            <label className="w-20">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">الأسطح</span>
              <input value={surfaces} onChange={(event) => setSurfaces(event.target.value)}
                aria-label="أسطح البند" dir="ltr" placeholder="MO"
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-semibold text-center" />
            </label>
            <label className="w-20">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">عدد الجلسات</span>
              <input value={sessionCount} onChange={(event) => setSessionCount(event.target.value)}
                aria-label="عدد جلسات البند" inputMode="numeric" dir="ltr" placeholder="1" min="1"
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-semibold text-center" />
            </label>
            <button onClick={() => void add()} disabled={busy || !serviceId}
              className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-extrabold text-white transition-opacity hover:opacity-90 disabled:opacity-40">
              + أضف للخطة
            </button>
          </div>
          {/* تنظيم الجلسة: قاعدة الفوترة والطبيب — السطر الثاني من النموذج. */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[12rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">قاعدة الفوترة</span>
              <select value={billingRule} onChange={(event) => setBillingRule(event.target.value as BillingRule)}
                aria-label="قاعدة فوترة البند"
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs font-semibold">
                {BILLING_RULES.map((rule) => (
                  <option key={rule} value={rule}>{BILLING_RULE_LABEL[rule]}</option>
                ))}
              </select>
            </label>
            <label className="min-w-[10rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">الطبيب المسؤول عن البند</span>
              <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}
                aria-label="طبيب البند"
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs font-semibold">
                <option value="">— طبيب الخطة الافتراضي —</option>
                {doctors.map((doc) => (
                  <option key={doc.id} value={doc.id}>{doc.name}</option>
                ))}
              </select>
            </label>
          </div>
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
