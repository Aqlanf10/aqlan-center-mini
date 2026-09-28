"use client";

import { useMemo, useState } from "react";
import { formatMoney, parseAmount, toInputAmount, type Currency } from "@/lib/money";
import { CORRECTION_REASON_MIN } from "@/lib/invoice-correction";

/**
 * (FIN-2) تصحيح فاتورةٍ بمبلغٍ زائد — للمدير.
 *
 * يخفّض سعر البند أو كميته أو يحذف البند الزائد، بسببٍ مكتوب. الخادم يلغي الفاتورة
 * ويصدر بدلها فاتورةً مصحَّحة برقمٍ جديد؛ والمدفوع على الأولى يبقى للمريض.
 */

interface Item { id: number; description: string; quantity: number; unitPriceMinor: number; totalMinor: number }
interface InvoiceLike {
  id: number; invoiceNumber: string; totalMinor: number; discountMinor: number;
  baseCurrency: Currency; items: Item[];
}

interface Draft { keep: boolean; quantity: string; price: string }

export function InvoiceCorrection({ invoice, onDone, onCancel }: {
  invoice: InvoiceLike;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const currency = invoice.baseCurrency;
  const [drafts, setDrafts] = useState<Record<number, Draft>>(() => Object.fromEntries(
    invoice.items.map((item) => [item.id, {
      keep: true, quantity: String(item.quantity), price: toInputAmount(item.unitPriceMinor, currency),
    }]),
  ));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    let total = 0;
    for (const item of invoice.items) {
      const draft = drafts[item.id];
      if (!draft?.keep) continue;
      const quantity = Number(draft.quantity);
      const price = parseAmount(draft.price, currency);
      if (!Number.isInteger(quantity) || quantity < 1 || price === null) return null;
      total += quantity * price;
    }
    const discount = Math.min(invoice.discountMinor, total);
    const before = Math.max(0, invoice.totalMinor - invoice.discountMinor);
    return { after: total - discount, before };
  }, [drafts, invoice, currency]);

  const update = (id: number, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const lines = invoice.items
        .filter((item) => drafts[item.id]?.keep)
        .map((item) => ({ itemId: item.id, quantity: Number(drafts[item.id].quantity), unitPrice: drafts[item.id].price }));
      const response = await fetch(`/api/invoices/${invoice.id}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, lines }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر تصحيح الفاتورة."); return; }
      const corrected = payload?.corrected as { invoiceNumber: string } | undefined;
      onDone(`أُلغيت ${invoice.invoiceNumber} وصدرت بدلها ${corrected?.invoiceNumber ?? "الفاتورة المصحَّحة"}.`);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const reduced = preview !== null && preview.after < preview.before;
  const ready = reduced && reason.trim().length >= CORRECTION_REASON_MIN && !busy;

  return (
    <div role="group" aria-label={`تصحيح ${invoice.invoiceNumber}`} className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <p className="mb-2 text-xs font-bold text-amber-900">
        خفّض السعر أو الكمية، أو ألغِ البند الزائد. تُلغى هذه الفاتورة وتصدر بدلها فاتورةٌ مصحَّحة، وما دُفع يبقى للمريض.
      </p>
      <ul className="space-y-2">
        {invoice.items.map((item) => {
          const draft = drafts[item.id];
          return (
            <li key={item.id} className={`rounded-lg border bg-white p-2 ${draft.keep ? "border-slate-200" : "border-slate-200 opacity-50"}`}>
              <label className="flex items-center gap-2 text-xs font-bold">
                <input type="checkbox" checked={draft.keep} onChange={(event) => update(item.id, { keep: event.target.checked })}
                  aria-label={`إبقاء ${item.description}`} />
                <span className="truncate">{item.description}</span>
              </label>
              {draft.keep ? (
                <div className="mt-1 flex gap-2">
                  <input value={draft.quantity} onChange={(event) => update(item.id, { quantity: event.target.value })}
                    aria-label={`كمية ${item.description}`} inputMode="numeric" dir="ltr"
                    className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                  <input value={draft.price} onChange={(event) => update(item.id, { price: event.target.value })}
                    aria-label={`سعر ${item.description}`} inputMode="decimal" dir="ltr"
                    className="w-28 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                  <span className="self-center text-[11px] text-slate-500">
                    كان {item.quantity} × {formatMoney(item.unitPriceMinor, currency)}
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300}
        placeholder="سبب التصحيح — مثل: السعر المسجّل أعلى من المتفق عليه" aria-label="سبب التصحيح"
        className="mt-2 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" rows={2} />
      <p className="mt-1 text-xs font-bold text-slate-700">
        {preview === null ? "راجع الكميات والأسعار."
          : `قبل: ${formatMoney(preview.before, currency)} ← بعد: ${formatMoney(preview.after, currency)}`
            + (reduced ? ` (تخفيض ${formatMoney(preview.before - preview.after, currency)})` : "")}
      </p>
      {error ? <p role="alert" className="mt-1 text-xs font-bold text-red-700">{error}</p> : null}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={submit} disabled={!ready}
          className="flex-1 rounded-lg bg-amber-600 py-2 text-xs font-extrabold text-white disabled:opacity-50">
          صحّح الفاتورة
        </button>
        <button type="button" onClick={onCancel}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600">
          إلغاء
        </button>
      </div>
    </div>
  );
}
