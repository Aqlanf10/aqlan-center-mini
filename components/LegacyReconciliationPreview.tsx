"use client";

import { useState } from "react";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString } from "@/lib/schedule";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, isCurrency, type Currency } from "@/lib/money";
import {
  previewLegacyReconciliation, type OpeningSnapshot, type PreviewReceipt,
} from "@/lib/legacy-reconciliation-preview";
import { useSession } from "./SessionProvider";

interface PreviewProps {
  patientId: number;
  /** Existing parent ledger's current authorized, validated read; not a new grant. */
  ready: boolean;
  positions?: readonly OpeningSnapshot[];
  payments?: readonly PreviewReceipt[];
}

/** Local comparison only. No fetch, persistence, allocation or financial command. */
export function LegacyReconciliationPreview(props: PreviewProps) {
  const session = useSession();
  if (!session || !props.ready) return null;
  // Reusing A after A→B→A must start blank, not recover another draft owner.
  const owner = JSON.stringify([props.patientId, session.username, session.role, session.permissions ?? null]);
  return <ScopedLegacyReconciliationPreview key={owner} {...props} />;
}

function ScopedLegacyReconciliationPreview({ positions, payments }: PreviewProps) {
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState<Currency | "">("");
  const [agreedAmount, setAgreedAmount] = useState("");
  const [previouslyPaidAmount, setPreviouslyPaidAmount] = useState("");
  const [historicalAsOf, setHistoricalAsOf] = useState("");
  const preview = currency ? previewLegacyReconciliation({
    draft: { currency, agreedAmount, previouslyPaidAmount, historicalAsOf },
    today: clinicDateString(new Date(), CLINIC_ZONE_FALLBACK), positions, payments,
  }) : null;
  const close = () => {
    setOpen(false); setCurrency(""); setAgreedAmount(""); setPreviouslyPaidAmount(""); setHistoricalAsOf("");
  };
  const amountClass = "min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm";
  return (
    <section aria-label="معاينة بيانات مالية سابقة" className="mb-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <button type="button" aria-expanded={open} onClick={() => { if (open) close(); else setOpen(true); }}
        className="min-h-11 w-full text-start text-sm font-bold text-navy-900">
        {open ? "إغلاق المعاينة ومسح مدخلاتها" : "معاينة اتفاق سابق دون حفظ"}
      </button>
      {open ? (
        <div className="space-y-3">
          <p role="note" className="text-xs leading-5 text-slate-600">
            الأرقام التي تكتبها هنا معاينة غير محفوظة. لا تُغيّر الرصيد أو السندات، وتُمسح عند الإغلاق أو مغادرة القراءة الحالية.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="min-w-0 text-xs font-semibold">
              عملة الاتفاق التاريخي
              <select value={currency} onChange={(event) => {
                const next = event.target.value;
                if (next === "" || isCurrency(next)) {
                  setCurrency(next); setAgreedAmount(""); setPreviouslyPaidAmount("");
                }
              }} className={amountClass}>
                <option value="">اختر العملة</option>
                {CURRENCIES.map((value) => <option key={value} value={value}>{CURRENCY_LABEL[value]}</option>)}
              </select>
            </label>
            <label className="min-w-0 text-xs font-semibold">
              البيانات التاريخية حتى
              <input type="date" value={historicalAsOf} onChange={(event) => setHistoricalAsOf(event.target.value)}
                className={amountClass} dir="ltr" />
            </label>
            <label className="min-w-0 text-xs font-semibold">
              كامل المبلغ المتفق عليه
              <input value={agreedAmount} onChange={(event) => setAgreedAmount(event.target.value)}
                inputMode="decimal" dir="ltr" disabled={!currency} className={amountClass} />
            </label>
            <label className="min-w-0 text-xs font-semibold">
              المدفوع حتى التاريخ المحدد
              <input value={previouslyPaidAmount} onChange={(event) => setPreviouslyPaidAmount(event.target.value)}
                inputMode="decimal" dir="ltr" disabled={!currency} className={amountClass} />
            </label>
          </div>
          <p className="text-[11px] text-slate-500">تغيير العملة يمسح مبالغ المعاينة دون تحويلها.</p>
          {preview?.message ? <p role="status" className="text-xs text-amber-900">{preview.message}</p> : null}
          {preview?.historical && currency ? (
            <>
              <dl aria-label="الأرقام التاريخية المدخلة" className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                <div><dt>المتفق عليه في المعاينة</dt><dd className="font-bold">{formatMoney(preview.historical.agreedMinor, currency)}</dd></div>
                <div><dt>المدفوع سابقًا في المعاينة</dt><dd className="font-bold">{formatMoney(preview.historical.previouslyPaidMinor, currency)}</dd></div>
                <div><dt>المتبقي التاريخي المحسوب</dt><dd className="font-bold">{formatMoney(preview.historical.remainingMinor, currency)}</dd></div>
              </dl>
              {preview.recorded.kind === "available" ? (
                <dl aria-label="الرصيد السابق المسجل في الحساب" className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs sm:grid-cols-3">
                  <div><dt>أصل الرصيد السابق المسجل</dt><dd className="font-bold">{formatMoney(preview.recorded.position.openingMinor, currency)}</dd></div>
                  <div><dt>صافي السداد المرتبط المسجل</dt><dd className="font-bold">{formatMoney(preview.recorded.position.settledMinor, currency)}</dd></div>
                  <div><dt>المتبقي الحالي حسب الحساب</dt><dd className="font-bold">{formatMoney(preview.recorded.position.remainingMinor, currency)}</dd></div>
                </dl>
              ) : (
                <p role="status" className="text-xs text-slate-600">{preview.recorded.kind === "absent"
                  ? "لا يوجد رصيد سابق بهذه العملة في القراءة الحالية."
                  : "تفصيل الرصيد السابق غير متاح؛ لا يُفترض أنه صفر."}</p>
              )}
              <p role="note" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
                الأرشيف وسجل تعديل الرصيد غير محمّلين في هذه المعاينة. قد يجمع الرصيد أكثر من اتفاق؛ تساوي الأرقام لا يثبت ارتباطه بهذا الاتفاق.
                المدفوع سابقًا لا يُطرح مرة أخرى من أصل رصيد مسجل، والسندات لا تُطرح من المتبقي التاريخي هنا.
              </p>
              <details className="text-xs">
                <summary className="min-h-11 cursor-pointer py-3 font-bold">سندات تستهدف الرصيد وسُجّلت بعد التاريخ المدخل</summary>
                <p className="mb-2 leading-5 text-slate-600">
                  هذا تصنيف بتاريخ التسجيل وهدف السند فقط، ولا يثبت وقت قبض المال فعليًا. السندات العادية تبقى في قائمة الدفعات الأصلية.
                </p>
                {preview.receipts.kind === "unavailable" ? (
                  <p role="status">تعذّر التحقق من قائمة السندات؛ لا يعني ذلك عدم وجودها.</p>
                ) : preview.receipts.recordedAfterCutoff.length === 0 ? (
                  <p>لا توجد سندات بهذه الشروط في القراءة الحالية.</p>
                ) : (
                  <ul className="space-y-2">
                    {preview.receipts.recordedAfterCutoff.map((receipt) => (
                      <li key={receipt.id} className="rounded-lg border border-slate-200 bg-white p-2">
                        <span className="font-bold">{receipt.receiptNumber}</span>{" · "}
                        {receipt.kind === "refund" ? "ردّ مسجل" : "قبض مسجل"}{" · "}
                        <bdi>{formatMoney(receipt.amountMinor, receipt.currency)}</bdi>{" · "}
                        <bdi>{receipt.createdAt}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
