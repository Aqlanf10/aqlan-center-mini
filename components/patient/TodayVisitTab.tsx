"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency,
} from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { ClinicalVisit } from "../ClinicalVisit";
import { CollectPaymentModal } from "../CollectPaymentModal";
import type { WorkflowSummary } from "./SummaryTab";

/**
 * تبويب «زيارة اليوم» — مساحة عمل الطبيب (المواصفة §١٢).
 *
 * لا تُفتح صفحةً فارغة: الزيارة القائمة (أو أزرار بدئها)، وآخر زيارة وما تم فيها،
 * وعمل الزيارة نفسه في المكوّن السريري. وبعد التوقيع يظهر **الشبّاك**: الرصيد
 * السابق + استحقاق اليوم = الإجمالي المستحق، ثم التحصيل الموحَّد وحجز الجلسة
 * القادمة المقترحة — الرحلة كلها من شاشةٍ واحدة (المواصفة §٢٧).
 *
 * (TD-05 owner review — Finding 1) الشبّاك بعملاتها المستقلة: استحقاق اليوم
 * بعملة فاتورته الفعلية، والرصيد السابق سطرٌ لكل عملةٍ ذات نشاط، والإجمالي
 * يُجمع داخل عملة الفاتورة وحدها حين يكون لها رصيدٌ سابق — أما عملات الاتفاق
 * الأخرى فتُعرض كلٌّ بسطرها الموسوم ولا تُجمع مع غيرها أبدًا. والتحصيل يفتح
 * مستهدفًا فاتورة اليوم نفسها بعملتها.
 */
export function TodayVisitTab({
  patientId,
  patientName,
  summary,
  base,
  visits,
  canCollect,
  onVisitStarted,
  onChanged,
  onOpenTabletMode,
}: {
  patientId: number;
  patientName: string;
  summary: WorkflowSummary | null;
  base: Currency;
  visits: { id: number; arrivedAt: string; status: string; chair: number | null }[];
  canCollect: boolean;
  onVisitStarted: () => void;
  onChanged: () => void;
  onOpenTabletMode?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collectOpen, setCollectOpen] = useState(false);
  /* (TD-05 owner review) الرصيد السابق سطرٌ لكل عملةٍ ذات نشاط — لا رقمٌ واحد. */
  const [balancesBefore, setBalancesBefore] = useState<{ currency: Currency; balanceMinor: number }[] | null>(null);
  const [checkout, setCheckout] = useState<{
    duesMinor: number;
    invoiceCurrency: Currency;
    invoiceId: number | null;
    sessionsCompleted: number;
    nextPlannedVisit: { id: number; title: string; sequence: number; durationMinutes: number } | null;
    labOrdersCreated: number;
    materialsDeducted: number;
  } | null>(null);

  // رصيد ما قبل الزيارة يُقرأ عند الفتح وبعد كل تغيير — هو «السابق» في الشبّاك.
  const loadBalance = useCallback(async () => {
    if (!canCollect) return;
    try {
      const response = await fetch(`/api/patients/${patientId}/workflow`, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      /* (TD-05 owner review) الأرصدة بعملاتها المستقلة من byCurrency — العملة
         الواحدة تُعرض كما كانت دائمًا، والعملات المتعددة كلٌّ بسطرها. */
      const byCurrency = payload?.financial?.byCurrency;
      if (!byCurrency || typeof byCurrency !== "object") {
        setBalancesBefore(null);
        return;
      }
      const rows = CURRENCIES
        .map((currency) => ({
          currency,
          balanceMinor: Math.round(Number(byCurrency[currency]?.balanceMinor ?? 0)) || 0,
        }))
        .filter((row) => row.balanceMinor !== 0);
      setBalancesBefore(rows);
    } catch {
      // الرصيد مساعدةٌ للعرض — تعذّره لا يوقف الرحلة.
    }
  }, [patientId, canCollect]);

  useEffect(() => { void loadBalance(); }, [loadBalance]);

  const startManualVisit = async () => {
    if (busy) return;
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

  const openVisit = summary?.openVisit ?? null;
  const lastVisit = summary?.lastVisit ?? null;
  const previousVisits = visits.filter((visit) => visit.status === "done");

  /* استحقاق اليوم بعملة فاتورته — والرصيد السابق بعملة الفاتورة وحدها
     يُجمع معه؛ بقية العملات تُعرض منفصلة ولا تدخل أي مجموع أبدًا. */
  const invoiceCurrency = checkout?.invoiceCurrency ?? base;
  const sameCurrencyBefore = balancesBefore?.find((row) => row.currency === invoiceCurrency) ?? null;
  const otherCurrencyRows = balancesBefore?.filter((row) => row.currency !== invoiceCurrency) ?? [];
  const totalDueInInvoiceCurrency =
    checkout && sameCurrencyBefore ? sameCurrencyBefore.balanceMinor + checkout.duesMinor : null;

  /* فاتورة اليوم المستهدفة — التحصيل يفتح عليها بعملتها لا على الحساب. */
  const presetInvoice = useMemo(
    () => checkout?.invoiceId
      ? { id: checkout.invoiceId, baseCurrency: invoiceCurrency }
      : null,
    [checkout?.invoiceId, invoiceCurrency],
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
      {error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}

      {/* آخر زيارة — يُقرأ لا يُخمَّن */}
      {lastVisit ? (
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
      {openVisit ? (
        <section aria-label="زيارة اليوم">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-brand-orange/40 bg-orange-50/60 px-3.5 py-2.5">
            <div>
              <p className="text-sm font-extrabold text-navy-900">
                زيارة قائمة
                {openVisit.plannedTitle ? ` — ${openVisit.plannedTitle}` : ""}
              </p>
              <p className="text-[11px] text-slate-600">
                {openVisit.status === "in_chair" ? `على الكرسي${openVisit.chair ? ` رقم ${openVisit.chair}` : ""}` : "في الانتظار"}
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
              <a href="/today" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">
                لوحة اليوم
              </a>
            </div>
          </div>
          <ClinicalVisit
            visitId={openVisit.id}
            onSigned={(result) => {
              setCheckout({
                duesMinor: result?.duesMinor ?? 0,
                invoiceCurrency: result?.invoiceCurrency ?? base,
                invoiceId: result?.invoiceId ?? null,
                sessionsCompleted: result?.sessionsCompleted ?? 0,
                nextPlannedVisit: result?.nextPlannedVisit ?? null,
                labOrdersCreated: result?.labOrdersCreated ?? 0,
                materialsDeducted: result?.materialsDeducted ?? 0,
              });
              onChanged();
              void loadBalance();
            }}
          />
        </section>
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center">
          <p className="text-sm font-bold text-slate-600">لا زيارة قائمة اليوم</p>
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
            disabled={busy}
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
        >
          <h3 className="mb-2 text-sm font-extrabold text-emerald-900">
            انتهت الزيارة — شبّاك التحصيل
          </h3>
          <dl className="space-y-1 rounded-xl border border-emerald-200 bg-white p-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">الرصيد السابق</dt>
              <dd className="font-bold">
                {balancesBefore === null ? (
                  "—"
                ) : balancesBefore.length === 0 ? (
                  "لا رصيد سابق"
                ) : (
                  <span className="flex flex-col items-end">
                    {balancesBefore.map((row) => (
                      <span key={row.currency} className="font-bold">
                        {formatMoney(row.balanceMinor, row.currency)}
                        {balancesBefore.length > 1 ? (
                          <span className="mr-1 text-[10px] font-bold text-slate-400">{CURRENCY_LABEL[row.currency]}</span>
                        ) : null}
                      </span>
                    ))}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">استحقاق اليوم</dt>
              <dd className="font-extrabold text-navy-900">
                {formatMoney(checkout.duesMinor, invoiceCurrency)}
                {invoiceCurrency !== base ? (
                  <span className="mr-1 text-[10px] font-bold text-slate-400">{CURRENCY_LABEL[invoiceCurrency]}</span>
                ) : null}
              </dd>
            </div>
            {totalDueInInvoiceCurrency !== null ? (
              <div className="flex items-center justify-between border-t border-slate-100 pt-1.5">
                <dt className="font-bold text-slate-700">
                  الإجمالي المستحق{invoiceCurrency !== base ? ` (${CURRENCY_LABEL[invoiceCurrency]})` : ""}
                </dt>
                <dd className="text-lg font-black text-amber-700">
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
                  <dd key={row.currency} className="text-right text-[11px] font-bold text-slate-500">
                    {formatMoney(row.balanceMinor, row.currency)} · {CURRENCY_LABEL[row.currency]}
                  </dd>
                ))}
              </div>
            ) : null}
          </dl>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCollectOpen(true)}
              className="flex-[2] rounded-xl bg-brand-orange px-4 py-2.5 text-sm font-extrabold text-white"
            >
              تحصيل وطباعة السند
            </button>
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

          {checkout.nextPlannedVisit ? (
            <div className="mt-3 rounded-xl border border-navy-200 bg-white px-3 py-2.5">
              <p className="text-xs font-extrabold text-navy-900">
                الجلسة القادمة المقترحة: {checkout.nextPlannedVisit.title}
                <span className="mr-2 font-normal text-slate-500">
                  · {checkout.nextPlannedVisit.durationMinutes} دقيقة
                </span>
              </p>
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
      {previousVisits.length > 0 ? (
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
                <a
                  href={`/today?visitId=${visit.id}`}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-navy-800 hover:bg-slate-50"
                >
                  فتح سجل الزيارة
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* (TD-05 owner review) التحصيل يستهدف فاتورة اليوم نفسها بعملتها — لا
          دفعةً «على الحساب» أساسية لفاتورةٍ بعملة اتفاق. */}
      <CollectPaymentModal
        patientId={patientId}
        patientName={patientName}
        isOpen={collectOpen}
        onClose={() => setCollectOpen(false)}
        onSuccess={() => {
          setCollectOpen(false);
          setCheckout(null);
          onChanged();
          void loadBalance();
        }}
        suggestedMinor={checkout && checkout.duesMinor > 0 ? checkout.duesMinor : null}
        suggestedCurrency={checkout ? invoiceCurrency : null}
        invoices={todayInvoice}
        presetInvoice={presetInvoice}
        contextLabel={
          checkout
            ? `استحقاق اليوم: ${formatMoney(checkout.duesMinor, invoiceCurrency)}${sameCurrencyBefore && sameCurrencyBefore.balanceMinor > 0 ? ` · رصيد سابق ${formatMoney(sameCurrencyBefore.balanceMinor, invoiceCurrency)}` : ""}`
            : null
        }
      />
    </div>
  );
}
