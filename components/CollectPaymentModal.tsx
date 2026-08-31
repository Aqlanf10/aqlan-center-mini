"use client";

import { useEffect, useState } from "react";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  formatAmount,
  type Currency,
} from "@/lib/money";
import { useSetting } from "./SettingsProvider";

/**
 * التحصيل الموحَّد — مكونٌ واحد ومسارٌ واحد (المواصفة §٢٦ و AC-09).
 *
 * قبضُ الدفع كان يفتح من أبوابٍ ثلاثة بأشكالٍ مختلفة؛ واليوم كل باب يفتح **هذا**
 * المكوّن على **هذه** الواجهة البرمجية: `/api/payments`. القبض من كشف الحساب، ومن
 * شبّاك ما بعد الزيارة، ومن أي رابطٍ مستقبلي — رحلةٌ واحدة لا ثلاث.
 */

interface OpenInvoice {
  id: number;
  invoiceNumber: string;
  totalMinor: number;
  discountMinor: number;
}

export function CollectPaymentModal({
  patientId,
  patientName,
  isOpen,
  onClose,
  onSuccess,
  suggestedMinor = null,
  contextLabel = null,
  invoices = [],
}: {
  patientId: number;
  patientName: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (paymentId: number) => void;
  /** مبلغٌ مقترح — قسطٌ مستحق أو استحقاق اليوم. */
  suggestedMinor?: number | null;
  /** سياق التحصيل — يظهر فوق النموذج ليُبيّن لماذا نُقبض الآن. */
  contextLabel?: string | null;
  invoices?: OpenInvoice[];
}) {
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = baseSetting === "SAR" || baseSetting === "USD" || baseSetting === "YER"
    ? baseSetting : "YER";

  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(base);
  const [invoiceId, setInvoiceId] = useState("");
  const [method, setMethod] = useState("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setCurrency(base);
    setInvoiceId("");
    setNote("");
    setAmount(suggestedMinor && suggestedMinor > 0 ? formatAmount(suggestedMinor, base) : "");
  }, [isOpen, base, suggestedMinor]);

  if (!isOpen) return null;

  const submit = async () => {
    if (busy || !amount.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId,
          amount,
          currency,
          invoiceId: invoiceId || undefined,
          kind: "payment",
          method,
          note: note.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر تسجيل الدفعة.");
        return;
      }
      onSuccess(payload.id as number);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="تحصيل دفعة"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={busy ? undefined : onClose}
    >
      <section
        className="w-full max-w-md rounded-2xl border border-brand-orange bg-white p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        aria-label={`تحصيل دفعة من ${patientName}`}
      >
        <header className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-extrabold text-navy-900">تحصيل دفعة</h3>
            <p className="text-[11px] font-bold text-slate-500">{patientName}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">
            إغلاق
          </button>
        </header>

        {contextLabel ? (
          <p className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold text-navy-900">
            {contextLabel}
          </p>
        ) : null}

        <div className="mb-3 flex flex-wrap gap-2">
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="المبلغ"
            aria-label="المبلغ"
            inputMode="decimal"
            dir="ltr"
            autoFocus
            className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-base font-bold outline-none focus:border-brand-blue"
          />
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value as Currency)}
            aria-label="العملة"
            className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
          >
            {CURRENCIES.map((option) => (
              <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>
            ))}
          </select>
        </div>

        {invoices.length > 0 ? (
          <label className="mb-3 block">
            <span className="mb-1 block text-[11px] font-bold text-slate-500">على فاتورة (اختياري)</span>
            <select
              value={invoiceId}
              onChange={(event) => setInvoiceId(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
            >
              <option value="">— دفعة على الحساب —</option>
              {invoices.map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.invoiceNumber} · {formatAmount(Math.max(0, invoice.totalMinor - invoice.discountMinor), base)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="mb-3 flex flex-1 gap-1.5">
          {(["cash", "transfer"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMethod(option)}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
                method === option
                  ? "border-brand-blue bg-brand-blue text-white"
                  : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              {option === "cash" ? "نقدًا" : "تحويل"}
            </button>
          ))}
        </div>

        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="ملاحظة (اختياري)"
          aria-label="ملاحظة"
          className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
        />

        {error ? (
          <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !amount.trim()}
          className="w-full rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
        >
          {busy ? "جارٍ التسجيل…" : "سجّل الدفعة واطبع السند"}
        </button>
      </section>
    </div>
  );
}
