"use client";

import { useState } from "react";
import type { Currency } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { useSession } from "./SessionProvider";
import { ReceiptCorrection } from "./ReceiptCorrection";

/**
 * (RC-2) زرّ «تصحيح السند» في كل مكانٍ يظهر فيه سند قبض — لا في تبويب الحساب وحده.
 *
 * الخطأ يُكتشف غالبًا لحظة القبض (بطاقة «سُجّلت الدفعة») أو في قائمة سندات الصندوق — فالتصحيح
 * هناك. الزرّ يحمّل حساب المريض عند النقر (المتبقي من السند، فواتيره، خططه، أرصدته السابقة)
 * ثم يفتح نموذج التصحيح نفسه. للمدير وحده؛ والخادم يفرض ذلك أيضًا.
 */

interface LedgerPayment {
  id: number; receiptNumber: string; kind: "payment" | "refund"; amountMinor: number; currency: Currency;
  method: string; invoiceId: number | null; planId?: number | null; openingCurrency?: Currency | null;
}
interface LedgerForCorrection {
  payments: LedgerPayment[];
  invoices: { id: number; invoiceNumber: string; baseCurrency?: Currency; status: string }[];
  plans: { id: number; title: string; baseCurrency?: Currency; status: string }[];
  openings?: { amountMinor: number; currency?: Currency }[];
  baseCurrency: Currency;
  receiptRemaining?: Record<string, number>;
}

export function ReceiptCorrectionLauncher({ paymentId, patientId, label = "تصحيح السند", className, onDone }: {
  paymentId: number;
  patientId: number;
  label?: string;
  className?: string;
  /** بعد نجاح التصحيح: رسالة النتيجة، ورقم السند الصحيح (null في الإبطال). */
  onDone?: (message: string, replacementId: number | null) => void;
}) {
  const session = useSession();
  const [ledger, setLedger] = useState<LedgerForCorrection | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!isAdmin(session?.role)) return null;

  const start = async () => {
    setLoading(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/ledger`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل حساب المريض.");
      setLedger(payload as LedgerForCorrection);
      setOpen(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل حساب المريض.");
    } finally {
      setLoading(false);
    }
  };

  const receipt = ledger?.payments.find((payment) => payment.id === paymentId) ?? null;
  const remaining = ledger?.receiptRemaining?.[paymentId] ?? 0;
  const base = ledger?.baseCurrency ?? "YER";

  return (
    <>
      {!open ? (
        <button type="button" onClick={start} disabled={loading}
          className={className ?? "rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800 disabled:opacity-50"}>
          {loading ? "…" : label}
        </button>
      ) : null}
      {error ? <p role="alert" className="w-full text-xs font-bold text-red-700">{error}</p> : null}
      {done ? <p role="status" className="w-full text-xs font-bold text-emerald-800">{done}</p> : null}
      {open && ledger ? (
        !receipt || receipt.kind !== "payment" || remaining <= 0 ? (
          <p className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">
            هذا السند معكوسٌ بالكامل سلفًا — لا شيء يُصحَّح فيه.{" "}
            <button type="button" onClick={() => setOpen(false)} className="underline">إغلاق</button>
          </p>
        ) : (
          <ReceiptCorrection
            receipt={receipt}
            remainingMinor={remaining}
            invoices={ledger.invoices.map((invoice) => ({ ...invoice, baseCurrency: invoice.baseCurrency ?? base }))}
            plans={ledger.plans}
            openingCurrencies={(ledger.openings ?? []).filter((row) => row.amountMinor !== 0).map((row) => row.currency ?? base)}
            onCancel={() => setOpen(false)}
            onDone={(message, replacementId) => {
              setOpen(false);
              setDone(message);
              onDone?.(message, replacementId);
            }}
          />
        )
      ) : null}
    </>
  );
}
