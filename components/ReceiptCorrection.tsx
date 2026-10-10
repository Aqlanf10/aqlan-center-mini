"use client";

import { useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, parseAmount, toInputAmount, type Currency } from "@/lib/money";
import { CORRECTION_REASON_MIN } from "@/lib/invoice-correction";
import { useMoneyAttempt } from "./useMoneyAttempt";
import { MoneyAttemptNotice } from "./MoneyAttemptNotice";

/**
 * (RC-1) تصحيح سند قبضٍ أُدخل خطأً — للمدير.
 *
 * السند لا يُعدَّل ولا يُحذف (الدرج والدفاتر بُنيت عليه): يُعكس المتبقي منه بسند ردٍّ مرتبطٍ به،
 * ويُصدر السند الصحيح بدله — كلاهما أو لا شيء. أو يُبطَل وحده إن كانت الدفعة لم تقع أصلًا.
 */

interface ReceiptLike {
  id: number; receiptNumber: string; amountMinor: number; currency: Currency; method: string;
  invoiceId: number | null; planId?: number | null; openingCurrency?: Currency | null;
}
interface InvoiceOption { id: number; invoiceNumber: string; baseCurrency: Currency; status: string }
interface PlanOption { id: number; title: string; baseCurrency?: Currency; status: string }

/** A refreshed ledger may already show zero remaining after a lost response.
 * The pending correction must still be reachable for its original-key replay. */
export function ReceiptCorrectionTrigger({ paymentId, remainingMinor, onClick, className }: {
  paymentId: number; remainingMinor: number; onClick: () => void; className: string;
}) {
  const money = useMoneyAttempt(`correction:${paymentId}`);
  if (remainingMinor <= 0 && !money.attempt) return null;
  return <button type="button" onClick={onClick} className={className}>تصحيح السند</button>;
}

export function ReceiptCorrection({ receipt, remainingMinor, invoices, plans, openingCurrencies, onDone, onCancel }: {
  receipt: ReceiptLike;
  remainingMinor: number;
  invoices: InvoiceOption[];
  plans: PlanOption[];
  /** عملات الأرصدة السابقة القائمة على المريض. */
  openingCurrencies: Currency[];
  onDone: (message: string, replacementId: number | null) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"correct" | "void">("correct");
  const [amount, setAmount] = useState(() => toInputAmount(remainingMinor, receipt.currency));
  const [currency, setCurrency] = useState<Currency>(receipt.currency);
  const [method, setMethod] = useState(receipt.method === "transfer" ? "transfer" : "cash");
  const [target, setTarget] = useState<string>("original");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const money = useMoneyAttempt(`correction:${receipt.id}`);

  const amountMinor = parseAmount(amount, currency);
  const validAmount = amountMinor !== null && amountMinor > 0;
  const ready = !busy && reason.trim().length >= CORRECTION_REASON_MIN && (mode === "void" || validAmount);

  /* «كما في السند الأصلي» يحلّه الخادم من الأصل المقفول — فقسط الخطة يبقى على فاتورته وخطته معًا. */
  const targetBody = (): Record<string, unknown> => {
    if (target === "original") return { target: "original" };
    if (target.startsWith("inv:")) return { invoiceId: Number(target.slice(4)) };
    if (target.startsWith("plan:")) return { planId: Number(target.slice(5)) };
    if (target.startsWith("open:")) return { openingCurrency: target.slice(5) };
    return {};
  };

  const submit = async (retry = false) => {
    if (busy || (!retry && !ready)) return;
    setBusy(true);
    setError(null);
    try {
      const body = mode === "void"
        ? { mode, reason }
        : { mode, reason, amount, currency, method, ...targetBody() };
      const result = await money.run(retry ? undefined : {
        url: `/api/payments/${receipt.id}/correct`, body: JSON.stringify(body), operation: mode,
      });
      if (!result || result.kind === "busy") return;
      if (result.kind !== "confirmed") { setError(result.message); return; }
      const { reversal, replacement } = result.acknowledgment;
      onDone(
        replacement
          ? `عُكس ${receipt.receiptNumber} (${reversal?.receiptNumber ?? "سند ردّ"}) وصدر بدله ${replacement.receiptNumber}.`
          : `أُبطل ${receipt.receiptNumber} بسند الردّ ${reversal?.receiptNumber ?? ""}.`,
        replacement?.id ?? null,
      );
      money.consume(result.attempt);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const selectable = invoices.filter((invoice) => invoice.status !== "cancelled");

  return (
    <div role="group" aria-label={`تصحيح ${receipt.receiptNumber}`} className="mt-2 w-full rounded-xl border border-amber-300 bg-amber-50 p-3">
      <MoneyAttemptNotice attempt={money.attempt} onRetry={() => void submit(true)} />
      <fieldset disabled={busy || money.attempt !== null} className="min-w-0">
      <p className="mb-2 text-xs font-bold text-amber-900">
        السند لا يُمسح: يُعكس {formatMoney(remainingMinor, receipt.currency)} منه بسند ردٍّ ظاهرٍ بسببه، ثم يُصدر السند الصحيح
        بدله — والدرج في الوردية المفتوحة يتحرك بالفرق فقط.
      </p>
      <div className="mb-2 flex gap-2" role="radiogroup" aria-label="نوع التصحيح">
        {([["correct", "تصحيح (سند صحيح بدله)"], ["void", "إبطال السند (الدفعة لم تقع)"]] as const).map(([value, label]) => (
          <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => setMode(value)}
            className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-bold ${
              mode === value ? "border-amber-600 bg-amber-600 text-white" : "border-slate-300 bg-white text-slate-700"
            }`}>
            {label}
          </button>
        ))}
      </div>
      {mode === "correct" ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input value={amount} onChange={(event) => setAmount(event.target.value)} aria-label="المبلغ الصحيح"
              inputMode="decimal" dir="ltr" className="w-32 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
            <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} aria-label="عملة السند الصحيح"
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
              {CURRENCIES.map((option) => <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>)}
            </select>
            <select value={method} onChange={(event) => setMethod(event.target.value)} aria-label="طريقة الدفع الصحيحة"
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
              <option value="cash">نقدًا</option>
              <option value="transfer">تحويل</option>
            </select>
          </div>
          <select value={target} onChange={(event) => setTarget(event.target.value)} aria-label="على ماذا يُسجَّل السند الصحيح"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
            <option value="original">كما في السند الأصلي</option>
            <option value="none">على الحساب (بلا فاتورة)</option>
            {selectable.map((invoice) => (
              <option key={invoice.id} value={`inv:${invoice.id}`}>
                الفاتورة {invoice.invoiceNumber} ({CURRENCY_LABEL[invoice.baseCurrency]})
              </option>
            ))}
            {plans.filter((plan) => plan.status === "active").map((plan) => (
              <option key={`plan-${plan.id}`} value={`plan:${plan.id}`}>
                الخطة: {plan.title}{plan.baseCurrency ? ` (${CURRENCY_LABEL[plan.baseCurrency]})` : ""}
              </option>
            ))}
            {openingCurrencies.map((code) => (
              <option key={`open-${code}`} value={`open:${code}`}>الرصيد السابق ({CURRENCY_LABEL[code]})</option>
            ))}
          </select>
          <p className="text-xs font-bold text-slate-700">
            {validAmount
              ? `كان: ${formatMoney(remainingMinor, receipt.currency)} ← يصير: ${formatMoney(amountMinor, currency)}`
              : "اكتب المبلغ الصحيح."}
          </p>
        </div>
      ) : (
        <p className="text-xs font-bold text-slate-700">
          يُعكس {formatMoney(remainingMinor, receipt.currency)} ولا يُصدر سندٌ بدله — يعود المبلغ دَينًا على المريض كما كان.
        </p>
      )}
      <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300}
        placeholder="سبب التصحيح — مثل: كُتب 50,000 والمقبوض 5,000" aria-label="سبب تصحيح السند"
        className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" rows={2} />
      </fieldset>
      {error ? <p role="alert" className="mt-1 text-xs font-bold text-red-700">{error}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => void submit()} disabled={!ready || money.attempt !== null}
          className="flex-1 rounded-lg bg-amber-600 py-2 text-xs font-extrabold text-white disabled:opacity-50">
          {mode === "void" ? "أبطل السند" : "صحّح السند"}
        </button>
        <button type="button" onClick={onCancel}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600">
          إلغاء
        </button>
      </div>
    </div>
  );
}
