"use client";

import { useCallback, useState } from "react";
import { CURRENCY_SHORT, formatMoney, type Currency } from "@/lib/money";

/**
 * Opening differences against the previous close (migration 0129; docs/finance/SHIFT_OPENING_REVIEWS_0129.md).
 * Shows the open shift's differences and the clinic's pending count to every shift viewer. The review form
 * (reason and settlement, once per difference, no cash movement) appears only for whoever the server says may
 * review; the server decides again on every review.
 */
export interface OpeningReviewItem {
  id: number;
  shiftId: number;
  currency: Currency;
  previousShiftId: number;
  previousCountedMinor: number | null;
  openingMinor: number;
  differenceMinor: number | null;
  openingNote: string | null;
  detectedBy: string;
  detectedAt: string;
  reviewReason: string | null;
  reviewSettlement: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export function describeOpeningDifference(row: Pick<OpeningReviewItem, "currency" | "differenceMinor">): string {
  if (row.differenceMinor === null) return `${CURRENCY_SHORT[row.currency]}: عدّ الإقفال السابق غير معروف`;
  return `${row.differenceMinor > 0 ? "زيادة" : "نقص"} ${formatMoney(Math.abs(row.differenceMinor), row.currency)}`;
}

function ReviewForm({ row, onDone }: { row: OpeningReviewItem; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [settlement, setSettlement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/shifts/opening-reviews", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, reason, settlement }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.message ?? "تعذّر تسجيل المراجعة.");
        // Already reviewed elsewhere: the list is stale, refresh it.
        if (payload?.code === "opening_review_already_done") onDone();
        return;
      }
      onDone();
    } catch {
      setError("تعذّر الاتصال بالخادم؛ لم يتأكد تسجيل المراجعة. حدّث القائمة قبل الإعادة.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li data-testid="opening-review-form" className="rounded-2xl border border-amber-200 bg-white p-3">
      <p className="mb-2 text-xs font-black text-navy-900">
        وردية #{row.shiftId} ({row.detectedBy}) — {describeOpeningDifference(row)} مقابل إقفال الوردية #{row.previousShiftId}
      </p>
      {row.openingNote ? <p className="mb-2 text-xs text-slate-600">ملاحظة الافتتاح: {row.openingNote}</p> : null}
      <label className="mb-2 block text-xs font-bold text-slate-700">
        سبب الفرق
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      </label>
      <label className="mb-2 block text-xs font-bold text-slate-700">
        كيف سُوّي (خارج الدرج؛ لا تُنشأ حركة نقدية)
        <input value={settlement} onChange={(e) => setSettlement(e.target.value)} maxLength={300}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      </label>
      {error ? <p role="alert" className="mb-2 text-xs font-bold text-red-700">{error}</p> : null}
      <button type="button" onClick={() => void submit()} disabled={busy || reason.trim().length < 3 || settlement.trim().length < 3}
        className="rounded-xl bg-navy-900 px-4 py-2 text-xs font-black text-white disabled:opacity-50">
        {busy ? "جارٍ التسجيل…" : "سجّل المراجعة"}
      </button>
    </li>
  );
}

export default function ShiftOpeningReviews({ openShiftReviews, pending, canReview, onReviewed }: {
  openShiftReviews: OpeningReviewItem[];
  pending: number;
  canReview: boolean;
  onReviewed: () => void;
}) {
  const [list, setList] = useState<OpeningReviewItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/shifts/opening-reviews?status=pending", { cache: "no-store" });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(payload?.reviews)) { setLoadError(payload?.message ?? "تعذّر تحميل الفروق المعلّقة."); return; }
      setList(payload.reviews);
    } catch { setLoadError("تعذّر الاتصال بالخادم."); }
  }, []);
  if (!openShiftReviews.length && pending <= 0) return null;
  return (
    <section data-testid="opening-differences" aria-label="فروق افتتاح الوردية" className="mb-4 rounded-3xl border border-amber-300 bg-amber-50 p-4">
      <h3 className="mb-2 text-sm font-black text-amber-900">فرق بين افتتاح الوردية وإقفال الوردية السابقة</h3>
      {openShiftReviews.length ? (
        <ul className="mb-2 space-y-1 text-xs text-amber-900">
          {openShiftReviews.map((row) => (
            <li key={row.id} data-testid="opening-difference">
              {describeOpeningDifference(row)} — {row.reviewedAt ? `روجع (${row.reviewedBy})` : "بانتظار المراجعة"}
              {row.openingNote ? ` — ملاحظة الافتتاح: ${row.openingNote}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {pending > 0 ? (
        <p className="text-xs font-bold text-amber-900" data-testid="opening-differences-pending">
          فروق افتتاح بانتظار المراجعة: {pending}. لم تُنشأ أي حركة نقدية، ولم تتغير أي وردية سابقة.
        </p>
      ) : null}
      {canReview && pending > 0 ? (
        <div className="mt-3">
          {list === null ? (
            <button type="button" onClick={() => void load()} className="rounded-xl border border-amber-400 bg-white px-3 py-1.5 text-xs font-black text-amber-900">
              راجع الفروق المعلّقة
            </button>
          ) : (
            <ul className="space-y-2">
              {list.map((row) => (
                <ReviewForm key={row.id} row={row} onDone={() => { void load(); onReviewed(); }} />
              ))}
            </ul>
          )}
          {loadError ? <p role="alert" className="mt-2 text-xs font-bold text-red-700">{loadError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
