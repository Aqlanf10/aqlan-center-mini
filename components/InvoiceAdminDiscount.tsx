"use client";

import { useRef, useState } from "react";
import { formatMoney, parseAmount, type Currency } from "@/lib/money";
import { ADMIN_DISCOUNT_MESSAGE, ADMIN_DISCOUNT_REASON_MAX, ADMIN_DISCOUNT_REASON_MIN, invoiceRemainingMinor } from "@/lib/invoice-discount";

/**
 * (FIN-DISC) خصمٌ إداريٌّ على فاتورةٍ صادرة — للمدير، بسببٍ مكتوب.
 *
 * يزيد خصم الفاتورة نفسها: البنود والدفعات والربط بالخطة كما هي. لا يتجاوز المتبقي بعد المدفوع على الفاتورة،
 * والخادم هو الحَكَم (يقفل الفاتورة ويعيد الحساب ويرفض إن تغيّر خصمها منذ فتح النموذج).
 */
export function InvoiceAdminDiscount({ invoice, settledMinor, onDone, onCancel }: {
  invoice: { id: number; invoiceNumber: string; status: string; totalMinor: number; discountMinor: number; baseCurrency: Currency };
  /** المسدَّد على الفاتورة صراحةً بعملتها — للعرض فقط؛ الخادم يحسبه من جديد. */
  settledMinor: number;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const currency = invoice.baseCurrency;
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const expectedDiscountMinor = useRef(invoice.discountMinor).current;

  const remaining = invoiceRemainingMinor({ status: invoice.status, totalMinor: invoice.totalMinor,
    discountMinor: invoice.discountMinor, settledMinor });
  const parsed = amount.trim() ? parseAmount(amount, currency) : null;
  const amountProblem = amount.trim() === "" ? null
    : parsed === null || parsed <= 0 ? ADMIN_DISCOUNT_MESSAGE.invalid_amount
      : parsed > remaining ? ADMIN_DISCOUNT_MESSAGE.exceeds_remaining : null;
  const trimmedReason = reason.trim();
  const reasonOk = trimmedReason.length >= ADMIN_DISCOUNT_REASON_MIN && trimmedReason.length <= ADMIN_DISCOUNT_REASON_MAX;
  const ready = parsed !== null && parsed > 0 && amountProblem === null && reasonOk && !busy;
  const netBefore = Math.max(0, invoice.totalMinor - invoice.discountMinor);

  async function submit() {
    if (!ready || submitting.current || parsed === null) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/invoices/${invoice.id}/discount`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, reason: trimmedReason, expectedDiscountMinor }),
      });
      const payload = await response.json().catch(() => null) as { message?: unknown } | null;
      if (!response.ok) {
        setError(typeof payload?.message === "string" && payload.message.trim() ? payload.message : "تعذّر تسجيل الخصم. أعد المحاولة.");
        return;
      }
      onDone(`سُجّل خصم إداري ${formatMoney(parsed, currency)} على الفاتورة ${invoice.invoiceNumber}.`);
    } catch {
      setError("تعذّر الاتصال. لم يُؤكَّد تسجيل الخصم؛ حدّث الصفحة وتحقّق من الفاتورة قبل إعادة المحاولة.");
    } finally { submitting.current = false; setBusy(false); }
  }

  return (
    <section aria-label={`خصم إداري على الفاتورة ${invoice.invoiceNumber}`} data-testid={`invoice-admin-discount-${invoice.id}`}
      className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs">
      <p className="font-bold text-emerald-900">خصم إداري على فاتورة صادرة</p>
      <p className="mt-1 leading-5 text-slate-600">
        يقلّل صافي الفاتورة دون إلغائها أو تغيير بنودها. المدفوع عليها لا يُخصم ولا يُسترد بهذا الإجراء، ويُسجَّل القرار وسببه في سجل التدقيق.
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div><dt className="text-slate-500">الصافي الآن</dt><dd className="font-extrabold">{formatMoney(netBefore, currency)}</dd></div>
        <div><dt className="text-slate-500">المدفوع عليها</dt><dd className="font-extrabold">{formatMoney(Math.max(0, settledMinor), currency)}</dd></div>
        <div><dt className="text-slate-500">المتبقي</dt><dd className="font-extrabold" data-testid="admin-discount-remaining">{formatMoney(remaining, currency)}</dd></div>
        <div><dt className="text-slate-500">الصافي بعد الخصم</dt><dd className="font-extrabold text-emerald-800" data-testid="admin-discount-net-after">
          {parsed !== null && amountProblem === null ? formatMoney(netBefore - parsed, currency) : "—"}</dd></div>
      </dl>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="font-semibold">مبلغ الخصم ({currency})
          <input value={amount} onChange={(event) => { setAmount(event.target.value); setError(null); }} inputMode="decimal" dir="ltr"
            aria-label="مبلغ الخصم الإداري" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm" />
        </label>
        <label className="font-semibold">سبب الخصم
          <input value={reason} onChange={(event) => { setReason(event.target.value); setError(null); }} maxLength={ADMIN_DISCOUNT_REASON_MAX}
            aria-label="سبب الخصم الإداري" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm" />
        </label>
      </div>
      {amountProblem ? <p role="alert" className="mt-1 font-bold text-rose-700">{amountProblem}</p> : null}
      {error ? <p role="alert" data-testid="admin-discount-error" className="mt-1 font-bold text-rose-700">{error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={!ready} onClick={() => void submit()}
          className="min-h-10 rounded-xl bg-emerald-700 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">
          {busy ? "جارٍ الحفظ…" : "اعتماد الخصم"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}
          className="min-h-10 rounded-xl border border-slate-200 bg-white px-4 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
      </div>
    </section>
  );
}
