"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency,
} from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { ClinicalVisit } from "../ClinicalVisit";
import { CollectPaymentModal } from "../CollectPaymentModal";
import { CheckoutExtras, isCheckoutWalkout } from "./CheckoutExtras";
import { hasWalkoutFinancials, workflowBalanceRows, type FinancialReadState } from "@/lib/walkout-financial-read";
import { walkoutNeedsReview, PREVIOUS_BALANCE_LABEL, PREVIOUS_BALANCE_NOTE } from "@/lib/walkout-presentation";
import type { WorkflowSummary } from "./SummaryTab";

/** Uses canonical workflow / walkout reads. Unknown money is never zero. */
export function TodayVisitTab(props: Parameters<typeof OwnedTodayVisitTab>[0]) {
  // Preserve ordinary clinical drafts when workflow/financial authority refreshes.
  // Only the explicit checkout-only view retires wholesale with money permission.
  const ownerKey = props.requestedCheckoutVisitId == null ? props.patientId
    : `${props.patientId}:${props.requestedCheckoutVisitId}:${props.canCollect}`;
  return <OwnedTodayVisitTab key={ownerKey} {...props} />;
}
function OwnedTodayVisitTab({
  patientId,
  patientName,
  summary,
  retainedOpenVisit,
  workflowIsCurrent,
  base,
  visits,
  canCollect,
  requestedCheckoutVisitId = null,
  onVisitStarted,
  onChanged,
  onOpenTabletMode,
  onNavigationGuardChange,
}: {
  patientId: number;
  patientName: string;
  summary: WorkflowSummary | null;
  retainedOpenVisit?: WorkflowSummary["openVisit"];
  workflowIsCurrent?: () => boolean;
  base: Currency;
  visits: { id: number; arrivedAt: string; status: string; chair: number | null }[];
  canCollect: boolean;
  requestedCheckoutVisitId?: number | null;
  onVisitStarted: () => void;
  onChanged: () => void;
  onOpenTabletMode?: () => void;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collectOpen, setCollectOpen] = useState(false);
  /* (VISIT-2) وصولٌ من «مراجعة وإنهاء» لمريضٍ جديد فُتح ملفّه للتوّ (?review=1): تُفتح المراجعة
     مباشرةً فيكمل الطبيب الإنهاء هنا، ثم الشبّاك — التحصيل وحجز الجلسة القادمة. */
  const [autoReview, setAutoReview] = useState(false);
  useEffect(() => {
    try {
      setAutoReview(new URLSearchParams(window.location.search).get("review") === "1");
    } catch { /* بلا عنوان يُقرأ — لا مراجعة تلقائية */ }
  }, []);
  const [previousBalances, setPreviousBalances] = useState<{ currency: Currency; balanceMinor: number }[] | null>(null);
  const [currentBalances, setCurrentBalances] = useState<{ currency: Currency; balanceMinor: number }[] | null>(null);
  /* (المراجعة النهائية — الاستنتاج أ) معرّف الزيارة النشِطة التي تملك حالة
     الشبّاك أعلاه: التبويب محمّلٌ وقد تتوالى الزيارات عليه، فلا بدّ من
     معرفةٍ صريحة بأيّ زيارةٍ تعمل الحالة الحالية لصالحها — ومعها وقتُ
     وصولها: التمييز بين «زيارةٍ جديدة بدأت» و«رجوعٍ لزيارةٍ أقدم قائمة»
     بعد توقيع الحالية (مريضٌ بزيارتين مفتوحتين) يُحسم بالطوابع لا
     بالمعرّفات: الأولى تُصفّر الحالة، والثانية لا تمس شبّاك الموقَّعة. */
  const activeVisitRef = useRef<{ id: number; arrivedAt: string } | null>(null);
  /** (OP-03) زيارةٌ موقَّعة استُعيد شبّاكها من الخادم — لتُصفَّر حين تبدأ زيارةٌ جديدة. */
  const restoredVisitRef = useRef<number | null>(null);
  const [collected, setCollected] = useState(false);
  /* (TD-05) سُدِّد شيءٌ في هذا الشبّاك — ولو جزئيًا: يكفي لإظهار «الرصيد الحالي (بعد التحصيل)». أما «تم
     التحصيل» (collected) فلا يُعلَن إلا حين لا يبقى من فاتورة الزيارة شيء. */
  const [paidSome, setPaidSome] = useState(false);
  const [checkout, setCheckout] = useState<{
    /** (CHAIR-1) الزيارة الموقَّعة — للتأجيل وملخّص المغادرة وحجز القادمة. */
    visitId: number;
    financialReviewRequired?: boolean | null;
    duesMinor: number;
    remainingMinor: number;
    invoiceCurrency: Currency;
    invoiceId: number | null;
    sessionsCompleted: number;
    nextPlannedVisit: { id: number; title: string; sequence: number; durationMinutes: number; suggestedDate?: string | null; afterDays?: number | null } | null;
    labOrdersCreated: number;
    materialsDeducted: number;
  } | null>(null);

  const checkoutNeedsFinanceAttention = checkout?.financialReviewRequired === true || checkout?.financialReviewRequired === null;

  const [financialRead, setFinancialRead] = useState<FinancialReadState>("loading");
  const [financialRevision, setFinancialRevision] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const checkoutVisitRef = useRef<number | null>(requestedCheckoutVisitId);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestRef.current?.abort(); };
  }, []);

  const loadCurrentBalances = useCallback(async (visitId = checkoutVisitRef.current, restore = false) => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    const current = () => mounted.current && !request.signal.aborted && requestRef.current === request;
    setCurrentBalances(null);
    setPreviousBalances(null);
    setFinancialRead("loading");
    setFinancialRevision((revision) => revision + 1);
    if (!canCollect) return;
    try {
      const response = await fetch(visitId === null
        ? `/api/patients/${patientId}/workflow` : `/api/visits/${visitId}/walkout`,
        { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Financial read failed");
      const payload: unknown = await response.json();
      if (!current()) return;
      if (visitId === null) {
        setCurrentBalances(workflowBalanceRows(payload, patientId));
      } else {
        if (!isCheckoutWalkout(payload, visitId) || !hasWalkoutFinancials(payload, patientId, visitId)) {
          throw new Error("Unverified walkout");
        }
        if (restore && requestedCheckoutVisitId === null) {
          const restored = payload as typeof payload & { signedToday?: boolean };
          if (restored.signedToday !== true || (activeVisitRef.current !== null
            && activeVisitRef.current.arrivedAt >= payload.arrivedAt)) {
            const workflow = await fetch(`/api/patients/${patientId}/workflow`, { cache: "no-store", signal: request.signal });
            if (!workflow.ok) throw new Error("Financial read failed");
            const latest: unknown = await workflow.json();
            if (!current()) return;
            setCurrentBalances(workflowBalanceRows(latest, patientId));
            setFinancialRead("verified");
            return;
          }
          restoredVisitRef.current = visitId;
        }
        checkoutVisitRef.current = visitId;
        setPreviousBalances(CURRENCIES.map((currency) => ({
          currency, balanceMinor: payload.checkout.previous[currency]!,
        })).filter((row) => row.balanceMinor !== 0));
        setCurrentBalances(payload.balances);
        const remainingMinor = Math.max(0, (payload.invoice?.netMinor ?? 0) - payload.checkout.invoicePaidMinor);
        setCollected(Boolean(payload.invoice && remainingMinor === 0));
        setPaidSome(payload.checkout.invoicePaidMinor > 0);
        setCheckout((previous) => ({
          visitId, financialReviewRequired: walkoutNeedsReview(payload),
          invoiceId: payload.invoice?.id ?? null, invoiceCurrency: payload.invoice?.currency ?? base,
          duesMinor: payload.invoice?.netMinor ?? 0, remainingMinor,
          sessionsCompleted: previous?.visitId === visitId ? previous.sessionsCompleted : 0,
          nextPlannedVisit: previous?.visitId === visitId ? previous.nextPlannedVisit : null,
          labOrdersCreated: previous?.visitId === visitId ? previous.labOrdersCreated : 0,
          materialsDeducted: previous?.visitId === visitId ? previous.materialsDeducted : 0,
        }));
      }
      setFinancialRead("verified");
    } catch {
      if (current()) {
        setCurrentBalances(null);
        setPreviousBalances(null);
        setFinancialRead("error");
      }
    }
  }, [patientId, canCollect, base, requestedCheckoutVisitId]);

  useEffect(() => { void loadCurrentBalances(); }, [loadCurrentBalances]);

  /* (المراجعة النهائية للمالك — TD-05، الاستنتاج أ) زيارةٌ جديدة ⇒ حالةٌ
   * جديدة: حين يصبح معرّف الزيارة القائمة معرّفًا جديدًا (غير null ومخالفًا
   * لما قبِلناه) تُصفَّر حالة الزيارة كلها ويُقرأ رصيد ما قبل التوقيع من
   * جديد لصالحها — **إلا إذا كانت الزيارةُ الجديدة أقدم من سابقتها**:
   * توقيعُ زيارةٍ لمريضٍ بزيارةٍ مفتوحةٍ أخرى يجعل الخلاصة ترجع لتلك
   * الزيارة الأقدم — وذلك رجوعٌ لا بدءٌ: شبّاك الموقَّعة يبقى مرئيًا حتى
   * التحصيل وإتمام المسار. كذلك null بعد التوقيع لا يصفّر شيئًا، وأول
   * ظهورٍ بعد التحميل ليس تبديلًا (الحالة الابتدائية نظيفة سلفًا). */
  // Retain only the editor identity during an unavailable workflow, never its action authority.
  const openVisit = summary ? summary.openVisit : retainedOpenVisit ?? null;
  // This only deduplicates a reference actually rendered by the loaded editor.
  // A new token retires late A→B→A callbacks without touching checkout ownership.
  const previousReferenceOwner = useMemo(() => ({}), [openVisit?.id, requestedCheckoutVisitId]);
  const livePreviousReferenceOwner = useRef(previousReferenceOwner);
  livePreviousReferenceOwner.current = previousReferenceOwner;
  const [previousReference, setPreviousReference] = useState<{ owner: typeof previousReferenceOwner; id: number } | null>(null);
  const onPreviousVisitReferenceChange = useCallback((id: number | null) => {
    if (!mounted.current || livePreviousReferenceOwner.current !== previousReferenceOwner) return;
    setPreviousReference((current) => id === null ? null
      : current?.owner === previousReferenceOwner && current.id === id ? current : { owner: previousReferenceOwner, id });
  }, [previousReferenceOwner]);
  const openVisitId = openVisit?.id ?? null;
  const openVisitArrivedAt = openVisit?.arrivedAt ?? null;
  useEffect(() => {
    if (requestedCheckoutVisitId !== null) return;
    if (openVisitId === null || openVisitArrivedAt === null) return;
    const previousActive = activeVisitRef.current;
    if (previousActive?.id === openVisitId) return;
    activeVisitRef.current = { id: openVisitId, arrivedAt: openVisitArrivedAt };
    if (previousActive === null) {
      /* (OP-03) شبّاكٌ استُعيد من الخادم لزيارةٍ موقَّعة سابقة: ظهور زيارةٍ مفتوحة بعده بدءُ زيارةٍ جديدة
         لا «أول ظهور» — يُصفَّر شبّاك السابقة كما لو كان في الذاكرة. بلا استعادة، أول ظهور ليس تبديلًا. */
      const restoredId = restoredVisitRef.current;
      if (restoredId === null || restoredId === openVisitId) return;
      restoredVisitRef.current = null;
    } else if (openVisitArrivedAt <= previousActive.arrivedAt) {
      /* رجوعٌ لزيارةٍ أقدم (أو معاصرة) لا يُصفّر — بدءُ زيارةٍ أحدث وحده يُصفّر. */
      return;
    }
    checkoutVisitRef.current = null;
    requestRef.current?.abort();
    setCheckout(null);
    setCollected(false);
    setPaidSome(false);
    setCollectOpen(false);
    setPreviousBalances(null);
    setCurrentBalances(null);
    void loadCurrentBalances();
  }, [openVisitId, openVisitArrivedAt, loadCurrentBalances, requestedCheckoutVisitId]);

  // Reopen through exactly the same verified read as signing and collection.
  const lastSignedId = summary?.lastVisit?.id;
  useEffect(() => {
    if (requestedCheckoutVisitId !== null || !canCollect || checkout || !lastSignedId) return;
    void loadCurrentBalances(lastSignedId, true);
  }, [canCollect, checkout, lastSignedId, loadCurrentBalances, requestedCheckoutVisitId]);

  const startManualVisit = async () => {
    if (busy || !summary || workflowIsCurrent?.() === false) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId,
          patientName,
          note: "دخول مباشر من ملف المريض",
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر تسجيل الزيارة.");
        return;
      }
      onVisitStarted();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const lastVisit = summary?.lastVisit ?? null;
  const previousVisits = visits.filter((visit) => visit.status === "done");

  // Current account debt is read directly; previous + fees is not a current debt calculation.
  const invoiceCurrency = checkout?.invoiceCurrency ?? base;
  const sameCurrencyBefore = previousBalances?.find((row) => row.currency === invoiceCurrency) ?? null;
  const otherCurrencyRows = currentBalances?.filter((row) => row.currency !== invoiceCurrency) ?? [];
  const totalDueInInvoiceCurrency = financialRead === "verified"
    ? currentBalances?.find((row) => row.currency === invoiceCurrency)?.balanceMinor ?? 0 : null;

  // Preset only an unpaid visit invoice; other debt uses an explicit existing account target.
  const presetInvoice = useMemo(
    () => checkout?.invoiceId && checkout.remainingMinor > 0
      ? { id: checkout.invoiceId, baseCurrency: invoiceCurrency }
      : null,
    [checkout?.invoiceId, checkout?.remainingMinor, invoiceCurrency],
  );
  const todayInvoice = presetInvoice && checkout ? [{
    id: checkout.invoiceId as number,
    invoiceNumber: `فاتورة اليوم (#${checkout.invoiceId})`,
    totalMinor: checkout.duesMinor,
    discountMinor: 0,
    baseCurrency: invoiceCurrency,
  }] : [];

  return (
    <div className="space-y-4">
      {requestedCheckoutVisitId !== null ? <section id="requested-visit-checkout" aria-label="الزيارة المحددة للتحصيل"
        className="rounded-xl border border-emerald-300 bg-emerald-50 p-4">
        <h2 className="text-sm font-extrabold">تحصيل الزيارة #{requestedCheckoutVisitId} · {patientName}</h2>
        <p className="mt-1 text-xs text-slate-600">هذه الزيارة محددة من الاستقبال؛ الأرصدة الحالية من الدفتر، ولا يغيّر التوقيع اتفاق المريض أو رصيده السابق.</p>
        {openVisit && openVisit.id !== requestedCheckoutVisitId ? <p className="mt-1 text-xs font-bold text-amber-800">توجد زيارة قائمة أخرى #{openVisit.id} لهذا المريض. التحصيل هنا يخص الزيارة المحددة أعلاه.</p> : null}
        <div className="mt-2 flex flex-wrap gap-3 text-xs font-bold">
          <a href="/" className="underline">العودة إلى الاستقبال</a>
          <a href={`/patients/${patientId}?tab=today`} className="underline">فتح مساحة الزيارة الحالية</a>
          {canCollect ? <button type="button" onClick={() => void loadCurrentBalances(requestedCheckoutVisitId)} className="underline">تحديث بيانات الزيارة المحددة</button> : null}
        </div>
        {!canCollect ? <p role="alert" className="mt-2 font-bold text-amber-900">تعذّر التحقق من صلاحية التحصيل لهذه الزيارة. لا يمكن عرض مبالغها أو اختيار زيارة بديلة تلقائيًا.</p> : null}
      </section> : null}
      {error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}

      {canCollect && financialRead !== "verified" ? (
        <div data-testid="checkout-financial-read" role={financialRead === "error" ? "alert" : "status"} className="rounded-xl border border-amber-200 p-3 text-sm">
          {financialRead === "loading" ? "جارٍ التحقق من الأرصدة…" : "تعذّر التحقق من الأرصدة؛ لا يُعد المبلغ صفرًا"}
          {financialRead === "error" && requestedCheckoutVisitId !== null ? <p>الزيارة المحددة غير متاحة أو غير موقّعة، أو لم تتطابق بياناتها. لم تُفتح زيارة أخرى بدلًا عنها.</p> : null}
          {financialRead === "error" ? <button type="button" onClick={() => void loadCurrentBalances(checkoutVisitRef.current ?? lastSignedId ?? null, checkoutVisitRef.current === null && !!lastSignedId)}>إعادة التحقق من الأرصدة</button> : null}
        </div>
      ) : null}
      {/* آخر زيارة — يُقرأ لا يُخمَّن */}
      {requestedCheckoutVisitId === null && lastVisit
        && !(openVisit && previousReference?.owner === previousReferenceOwner && previousReference.id === lastVisit.id) ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-3.5" aria-label="آخر زيارة">
          <h3 className="text-xs font-extrabold text-navy-900">
            آخر زيارة — {friendlyDateLong(lastVisit.date)}
          </h3>
          <p className="mt-1 text-xs text-slate-600">
            {lastVisit.proceduresSummary ?? lastVisit.treatmentDone ?? "زيارة كشف"}
          </p>
          {lastVisit.nextPlan ? (
            <p className="mt-1 text-[11px] font-bold text-navy-800">
              الخطة القادمة حينها: {lastVisit.nextPlan}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* الزيارة القائمة أو بدؤها */}
      {requestedCheckoutVisitId !== null ? null : openVisit ? (
        <section aria-label="زيارة اليوم">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-brand-orange/40 bg-orange-50/60 px-3.5 py-2.5">
            <div>
              <p className="text-sm font-extrabold text-navy-900">
                {summary ? "زيارة قائمة" : "مسودة الزيارة · الملخص غير متاح"}
                {openVisit.plannedTitle ? ` — ${openVisit.plannedTitle}` : ""}
              </p>
              <p className="text-[11px] text-slate-600">
                {openVisit.status === "in_chair"
                  ? `على الكرسي${openVisit.chair ? ` رقم ${openVisit.chair}` : ""}`
                  : openVisit.status === "done"
                    ? "انتهى الجلوس — بانتظار التوثيق والإنهاء"
                    : "في الانتظار"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onOpenTabletMode ? (
                <button
                  type="button"
                  onClick={onOpenTabletMode}
                  className="rounded-xl border border-indigo-200 bg-white px-3 py-1.5 text-xs font-black text-indigo-900 shadow-2xs hover:bg-indigo-50"
                  title="فتح شاشة اللمس العريضة المخصصة لطبيب الأسنان بجانب الكرسي"
                >
                  📱 شاشة الكرسي والتابلت
                </button>
              ) : null}
              {/* (LIVE-1) لوحة تشغيل اليوم هي الصفحة الرئيسية «/» — لا صفحة باسم /today. */}
              <a href="/" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">
                لوحة اليوم
              </a>
            </div>
          </div>
          <ClinicalVisit
            visitId={openVisit.id}
            expectedPatientId={patientId}
            onNavigationGuardChange={onNavigationGuardChange}
            onPreviousVisitReferenceChange={onPreviousVisitReferenceChange}
            autoReview={autoReview}
            onSigned={(result) => {
              if (!mounted.current || activeVisitRef.current?.id !== openVisit.id) return;
              checkoutVisitRef.current = openVisit.id;
              setCheckout({
                visitId: openVisit.id,
                financialReviewRequired: null,
                duesMinor: result?.duesMinor ?? 0,
                remainingMinor: result?.duesMinor ?? 0,
                invoiceCurrency: result?.invoiceCurrency ?? base,
                invoiceId: result?.invoiceId ?? null,
                sessionsCompleted: result?.sessionsCompleted ?? 0,
                nextPlannedVisit: result?.nextPlannedVisit ?? null,
                labOrdersCreated: result?.labOrdersCreated ?? 0,
                materialsDeducted: result?.materialsDeducted ?? 0,
              });
              onChanged();
              void loadCurrentBalances(openVisit.id);
            }}
          />
        </section>
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center">
          <p className="text-sm font-bold text-slate-600">{summary ? "لا زيارة قائمة اليوم" : "تعذّر التحقق من الزيارة القائمة"}</p>
          {summary && summary.plannedVisits.length > 0 ? (
            <p className="mt-1 text-xs text-slate-500">
              ابدأ الجلسة المخطَّطة «{summary.plannedVisits[0].title}» من تبويب الملخص —
              أو ابدأ زيارةً حرّة:
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">ابدأ زيارةً لهذا المريض:</p>
          )}
          <button
            type="button"
            onClick={() => void startManualVisit()}
            disabled={busy || !summary}
            className="mt-3 rounded-xl bg-brand-orange px-5 py-2.5 text-xs font-extrabold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "جارٍ التسجيل…" : "🪑 بدء زيارة اليوم"}
          </button>
        </div>
      )}

      {/* الشبّاك: ما بعد التوقيع — التحصيل وحجز الجلسة القادمة (المواصفة §٢٧) */}
      {checkout && canCollect ? (
        <section
          className="rounded-2xl border-2 border-emerald-300 bg-emerald-50/60 p-4"
          aria-label="شبّاك ما بعد الزيارة"
          data-visit-id={checkout.visitId}
          data-financial-state={financialRead}
        >
          <h3 className="mb-2 text-sm font-extrabold text-emerald-900">
            انتهت الزيارة — شبّاك التحصيل · زيارة #{checkout.visitId}
          </h3>
          <dl className="space-y-1 rounded-xl border border-emerald-200 bg-white p-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">{PREVIOUS_BALANCE_LABEL}</dt>
              <dd className="font-bold">
                {financialRead !== "verified" || previousBalances === null ? (
                  "—"
                ) : previousBalances.length === 0 ? (
                  "لا رصيد سابق"
                ) : (
                  <span className="flex flex-col items-end">
                    {previousBalances.map((row) => (
                      <span key={row.currency} data-testid="checkout-previous-balance" data-currency={row.currency} className="font-bold">
                        {formatMoney(row.balanceMinor, row.currency)}
                        {previousBalances.length > 1 ? (
                          <span className="mr-1 text-[10px] font-bold text-slate-400">{CURRENCY_LABEL[row.currency]}</span>
                        ) : null}
                      </span>
                    ))}
                  </span>
                )}
              </dd>
            </div>
            <p className="text-xs text-slate-500">{PREVIOUS_BALANCE_NOTE}</p>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">{checkoutNeedsFinanceAttention ? "فاتورة اليوم المثبتة" : "استحقاق اليوم"}</dt>
              <dd data-testid="checkout-visit-invoice" data-currency={invoiceCurrency} className="font-extrabold text-navy-900">
                {financialRead !== "verified" ? "غير متحقق" : checkoutNeedsFinanceAttention && checkout.invoiceId === null
                  ? (checkout.financialReviewRequired === true ? "لا فاتورة جديدة؛ توجد بنود تحتاج مراجعة مالية" : "لا فاتورة جديدة؛ تغطية العمل غير متحققة")
                  : formatMoney(checkout.duesMinor, invoiceCurrency)}
                {invoiceCurrency !== base ? (
                  <span className="mr-1 text-[10px] font-bold text-slate-400">{CURRENCY_LABEL[invoiceCurrency]}</span>
                ) : null}
              </dd>
            </div>
            {checkoutNeedsFinanceAttention ? <div role="status" data-testid="checkout-financial-review"
              className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-bold text-amber-900">
              {checkout.financialReviewRequired === true ? "تغطية بعض العمل غير محسومة وتحتاج مراجعة مالية" : "تعذّر التحقق من تغطية العمل الحالية"}؛ لا يثبت غياب فاتورة أنها مجانية أو مشمولة.
              الأرصدة والفواتير المثبتة تبقى مستقلة ويمكن تسويتها بمسارها المعتاد.
            </div> : null}
            {totalDueInInvoiceCurrency !== null ? (
              <div className="flex items-center justify-between border-t border-slate-100 pt-1.5">
                <dt className="font-bold text-slate-700">
                  {"الرصيد الحالي في الدفتر"}{invoiceCurrency !== base ? ` (${CURRENCY_LABEL[invoiceCurrency]})` : ""}
                </dt>
                <dd data-testid="checkout-current-balance" data-currency={invoiceCurrency} className="text-lg font-black text-amber-700">
                  {formatMoney(totalDueInInvoiceCurrency, invoiceCurrency)}
                </dd>
              </div>
            ) : null}
            {otherCurrencyRows.length > 0 ? (
              <div className="border-t border-slate-100 pt-1.5">
                <dt className="text-[11px] font-bold text-slate-400">
                  أرصدة بعملات أخرى تُسوّى كلٌّ بعملتها — لا تُجمع هنا:
                </dt>
                {otherCurrencyRows.map((row) => (
                  <dd key={row.currency} data-testid="checkout-current-balance" data-currency={row.currency} className="text-right text-[11px] font-bold text-slate-500">
                    {formatMoney(row.balanceMinor, row.currency)} · {CURRENCY_LABEL[row.currency]}
                  </dd>
                ))}
              </div>
            ) : null}

            {financialRead === "verified" && (collected || paidSome) ? (
              <div className="border-t border-emerald-200 pt-1.5">
                <dt className="text-[11px] font-bold text-emerald-700">الرصيد الحالي (بعد التحصيل)</dt>
                <dd className="text-right text-[11px] font-bold text-emerald-800">
                  {currentBalances === null ? (
                    "…"
                  ) : currentBalances.length === 0 ? (
                    "المستحق الحالي مسدّد — راجع متبقي الاتفاق في الملخص"
                  ) : (
                    <span className="flex flex-col items-end">
                      {currentBalances.map((row) => (
                        <span key={row.currency}>
                          {formatMoney(row.balanceMinor, row.currency)}
                          {currentBalances.length > 1 ? (
                            <span className="mr-1 text-[10px] font-bold text-slate-400">{CURRENCY_LABEL[row.currency]}</span>
                          ) : null}
                        </span>
                      ))}
                    </span>
                  )}
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="mt-3 flex flex-wrap gap-2">
            {/* بعد التحصيل الناجح يختفي زرّه — فالسند سُجّل، والشبّاك يعرض
                اللقطة المجمّدة والرصيد الجاري وحده. */}
            {financialRead !== "verified" ? (
              <span role="status">الرصيد غير متحقق؛ لا يمكن تأكيد المبلغ المطلوب</span>
            ) : collected && !currentBalances?.some((row) => row.balanceMinor > 0) ? (
              <span className="flex-[2] rounded-xl bg-emerald-600 px-4 py-2.5 text-center text-sm font-extrabold text-white">
                تم التحصيل — سند الاستحقاق سُجّل
              </span>
            ) : checkout.remainingMinor > 0 || currentBalances?.some((row) => row.currency === "YER" && row.balanceMinor > 0) ? (
              <button
                type="button"
                onClick={() => setCollectOpen(true)}
                className="flex-[2] rounded-xl bg-brand-orange px-4 py-2.5 text-sm font-extrabold text-white"
              >
                تحصيل وطباعة السند
              </button>
            ) : currentBalances?.some((row) => row.balanceMinor > 0)
              ? <span className="font-bold text-amber-900">يوجد رصيد بعملة أخرى؛ اختر هدف تحصيله من الحساب</span>
              : checkoutNeedsFinanceAttention
              ? <span className="font-bold text-amber-900">لا مبلغ مثبت للتحصيل الآن؛ التحقق من تغطية العمل ما زال مطلوبًا</span>
              : <span className="font-bold text-emerald-800">لا مبلغ مطلوب لهذه الزيارة</span>}
            {!presetInvoice && financialRead === "verified" && currentBalances?.some((row) => row.balanceMinor > 0) ? (
              <a href={`/patients/${patientId}?tab=account`} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-navy-800">
                اختيار هدف التحصيل من الحساب
              </a>
            ) : null}
            {checkout.invoiceId ? (
              <a
                href={`/print/invoice/${checkout.invoiceId}`}
                target="_blank"
                rel="noopener"
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-navy-800"
              >
                فاتورة اليوم
              </a>
            ) : null}
          </div>

          {/* (CHAIR-1 Slice 5) مشمول بالخطة، تأجيل الدفع، ملخّص المغادرة، وحجز القادمة هنا. */}
          <CheckoutExtras
            visitId={checkout.visitId}
            expectedPatientId={patientId}
            financialVerified={financialRead === "verified"}
            financialRevision={financialRevision}
            collected={collected}
            suggestedDate={checkout.nextPlannedVisit?.suggestedDate ?? null}
            durationMinutes={checkout.nextPlannedVisit?.durationMinutes ?? null}
            onChanged={() => { onChanged(); void loadCurrentBalances(); }}
          />

          {checkout.nextPlannedVisit ? (
            <div className="mt-3 rounded-xl border border-navy-200 bg-white px-3 py-2.5">
              <p className="text-xs font-extrabold text-navy-900">
                الجلسة القادمة المقترحة: {checkout.nextPlannedVisit.title}
                <span className="mr-2 font-normal text-slate-500">
                  · {checkout.nextPlannedVisit.durationMinutes} دقيقة
                </span>
              </p>
              {checkout.nextPlannedVisit.suggestedDate ? (
                <p className="mt-1 text-xs font-bold text-emerald-800">
                  الموعد المقترح: {friendlyDateLong(checkout.nextPlannedVisit.suggestedDate)}
                  {checkout.nextPlannedVisit.afterDays ? ` (بعد ${checkout.nextPlannedVisit.afterDays} يومًا حسب قالب الخطة)` : ""}
                </p>
              ) : null}
              <p className="mt-0.5 text-[11px] text-slate-500">
                جدولها بتاريخٍ ووقت فقط من تبويب الملخص — العلاج يُقرأ من الخطة.
              </p>
            </div>
          ) : (
            <p className="mt-3 text-[11px] font-bold text-slate-500">
              لا جلسة قادمة مقترحة — اكتمل علاج الخطة أو لا خطة قائمة.
            </p>
          )}

          {/* آثار الزيارة التلقائية (§١٩/§٢٠): طلب المختبر والمستهلكات — إمّا كلها أو لا شيء */}
          {checkout.labOrdersCreated > 0 || checkout.materialsDeducted > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {checkout.labOrdersCreated > 0 ? (
                <a href="/lab" className="rounded-xl bg-sky-100 px-3 py-1.5 text-[11px] font-extrabold text-sky-800">
                  🦷 تولّد {checkout.labOrdersCreated} طلب مختبر — لم يُرسل بعد
                </a>
              ) : null}
              {checkout.materialsDeducted > 0 ? (
                <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-[11px] font-bold text-slate-700">
                  📦 خُصمت {checkout.materialsDeducted} حركة مستهلكات تلقائيًا
                </span>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* سجل الزيارات السابقة */}
      {requestedCheckoutVisitId === null && previousVisits.length > 0 ? (
        <details className="rounded-2xl border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-xs font-extrabold text-navy-900">
            الزيارات السابقة ({previousVisits.length})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {previousVisits.map((visit) => (
              <li key={visit.id} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2">
                <span className="text-xs font-bold text-navy-900">
                  {friendlyDateLong(visit.arrivedAt.slice(0, 10))}
                </span>
                {/* (LIVE-1) سجل الزيارة (ولو قديمة) في صفحتها السريرية — لوحة اليوم لا تعرض إلا زيارات اليوم. */}
                <a
                  href={`/visits/${visit.id}`}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-navy-800 hover:bg-slate-50"
                >
                  فتح سجل الزيارة
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Preserve the shared payment modal and its idempotent attempt lifecycle. */}
      <CollectPaymentModal
        patientId={patientId}
        patientName={patientName}
        isOpen={canCollect && collectOpen && financialRead === "verified"}
        onClose={() => setCollectOpen(false)}
        onSuccess={() => {
          setCollectOpen(false);
          if (!mounted.current || checkoutVisitRef.current !== checkout?.visitId) return;
          setPaidSome(true);
          setCollected(false);
          onChanged();
          void loadCurrentBalances();
        }}
        suggestedMinor={checkout && checkout.remainingMinor > 0 ? checkout.remainingMinor : null}
        suggestedCurrency={presetInvoice ? invoiceCurrency : null}
        invoices={todayInvoice}
        presetInvoice={presetInvoice}
        contextLabel={
          presetInvoice && checkout
            ? `استحقاق اليوم: ${formatMoney(checkout.duesMinor, invoiceCurrency)}${sameCurrencyBefore && sameCurrencyBefore.balanceMinor > 0 ? ` · رصيد سابق ${formatMoney(sameCurrencyBefore.balanceMinor, invoiceCurrency)}` : ""}`
            : "دفعة على الحساب بالريال اليمني؛ لا تستهدف فاتورة الزيارة المسددة. لتسوية فاتورة أخرى أو رصيد سابق بعملته، افتح تبويب الحساب واختر الهدف."
        }
      />
    </div>
  );
}

