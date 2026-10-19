"use client";

import TreatmentFinancialContext from "./TreatmentFinancialContext";
import { ApprovedAgreementPanel } from "./ApprovedAgreementPanel";
import { INITIAL_PLAN_ITEM_DRAFT, planItemDraftChanged, type PlanItemDraftSnapshot } from "@/lib/plan-item-draft-navigation";
import type { ClinicalNavigationContext } from "@/lib/patient-navigation";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMoneyAttempt } from "./useMoneyAttempt";
import { MoneyAttemptNotice } from "./MoneyAttemptNotice";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  CURRENCY_SHORT,
  formatMoney,
  parseAmount,
  toInputAmount,
  type Currency,
} from "@/lib/money";
import { PLAN_STATUS_LABEL, groupItemsByVisit, type BillingStatus, type PlanItemStatus, type PlanStatus } from "@/lib/plans";
import {
  BILLING_RULE_LABEL, BILLING_RULES, PLANNED_VISIT_STATUS_LABEL,
  type BillingRule, type PlannedVisitStatus,
} from "@/lib/workflow";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { ServiceSelect } from "./ServiceSelect";
import { ToothField } from "./ToothPicker";
import { useSession } from "./SessionProvider";
import { canHandleMoney } from "@/lib/roles";
import { ReceiptCorrectionLauncher } from "./ReceiptCorrectionLauncher";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { LegacyOrthoPlanContext } from "./LegacyOrthoPlanContext";
import { hasLegacyHistory, legacyCoverageIsLive, ordinaryPlanProgress, planConsentIsCurrent, type HistoricalPlanItem } from "./legacy-treatment-view";
import { LegacyPlanHistory } from "./LegacyPlanHistory";

/** Existing plans and clinical drafts remain here. New financial treatment is
 * created only through the Account invoice / historical-agreement entry. */

interface Service { id: number; name: string; category: string | null; priceMinor: number }
interface Doctor { id: number; name: string }

interface PlanItem extends HistoricalPlanItem {
  id: number; serviceId: number | null; serviceName: string; toothCode: number | null; surfaces: string | null;
  quantity: number; unitPriceMinor: number; totalMinor: number;
  status: PlanItemStatus; visitId: number | null; caseId?: number | null;
  /* تنظيم الجلسات: رقم الجلسة المخططة وقاعدة الفوترة وحالتها والجلسات المنجزة وطبيب البند. */
  plannedVisitNumber?: number; billingRule?: BillingRule;
  billingStatus?: BillingStatus; sessionCount?: number;
  sessionsCompleted?: number; doctorId?: number | null; doctorName?: string | null;
  /** Historical identity persists after void; it does not establish progress or consent. */
  legacyAgreementId?: number;
  legacyAgreementStatus?: "live" | "void";
}
interface Plan {
  approvedAgreement?: Awaited<ReturnType<typeof import("@/lib/approved-agreements").approvedAgreementPosition>>;
  id: number; title: string; totalMinor: number; baseCurrency: Currency;
  status: PlanStatus; startDate: string; note: string | null;
  items: PlanItem[];
  itemsProgress: { count: number; doneCount: number; totalMinor: number; doneMinor: number; remainingMinor: number };
  totalFromItems: boolean;
  consentAt: string | null; consentBy: string | null; consentNote: string | null;
  invoiceFinancial?: import("@/lib/plan-financial-position").PlanInvoiceFinancialPosition | null;
  installments: { id: number; number: number; dueDate: string; amountMinor: number }[];
  hasInstallments?: boolean;
  paidMinor: number | null;
  progress: {
    totalMinor: number; dueToDateMinor: number; paidMinor: number; remainingMinor: number;
    overdueMinor: number; nextDueDate: string | null; nextDueAmountMinor: number;
    paidCount: number; count: number;
  } | null;
}
interface PlannedVisit {
  id: number; planTitle: string | null; sequence: number; title: string;
  doctorName: string | null; durationMinutes: number; status: PlannedVisitStatus;
  appointmentDate: string | null; appointmentTime: string | null; note: string | null;
}


interface PatientPlansProps {
  patientId: number; context?: ClinicalNavigationContext;
  onOpenClinicalContext?: (context: ClinicalNavigationContext, target?: string) => unknown;
  onNavigationGuardChange?: (guard: () => boolean) => () => void;
  onOpenTreatmentEntry?: () => unknown;
}
export function PatientPlans({ patientId, ...props }: PatientPlansProps) {
  const session = useSession();
  // A new patient, principal or permission snapshot owns fresh state. In
  // particular A → B → A cannot resurrect A's previously visible collections.
  const scope = JSON.stringify([patientId, session?.username, session?.role, session?.permissions ?? null]);
  if (!session || (session.role === "doctor" && session.permissions?.canViewPlans === false)) {
    return <p role="status" className="rounded-xl border border-slate-200 p-4 text-sm text-slate-500">غير مصرّح لك بعرض خطط العلاج.</p>;
  }
  return <PatientPlansContent key={scope} patientId={patientId} {...props} />;
}

function PatientPlansContent({ patientId, context, onOpenClinicalContext, onNavigationGuardChange, onOpenTreatmentEntry }: PatientPlansProps) {
  const session = useSession();
  const financialAuthority = JSON.stringify([session?.username, session?.role, session?.permissions ?? null]);
  // (TD-05) الأساس دستوري من الكود — وعملة كل خطةٍ تُعرض بعملتها هي.
  const fallback: Currency = CLINIC_BASE_CURRENCY;
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plannedVisits, setPlannedVisits] = useState<PlannedVisit[]>([]);
  const [canSeeFinancial, setCanSeeFinancial] = useState(false);
  const [loading, setLoading] = useState(true);
  const [readUnavailable, setReadUnavailable] = useState(false);
  const [readDenied, setReadDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [payFor, setPayFor] = useState<number | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payCurrency, setPayCurrency] = useState<Currency>(fallback);
  const [lastReceipt, setLastReceipt] = useState<number | null>(null);
  const [lastReceiptIsInstallment, setLastReceiptIsInstallment] = useState(true);
  const [consentFor, setConsentFor] = useState<number | null>(null);

  const readRef = useRef({ active: false, generation: 0, controller: null as AbortController | null });
  const load = useCallback(async () => {
    const lifetime = readRef.current;
    if (!lifetime.active) return;
    const generation = ++lifetime.generation;
    lifetime.controller?.abort();
    const controller = new AbortController();
    lifetime.controller = controller;
    const current = () => lifetime.active && lifetime.generation === generation && !controller.signal.aborted;
    // Refresh is unknown authority: retire the old snapshot before awaiting
    // headers/body. Clinical authoring drafts stay in this same scoped child.
    setCanSeeFinancial(false);
    setLoading(true); setReadUnavailable(false); setError(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/plans`, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      // Never wait on a denied body's transport before retiring cached data.
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setReadDenied(true); setLastReceipt(null); setPayFor(null); setPayAmount("");
          setPlans([]); setPlannedVisits([]); setConsentFor(null);
        }
        throw new Error(response.status === 401 || response.status === 403
          ? "غير مصرّح لك بعرض خطط العلاج." : "تعذّر تحميل الخطط.");
      }
      const payload = await response.json();
      if (!current()) return;
      if (!Array.isArray(payload?.plans)) throw new Error("تعذّر التحقق من بيانات الخطط.");
      setReadDenied(false);
      if (payload.canSeeFinancial !== true) { setLastReceipt(null); setPayFor(null); setPayAmount(""); }
      setPlans(payload.plans as Plan[]);
      setPlannedVisits(Array.isArray(payload.plannedVisits) ? payload.plannedVisits : []);
      setCanSeeFinancial(payload.canSeeFinancial === true);
      setError(null);
    } catch (loadError) {
      if (!current()) return;
      setReadUnavailable(true);
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      if (current()) setLoading(false);
    }
  }, [patientId]);

  useLayoutEffect(() => {
    const lifetime = readRef.current;
    lifetime.active = true;
    void load();
    const refresh = () => { void load(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      lifetime.active = false;
      lifetime.generation += 1;
      lifetime.controller?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  // DOT-PF-01: share pending collections with the patient collection modal.
  const money = useMoneyAttempt(`collection:${patientId}`, canSeeFinancial && !readUnavailable && !readDenied, `collection:${patientId}`, {patientId});

  const itemGuards = useRef(new Map<number, () => boolean>());
  const registerItemGuard = useCallback((planId: number, guard: () => boolean) => {
    itemGuards.current.set(planId, guard);
    return () => { if (itemGuards.current.get(planId) === guard) itemGuards.current.delete(planId); };
  }, []);
  const canLeave = useCallback(() => {
    if (!readRef.current.active || busy || money.attempt !== null) return false;
    for (const guard of itemGuards.current.values()) if (!guard()) return false;
    return !(consentFor !== null || payFor !== null)
      || window.confirm("هناك مسودة خطة أو تحصيل غير محفوظة. هل تريد مغادرة القسم؟");
  }, [busy, money.attempt, consentFor, payFor]);
  useLayoutEffect(() => onNavigationGuardChange?.(canLeave), [canLeave, onNavigationGuardChange]);
  const completionAllowed = useRef<(id: number) => boolean>(() => false);
  const completionReadGeneration = readRef.current.generation;
  completionAllowed.current = (id) => readRef.current.active && readRef.current.generation === completionReadGeneration
    && !loading && !readUnavailable && !readDenied && canSeeFinancial && canHandleMoney(session?.role)
    && money.ready && !busy && money.attempt === null && plans.some(plan => plan.id === id && plan.status === "active") && canLeave();

  const visiblePlans = plans.filter((plan) => (context?.planId === undefined || plan.id === context.planId)
    && (context?.planItemId === undefined || plan.items.some((item) => item.id === context.planItemId))
    && (context?.clinicalCaseId === undefined || plan.items.some((item) => item.caseId === context.clinicalCaseId)));
  const openItem = (planId: number, item: PlanItem, target?: string) => {
    if (!readRef.current.active || loading || readDenied || readUnavailable || !onOpenClinicalContext) return;
    if (!onNavigationGuardChange && !canLeave()) return;
    onOpenClinicalContext({ patientId, planId, planItemId: item.id, ...(item.caseId != null ? { clinicalCaseId: item.caseId } : {}) }, target);
  };

  const collect = async (plan?: Plan) => {
    if (!readRef.current.active || busy) return;
    const source = plan?.approvedAgreement;
    const body = JSON.stringify({ patientId, kind: "payment", amount: payAmount, currency: payCurrency,
      ...(source ? {invoiceId:source.invoiceId,openingCurrency:source.openingCurrency} : {planId:plan?.id}) });
    setBusy(true);
    try {
      const result = await money.run(plan ? { url: "/api/payments", body, operation: "payment" } : undefined);
      if (!result || result.kind === "busy") return;
      if (result.kind !== "confirmed") { setError(result.message); return; }
      setLastReceipt(result.acknowledgment.paymentId);
      setLastReceiptIsInstallment(result.attempt.request.operation === "installment");
      money.consume(result.attempt);
      setPayFor(null);
      setPayAmount("");
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم. أعد المحاولة — لن يُسجَّل القسط مرتين.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="patient-plans-content">
      <TreatmentFinancialContext patientId={patientId} authorityKey={financialAuthority} canView={canSeeFinancial && !loading && !readDenied && !readUnavailable}
        planId={context?.planId} planItemId={context?.planItemId} clinicalCaseId={context?.clinicalCaseId} orthoCaseId={context?.orthoCaseId}
        onOpenClinicalContext={onOpenClinicalContext ? (reference) => { if (!onNavigationGuardChange && !canLeave()) return; onOpenClinicalContext(reference); } : undefined} />
      {!loading && !readDenied && !readUnavailable && visiblePlans.length === 0 && (context?.planId !== undefined || context?.planItemId !== undefined || context?.clinicalCaseId !== undefined) ? <p role="status" data-testid="plan-context-unavailable" className="rounded-xl border border-amber-300 p-3 text-sm">لا توجد خطة متاحة مرتبطة بهذا المرجع. لم يتم اختيار خطة أخرى.</p> : null}
      {canSeeFinancial && !readUnavailable && !readDenied ? (
        <><MoneyAttemptNotice attempt={money.attempt} onRetry={() => void collect()} />
        {money.error ? <p role="alert">{money.error}</p> : null}</>
      ) : null}
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-red-700 text-red-700">{error}</p>
      ) : null}

      {lastReceipt && canSeeFinancial ? (
        <div className="mb-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
          <p className="mb-2 text-sm font-bold text-emerald-800">{lastReceiptIsInstallment ? "سُجّل القسط." : "سُجّلت الدفعة."}</p>
          <div className="flex flex-wrap items-start justify-center gap-2">
            <a href={`/print/receipt/${lastReceipt}`} target="_blank" rel="noopener"
              onClick={() => setLastReceipt(null)}
              className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
              اطبع السند
            </a>
            {/* (RC-2) قسطٌ بمبلغٍ خطأ يُصحَّح هنا — ويبقى على خطته وفاتورته. */}
            <ReceiptCorrectionLauncher key={lastReceipt} paymentId={lastReceipt} patientId={patientId} label="المبلغ خطأ؟ صحّح السند"
              onDone={(_message, replacementId) => { setLastReceipt(replacementId); void load(); }} />
          </div>
        </div>
      ) : null}

      {!readDenied ? <LegacyOrthoPlanContext patientId={patientId} onOpenClinicalContext={onOpenClinicalContext ? (reference) => { if (!onNavigationGuardChange && !canLeave()) return; onOpenClinicalContext(reference); } : undefined} /> : null}

      <div className="mb-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
        <p className="text-sm font-bold">إنشاء العلاج من الفاتورة / الاتفاق</p>
        <p className="mt-1 text-xs text-slate-600">اختر علاجًا جديدًا أو علاجًا بدأ قبل النظام من حساب المريض. السجلات والخطط القائمة محفوظة هنا؛ إضافة مسودة سريرية لا تسجّل فاتورة أو دفعة.</p>
        {onOpenTreatmentEntry ? <button type="button" disabled={loading || readUnavailable || readDenied}
          data-testid="plans-open-treatment-entry" onClick={() => {
            if (!readRef.current.active || loading || readUnavailable || readDenied) return;
            if (!onNavigationGuardChange && !canLeave()) return;
            onOpenTreatmentEntry();
          }} className="mt-2 min-h-11 rounded-xl bg-navy-800 px-4 py-2 text-sm font-bold text-white">فاتورة / اتفاق علاج</button> : null}
      </div>

      {loading && plans.length > 0 ? (
        <p role="status" className="mb-2 text-xs text-slate-500">جارٍ تحديث الخطط…</p>
      ) : null}
      {loading && plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : readUnavailable && plans.length === 0 ? null : plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا توجد خطط علاج جديدة مسجّلة هنا. تُنشأ الخطة عند الاتفاق على علاج جديد.
        </p>
      ) : (
        <ul className="space-y-3">
          {visiblePlans.map((plan) => {
            const hasHistory = plan.items.some(hasLegacyHistory);
            const currentConsent = planConsentIsCurrent(plan);
            const coverageVerified = plan.items.filter(hasLegacyHistory).every(legacyCoverageIsLive);
            const ordinaryProgress = hasHistory ? ordinaryPlanProgress(plan.items) : plan.itemsProgress;
            return (
            <li key={plan.id} className={`rounded-2xl border p-4 ${
              plan.status === "active" ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
            }`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-base font-extrabold">{plan.title}</span>
                <span className="flex items-center gap-1.5">
                  {!currentConsent ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">{plan.consentAt ? "الموافقة الحالية غير متحققة" : "موافقة العلاج لم تُسجّل"}</span>
                  ) : null}
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
                    {PLAN_STATUS_LABEL[plan.status]}
                  </span>
                </span>
              </div>

              {canSeeFinancial ? <ApprovedAgreementPanel planId={plan.id} totalMinor={plan.totalMinor} currency={plan.baseCurrency}
                position={plan.approvedAgreement??null} canApprove={currentConsent&&plan.status==="active"&&["admin","reception"].includes(session?.role??"")} isAdmin={session?.role==="admin"} onChanged={load}/> : null}
              <div data-testid="plan-amount-summary" className="mb-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="text-sm font-bold">{formatMoney(plan.totalMinor, plan.baseCurrency)}</p>
                  <p className="text-[11px] text-slate-500">
                    {hasHistory ? "قيمة الخطة المتضمنة للتاريخ (ليست دَينًا)" : plan.installments.length > 0 ? "الإجمالي" : "المتفق عليه"}
                  </p>
                </div>
                {(plan.installments.length > 0 || plan.approvedAgreement || plan.invoiceFinancial?.kind === "invoice_backed") && canSeeFinancial && plan.invoiceFinancial?.kind !== "review_required" && plan.progress ? (
                  <>
                    <div className="rounded-xl bg-emerald-50 p-2">
                      <p className="text-sm font-extrabold text-emerald-800">{formatMoney(plan.progress.paidMinor, plan.baseCurrency)}</p>
                      <p className="text-[11px] text-emerald-700">المدفوع</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-2">
                      <p className="text-sm font-bold">{formatMoney(plan.progress.remainingMinor, plan.baseCurrency)}</p>
                      <p className="text-[11px] text-slate-500">الباقي</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-xl bg-emerald-50 p-2">
                      <p className="text-sm font-extrabold text-emerald-800">{formatMoney(ordinaryProgress.doneMinor, plan.baseCurrency)}</p>
                      <p className="text-[11px] text-emerald-700">{hasHistory ? "أُنجز من البنود الأخرى" : "أُنجز"}</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-2">
                      <p className="text-sm font-bold">{formatMoney(ordinaryProgress.remainingMinor, plan.baseCurrency)}</p>
                      <p className="text-[11px] text-slate-500">{hasHistory ? "باقي البنود الأخرى" : "باقي العلاج"}</p>
                    </div>
                  </>
                )}
              </div>

              {hasHistory ? (
                <p role="status" data-testid="plan-legacy-progress-unknown" className="mb-2 rounded-xl border border-indigo-200 bg-indigo-50 p-2 text-xs text-indigo-950">
                  المنجَز قبل النظام وباقي العلاج التاريخي غير معلومين من مبلغ الاتفاق. تقدّم البنود الأخرى معروض منفصلًا؛ المستحق المالي يؤخذ من الحساب فقط.
                  {!currentConsent ? " يلزم تسجيل موافقة المريض الفعلية قبل توقيع الزيارة؛ حفظ المسودة متاح." : ""}
                </p>
              ) : null}

              {(plan.installments.length > 0 || plan.approvedAgreement || plan.invoiceFinancial?.kind === "invoice_backed") && canSeeFinancial && plan.invoiceFinancial?.kind !== "review_required" && plan.progress ? (
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
                      {plan.approvedAgreement ? "التحصيل إيصالات على الأصل المعتمد" : "سنداتها فواتير ودفعات في كشف الحساب"}
                    </a>
                  </p>
                </>
              ) : null}

              {canSeeFinancial && plan.invoiceFinancial?.kind !== "review_required" && plan.progress && plan.progress.overdueMinor > 0 ? (
                <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
                  متأخر: {formatMoney(plan.progress.overdueMinor, plan.baseCurrency)}
                </p>
              ) : null}

              {!plan.invoiceFinancial && (!hasHistory || plan.approvedAgreement) && canSeeFinancial && plan.progress && (plan.status === "active" || plan.status === "completed" && plan.approvedAgreement) && (plan.installments.length > 0 || plan.approvedAgreement) ? (
                payFor === plan.id ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex flex-wrap gap-2">
                      <input disabled={!money.ready || busy || money.attempt !== null} value={payAmount} onChange={(event) => setPayAmount(event.target.value)}
                        placeholder="مبلغ القسط" aria-label="مبلغ القسط" inputMode="decimal" dir="ltr" autoFocus
                        className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
                      <select disabled={!money.ready || busy || money.attempt !== null} value={payCurrency} onChange={(event) => setPayCurrency(event.target.value as Currency)}
                        aria-label="العملة"
                        className="w-32 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                        {CURRENCIES.map((currency) => (
                          <option key={currency} value={currency}>{CURRENCY_LABEL[currency]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => collect(plan)} disabled={!money.ready || busy || money.attempt !== null || !payAmount.trim()}
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
                    <button disabled={!money.ready || busy || money.attempt !== null}
                      onClick={() => {
                        setPayFor(plan.id);
                        // المقترح: القسط القادم — أكثر ما يُدفع فعلًا.
                        const suggested = plan.progress?.nextDueAmountMinor || plan.installments[0]?.amountMinor || 0;
                        setPayAmount(suggested ? toInputAmount(suggested, plan.baseCurrency) : "");
                        // (TD-05) التحصيل يبدأ بعملة الاتفاق — والاختيار يبقى للمحصِّل.
                        setPayCurrency(plan.baseCurrency);
                      }}
                      className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white">
                      تحصيل قسط
                    </button>
                  </div>
                )
              ) : null}

              {canSeeFinancial && canHandleMoney(session?.role) && !loading && !readUnavailable && !readDenied ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {plan.status === "active" ? <button
                    disabled={!money.ready || busy || money.attempt !== null}
                    onClick={async () => {
                      if (!completionAllowed.current(plan.id)) return;
                      setBusy(true); setError(null);
                      try {
                        const response = await fetch(`/api/plans/${plan.id}`, {
                          method: "PATCH", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ status: "completed" }),
                        });
                        if (!response.ok) {
                          const result = await response.json().catch(() => null);
                          throw new Error(result?.message ?? "تعذّر إنهاء الخطة.");
                        }
                        void load();
                      } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذّر إنهاء الخطة."); }
                      finally { setBusy(false); }
                    }}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 disabled:opacity-50">
                    إنهاء الخطة
                  </button> : null}
                  <a href={`/print/plan/${plan.id}`} target="_blank" rel="noopener noreferrer"
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-navy-800 hover:bg-slate-50 inline-flex items-center gap-1">
                    <span>📄</span><span>{plan.invoiceFinancial || hasHistory ? "طباعة المرجع" : "طباعة العقد"}</span>
                  </a>
                </div>
              ) : null}

              {plan.items.length > 0 || (plan.status === "active" && !plan.consentAt) ? (
                <PlanItems plan={plan} canSeeFinancial={canSeeFinancial} context={context} onOpenItem={(item, target) => openItem(plan.id, item, target)} registerGuard={registerItemGuard}
                  onChanged={() => void load()} onError={setError} />
              ) : null}

              {plan.status === "active" && !plan.consentAt && coverageVerified && (plan.items.length > 0 || !plan.totalFromItems && plan.totalMinor > 0) ? (
                consentFor === plan.id ? (
                  <ConsentForm plan={plan}
                    scheduleExists={loading || readUnavailable ? null : canSeeFinancial ? plan.installments.length > 0
                      : typeof plan.hasInstallments === "boolean" ? plan.hasInstallments : null}
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
                  {currentConsent ? "وافق المريض في " : "تاريخ موافقة محفوظ غير متحقق للموافقة الحالية: "}{friendlyDateLong(plan.consentAt.slice(0, 10))}
                  {plan.consentBy ? ` · سجّلها ${plan.consentBy}` : ""}
                  {plan.consentNote ? ` · ${plan.consentNote}` : ""}
                </p>
              ) : null}

              {canSeeFinancial && plan.invoiceFinancial ? (
                <div className="mt-3 rounded-xl border border-slate-200 p-3 text-xs">
                  <p>{plan.invoiceFinancial.message ?? "السداد مرتبط بالفواتير القائمة؛ التحصيل وتعديل الجدول من حساب المريض."}</p>
                  {plan.invoiceFinancial.schedules.filter(schedule=>schedule.status==="active").map(schedule=>(
                    <div key={schedule.id} className="mt-2">
                      <strong>جدول سداد الفاتورة #{schedule.target.invoiceId} — النسخة {schedule.version}</strong>
                      {schedule.requiresReview ? <p>جدول غير متحقق؛ راجع مصدر الدين قبل اعتماد مبالغ الاستحقاق.</p> : schedule.progress?.rows.map((row,index)=><p data-testid="verified-plan-schedule-row" key={index}>{friendlyDateLong(row.dueDate)} · {formatMoney(row.amountMinor,plan.baseCurrency)} · المتبقي {formatMoney(row.remainingMinor,plan.baseCurrency)}</p>)}
                    </div>
                  ))}
                </div>
              ) : null}

              {canSeeFinancial && plan.invoiceFinancial?.kind !== "review_required" && plan.progress && plan.installments.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-bold text-slate-500">جدول الأقساط</summary>
                <ul className="mt-2 space-y-1">
                  {plan.installments.map((installment) => (
                    <li key={installment.id} className="flex justify-between gap-2 text-xs">
                      <span className={plan.progress !== null && installment.number <= plan.progress.paidCount ? "text-emerald-700" : "text-slate-600"}>
                        {plan.progress !== null && installment.number <= plan.progress.paidCount ? "✓ " : ""}
                        قسط {installment.number} · {friendlyDateLong(installment.dueDate)}
                      </span>
                      <span className="font-bold">{formatMoney(installment.amountMinor, plan.baseCurrency)}</span>
                    </li>
                  ))}
                </ul>
              </details>
              ) : null}
            </li>
            );
          })}
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
 * بنود الخطة — المسوّدة تُبنى، ثم تُقفل بالموافقة.
 *
 * قبل الموافقة: تُضاف البنود وتُحذف بحرّية، والإجمالي يتحرّك معها. وبعدها: قائمةٌ
 * للقراءة تُطبع ويُوقّع عليها المريض. والفرق بين الحالتين ظاهرٌ في الشاشة نفسها —
 * لا في رأس من يستعملها.
 */
function PlanItems({ plan, canSeeFinancial, context, onOpenItem, registerGuard, onChanged, onError }: {
  plan: Plan; canSeeFinancial: boolean;
  context?: ClinicalNavigationContext;
  onOpenItem: (item: PlanItem, target?: string) => void;
  registerGuard: (planId: number, guard: () => boolean) => () => void;
  onChanged: () => void; onError: (message: string | null) => void;
}) {
  // (TD-05) أسعار بنود هذه الخطة بعملة اتفاقها — لا بعملة الدفاتر.
  const base: Currency = plan.baseCurrency;
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
  /* (TD-05 owner review — Finding 2) سعرٌ صريح بعملة الخطة لبندٍ يُضاف إلى خطة
     بعملة اتفاق — سعر الدليل أساسيّ ولا يُنسخ إليها. */
  const [itemPrice, setItemPrice] = useState("");
  const [itemPriceReason, setItemPriceReason] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = Boolean(plan.consentAt);
  const [itemBaseline, setItemBaseline] = useState<PlanItemDraftSnapshot>(INITIAL_PLAN_ITEM_DRAFT);
  const itemSnapshot: PlanItemDraftSnapshot = { serviceId, tooth, surfaces, targetVisitNumber, sessionCount, billingRule, doctorId, itemPrice, itemPriceReason };
  const itemDirty = planItemDraftChanged(itemSnapshot, itemBaseline);
  const itemGuard = useCallback(() => !busy && (locked || !itemDirty
    || window.confirm("هناك بند خطة غير محفوظ. هل تريد مغادرة القسم؟")), [busy, locked, itemDirty]);
  useLayoutEffect(() => registerGuard(plan.id, itemGuard), [registerGuard, plan.id, itemGuard]);
  const historicalItems = plan.items.filter(hasLegacyHistory);
  const ordinaryProgress = historicalItems.length > 0 ? ordinaryPlanProgress(plan.items) : plan.itemsProgress;
  const visitGroups = groupItemsByVisit(plan.items.filter((item) => !hasLegacyHistory(item)));

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
          setItemBaseline((current) => current.serviceId === null ? { ...current, serviceId: list[0]?.id ?? null } : current);
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
          /* (TD-05 owner review) الخطة بعملة اتفاق: السعر الصريح بعملتها.
             والخطة الأساسية يبقى سعرها من الدليل في الخادم — لا يُرسل. */
          ...(base !== CLINIC_BASE_CURRENCY ? { price: itemPrice.trim() || "", priceReason: itemPriceReason.trim() || null } : {}),
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
      setItemPrice("");
      setItemPriceReason("");
      setItemBaseline({ ...itemSnapshot, tooth: "", surfaces: "", sessionCount: "1", itemPrice: "", itemPriceReason: "" });
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
          {historicalItems.length > 0 ? " · السجل التاريخي محفوظ منفصلًا عن الجلسات المخططة" : ""}
        </p>
        <span className="text-[10px] font-bold text-slate-400">
          {visitGroups.length > 0 ? `${visitGroups.length} جلسات مخططة` : ""}
        </span>
      </div>

      {historicalItems.length > 0 ? <div className="mb-2 flex flex-wrap gap-2">{historicalItems.map((item) => <button key={item.id} type="button" disabled={busy} data-testid={`plan-item-open-case-${item.id}`} className="min-h-11 rounded-lg border px-3 text-xs" onClick={() => onOpenItem(item)}>فتح حالة البند #{item.id}</button>)}</div> : null}
      <LegacyPlanHistory items={historicalItems} currency={base} canSeeFinancial={canSeeFinancial} consented={planConsentIsCurrent(plan)} />
      {visitGroups.length === 0 ? (
        <p className="text-xs text-slate-400">{historicalItems.length > 0 ? "لا بنود أخرى مخططة هنا." : "لا بنود بعد."}</p>
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
                    <li key={item.id} data-testid={`plan-item-${item.id}`} aria-current={context?.planItemId === item.id ? "true" : undefined} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
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
                        {item.billingStatus === "needs_financial_review" ? (
                          <span role="status" data-testid={`plan-item-financial-review-${item.id}`}
                            className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-900">
                            يحتاج مراجعة مالية — لا تُنشأ فاتورة جديدة لهذا البند
                          </span>
                        ) : item.billingStatus === "billed" ? (
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
                      <button type="button" data-testid={`plan-item-open-case-${item.id}`} disabled={busy} onClick={() => onOpenItem(item)} className="min-h-11 shrink-0 rounded-lg border px-2 text-xs font-bold">
                        {item.caseId != null ? `فتح الحالة #${item.caseId}` : "مراجعة ارتباط الحالة"}
                      </button>
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
        ordinaryProgress.count > 0 ? (
          <p className="text-[11px] font-bold text-slate-500">
            {historicalItems.length > 0 ? "البنود الأخرى: " : ""}أُنجز {ordinaryProgress.doneCount} من {ordinaryProgress.count} بنود ·{" "}
            {formatMoney(ordinaryProgress.doneMinor, base)} من {formatMoney(ordinaryProgress.totalMinor, base)}
          </p>
        ) : null
      ) : (
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">اختر الخدمة (مصنفة حسب الاختصاص)</span>
              {base !== CLINIC_BASE_CURRENCY ? (
                <p className="mb-1 text-[10px] font-bold text-amber-700">
                  خطة بعملة اتفاق ({CURRENCY_LABEL[base]}) — سعر الدليل يمنيّ ولا يُنسخ: اكتب سعر البند بعملة الخطة.
                </p>
              ) : null}
              <ServiceSelect
                services={services}
                value={serviceId}
                onChange={(id) => setServiceId(id || null)}
                /* (TD-05 owner review) أسعار الدليل أساسيةٌ دائمًا — تُعرض
                   بعملتها الأصلية لا بعملة الخطة، فلا يبدو سعرٌ يمنيّ «سعرًا
                   دولاريًّا». */
                base={CLINIC_BASE_CURRENCY}
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
            <ToothField value={tooth} onChange={setTooth} ariaLabel="سن البند" className="w-20"
              label={<span className="mb-1 block text-[10px] font-bold text-slate-500">السن</span>} />
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
            {base !== CLINIC_BASE_CURRENCY ? (
              <label className="w-28">
                <span className="mb-1 block text-[10px] font-bold text-slate-500">
                  السعر ({CURRENCY_SHORT[base]})
                </span>
                <input value={itemPrice} onChange={(event) => setItemPrice(event.target.value)}
                  aria-label={`سعر البند بعملة الخطة ${CURRENCY_LABEL[base]}`}
                  data-field="plan-item-price"
                  inputMode="decimal" dir="ltr" placeholder="0"
                  className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-bold text-center" />
              </label>
            ) : null}
            {base !== CLINIC_BASE_CURRENCY && itemPrice.trim() ? (
              <label className="min-w-[10rem] flex-1">
                <span className="mb-1 block text-[10px] font-bold text-slate-500">سبب السعر (إن خالف الدليل)</span>
                <input value={itemPriceReason} onChange={(event) => setItemPriceReason(event.target.value)} maxLength={300}
                  aria-label="سبب سعر البند" placeholder="مثل: خصم متفق"
                  className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs" />
              </label>
            ) : null}
            <button onClick={() => void add()} disabled={busy || !serviceId}
              data-action="plan-add-item"
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
function ConsentForm({ plan, scheduleExists, onDone, onError }: {
  plan: Plan; scheduleExists: boolean | null; onDone: () => void; onError: (message: string | null) => void;
}) {
  // (TD-05) الموافقة على مبلغ الخطة بعملة اتفاقها.
  const base: Currency = plan.baseCurrency;
  const hasHistory = plan.items.some(hasLegacyHistory);
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const [note, setNote] = useState(hasHistory ? "" : "توقيع ورقي محفوظ بالملف");
  const [split, setSplit] = useState(false);
  const [count, setCount] = useState("6");
  const [everyDays, setEveryDays] = useState("30");
  const [firstDueDate, setFirstDueDate] = useState(today);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !plan.items.filter(hasLegacyHistory).every(legacyCoverageIsLive) || (hasHistory && note.trim().length < 3) || (split && (hasHistory || scheduleExists !== false))) return;
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
        {plan.items.length === 0
          ? `موافقة المريض على اتفاق بمبلغ ${formatMoney(plan.totalMinor, base)} — اتفاقٌ ماليّ بلا بنود علاجية محدّدة؛ بعدها لا يتغيّر المبلغ ولا تُضاف إليه بنود (يُوثَّق المستجدّ باتفاق جديد).`
          : `موافقة المريض على ${formatMoney(plan.totalMinor, base)} — وبعدها تُقفل البنود.`}
      </p>
      {hasHistory ? <p className="mb-2 text-xs text-indigo-900">
        سجّل فقط الموافقة الفعلية التي حصلت عليها ووثّق مصدرها. مبلغ الخطة يتضمن اتفاقًا تاريخيًّا؛ الموافقة لا تُنشئ دَينًا جديدًا أو جلسات سابقة.
      </p> : null}
      <input value={note} onChange={(event) => setNote(event.target.value)}
        aria-label="كيف وُثّقت الموافقة"
        className="mb-2 w-full rounded-lg border border-emerald-200 bg-white px-2.5 py-1.5 text-xs" />

      {hasHistory ? (
        <p className="mb-2 text-[11px] font-bold text-indigo-900">لا يُنشأ جدول أقساط جديد لقيمة الخطة التي تتضمن علاجًا تاريخيًّا؛ التحصيل من الرصيد السابق أو الفواتير المثبتة.</p>
      ) : scheduleExists === false ? (
        <label className="mb-2 flex items-center gap-2 text-xs font-bold text-emerald-900">
          <input type="checkbox" checked={split} onChange={(event) => setSplit(event.target.checked)} />
          قسّطها
        </label>
      ) : scheduleExists === true ? (
        <p className="mb-2 text-[11px] font-bold text-slate-500">لهذا الاتفاق جدول أقساط قائم — لا يُعاد تقسيطه.</p>
      ) : (
        <p role="status" className="mb-2 text-[11px] font-bold text-slate-500">وجود جدول الأقساط غير متحقق — لا يُنشأ جدول جديد حتى يكتمل التحقق.</p>
      )}

      {split && !hasHistory && scheduleExists === false ? (
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

      <button onClick={() => void submit()} disabled={busy || !plan.items.filter(hasLegacyHistory).every(legacyCoverageIsLive) || plan.totalMinor <= 0 || (hasHistory && note.trim().length < 3) || (split && (hasHistory || scheduleExists !== false))}
        className="w-full rounded-lg bg-emerald-600 py-2 text-xs font-extrabold text-white disabled:opacity-40">
        سجّل الموافقة
      </button>
    </div>
  );
}
