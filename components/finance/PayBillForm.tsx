"use client";

import { useMemo, useState } from "react";
import { CLINIC_BASE_CURRENCY, CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import type { SettlementQuote } from "@/lib/supplier-payments";

/**
 * (P0-2) سداد فاتورة مورد/مختبر بعينها — مع معاينةٍ قبل التأكيد.
 *
 * المستخدم يرى قبل أن يخرج المال: سعر الصرف المستعمل (من الإعدادات لحظتها)،
 * والمكافئ الذي سيُخصم من الفاتورة بعملتها، والمتبقي بعده. والمعاينة هي الحساب
 * نفسه الذي يُسجِّل على الخادم — فما يُرى هو ما يُحفظ لقطةً في السند.
 * والمدير وحده يغيّر السعر إن اختلف السعر الفعلي عن الإعدادات، بسببٍ يُدقَّق.
 */
export interface PayableRow {
  id: number; description: string; category: string;
  currency: Currency; remainingMinor: number;
}

interface QuoteResponse {
  ok: boolean; code: string | null; message: string | null; quote: SettlementQuote | null;
  settingsRates?: Partial<Record<Currency, number>>;
}

export default function PayBillForm({
  partyId, payable, isAdmin, onPaid, onCancel,
}: {
  partyId: number; payable: PayableRow; isAdmin: boolean;
  onPaid: () => Promise<void> | void; onCancel: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(payable.currency);
  const [override, setOverride] = useState(false);
  const [paymentRate, setPaymentRate] = useState("");
  const [billRate, setBillRate] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<QuoteResponse | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body = useMemo(() => ({
    category: payable.category === "lab" ? "lab" : "supplier",
    partyId, payableId: payable.id, amount, currency,
    ...(override && currency !== CLINIC_BASE_CURRENCY && paymentRate ? { exchangeRate: Number(paymentRate) } : {}),
    ...(override && payable.currency !== CLINIC_BASE_CURRENCY && payable.currency !== currency && billRate
      ? { payableExchangeRate: Number(billRate) } : {}),
    ...(override ? { rateOverrideReason: reason } : {}),
  }), [amount, billRate, currency, override, partyId, payable, paymentRate, reason]);
  const key = JSON.stringify(body);

  const requestPreview = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/expenses/quote", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: key,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّرت المعاينة."); setPreview(null); return; }
      setPreview(payload as QuoteResponse);
      setPreviewKey(key);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (busy || !preview?.ok || previewKey !== key || !preview.quote) return;
    setBusy(true);
    try {
      /* التأكيد يحمل ما رآه المستخدم: إن تغيّر السعر أو المتبقي منذ المعاينة يرفض
         الخادم (stale_quote) فتُعاد المعاينة — لا يُحفظ غير ما أُكِّد. */
      const quoted = preview.quote;
      const response = await fetch("/api/expenses", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          expected: {
            paymentExchangeRate: quoted.paymentExchangeRate,
            payableExchangeRate: quoted.payable?.exchangeRate ?? null,
            payableSettledMinor: quoted.payable?.settledMinor ?? null,
            payableRemainingBeforeMinor: quoted.payable?.remainingBeforeMinor ?? null,
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (payload?.code === "stale_quote") { setPreview(null); setPreviewKey(null); }
        setError(payload?.message ?? "تعذّر تسجيل الصرف.");
        return;
      }
      await onPaid();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const quote = preview?.quote ?? null;
  const fresh = preview !== null && previewKey === key;
  const showBillRate = payable.currency !== CLINIC_BASE_CURRENCY && payable.currency !== currency;
  const showPaymentRate = currency !== CLINIC_BASE_CURRENCY;

  return (
    <div className="mt-2 w-full rounded-xl border border-navy-800 bg-white p-3" aria-label="سداد الفاتورة">
      <p className="mb-2 text-xs font-bold text-slate-600">
        المتبقي على الفاتورة: {formatMoney(payable.remainingMinor, payable.currency)}
      </p>
      <div className="mb-2 flex flex-wrap gap-2">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="المبلغ المدفوع"
          aria-label="المبلغ المدفوع" inputMode="decimal" dir="ltr"
          className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} aria-label="عملة الدفع"
          className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
          {CURRENCIES.map((c) => <option key={c} value={c}>{CURRENCY_LABEL[c]}</option>)}
        </select>
      </div>

      {isAdmin && (showPaymentRate || showBillRate) ? (
        <label className="mb-2 flex items-center gap-2 text-xs font-bold text-slate-600">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
          السعر الفعلي يختلف عن سعر الإعدادات (للمدير — يُدقَّق)
        </label>
      ) : null}
      {override ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {showPaymentRate ? (
            <input value={paymentRate} onChange={(e) => setPaymentRate(e.target.value)} dir="ltr" inputMode="decimal"
              aria-label={`سعر ${currency} بالريال اليمني`} placeholder={`1 ${currency} = ؟ YER`}
              className="w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          ) : null}
          {showBillRate ? (
            <input value={billRate} onChange={(e) => setBillRate(e.target.value)} dir="ltr" inputMode="decimal"
              aria-label={`سعر ${payable.currency} بالريال اليمني`} placeholder={`1 ${payable.currency} = ؟ YER`}
              className="w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          ) : null}
          <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="سبب اختلاف السعر"
            placeholder="سبب اختلاف السعر" className="min-w-[10rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </div>
      ) : null}

      {fresh && quote ? (
        <div className={`mb-2 rounded-xl border p-2 text-xs ${preview?.ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}
          role="status">
          {quote.rateText ? <p className="font-bold">سعر الصرف المستعمل: <span dir="ltr">{quote.rateText}</span>{quote.rateOverridden ? " (معدَّل بسبب)" : " (من الإعدادات)"}</p> : null}
          {quote.payable ? (
            <p>
              يُخصم من الفاتورة: <strong>{formatMoney(quote.payable.settledMinor, quote.payable.currency)}</strong>
              {" · "}يبقى عليها: <strong>{formatMoney(Math.max(0, quote.payable.remainingAfterMinor), quote.payable.currency)}</strong>
            </p>
          ) : null}
          {preview?.message ? <p className="mt-1 font-bold text-red-700">{preview.message}</p> : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="mb-2 text-xs font-bold text-red-700">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={requestPreview} disabled={busy || !amount.trim()}
          className="rounded-xl border border-navy-800 bg-white px-4 py-2 text-sm font-bold text-navy-800 disabled:opacity-50">
          معاينة
        </button>
        <button type="button" onClick={confirm} disabled={busy || !fresh || !preview?.ok}
          className="flex-1 rounded-xl bg-navy-800 py-2 text-sm font-extrabold text-white disabled:opacity-50">
          تأكيد الصرف
        </button>
        <button type="button" onClick={onCancel}
          className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-600">
          إلغاء
        </button>
      </div>
    </div>
  );
}
