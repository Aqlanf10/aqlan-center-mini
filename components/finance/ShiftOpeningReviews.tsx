"use client";

import { useCallback, useState } from "react";
import { CURRENCIES, CURRENCY_SHORT, formatMoney, type Currency } from "@/lib/money";

/**
 * Opening differences against the previous close (migration 0129; docs/finance/SHIFT_OPENING_REVIEWS_0129.md;
 * blind count §8, owner #483 6886911163). The server decides what each viewer receives: the owner or an
 * authorized reviewer gets the previous count, the difference and the review texts; everyone else only which
 * currency waits for review. The review form (once per difference, no cash movement) and the correction of the
 * open shift's count appear only when the server says this session may review; the server decides again on
 * every write.
 */
export interface OpeningReviewNotice { id: number; shiftId: number; currency: Currency; state: "pending" | "reviewed" }
export interface OpeningReviewFull extends OpeningReviewNotice {
  previousShiftId: number;
  previousCountedMinor: number | null;
  openingMinor: number;
  differenceMinor: number | null;
  detectedBy: string;
  detectedAt: string;
  reviewReason: string | null;
  reviewSettlement: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}
export type OpeningReviewItem = OpeningReviewNotice | OpeningReviewFull;
export interface OpeningCorrectionItem { id: number; shiftId: number; currency: Currency; fromMinor?: number; toMinor?: number; reason?: string; correctedBy?: string }

const isFull = (row: OpeningReviewItem): row is OpeningReviewFull => "differenceMinor" in row;

export function describeOpeningDifference(row: OpeningReviewItem): string {
  if (!isFull(row)) return `${CURRENCY_SHORT[row.currency]}: سُجّل فرق في عدّ الافتتاح`;
  if (row.differenceMinor === null) return `${CURRENCY_SHORT[row.currency]}: عدّ الإقفال السابق غير معروف`;
  return `${row.differenceMinor > 0 ? "زيادة" : "نقص"} ${formatMoney(Math.abs(row.differenceMinor), row.currency)}`;
}

function ReviewForm({ row, onDone }: { row: OpeningReviewFull; onDone: () => void }) {
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
        {row.previousCountedMinor !== null ? ` (المعدود عند الإقفال ${formatMoney(row.previousCountedMinor, row.currency)}، والمعدود عند الافتتاح ${formatMoney(row.openingMinor, row.currency)})` : ""}
      </p>
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

/** §8.4: the owner or a reviewer (never the opener) corrects the open shift's count, with a reason; audited. */
function CorrectionForm({ shiftId, onDone }: { shiftId: number; onDone: () => void }) {
  const [amounts, setAmounts] = useState<Record<Currency, string>>({ YER: "", SAR: "", USD: "" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const opening = Object.fromEntries(CURRENCIES.filter(c => amounts[c].trim() !== "").map(c => [c, amounts[c].trim()]));
      const res = await fetch("/api/shifts/opening-corrections", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shiftId, opening, reason }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) { setMessage({ ok: false, text: payload?.message ?? "تعذّر تسجيل التصحيح." }); return; }
      setMessage({ ok: true, text: "سُجّل تصحيح عدّ الافتتاح وسبب التصحيح في السجل. لم تُنشأ أي حركة نقدية." });
      setAmounts({ YER: "", SAR: "", USD: "" }); setReason("");
      onDone();
    } catch {
      setMessage({ ok: false, text: "تعذّر الاتصال بالخادم؛ لم يتأكد التصحيح. حدّث الصفحة قبل الإعادة." });
    } finally {
      setBusy(false);
    }
  };
  const any = CURRENCIES.some(c => amounts[c].trim() !== "");
  return (
    <form data-testid="opening-correction-form" className="mt-3 rounded-2xl border border-amber-200 bg-white p-3"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="mb-2 text-xs font-black text-navy-900">تصحيح عدّ افتتاح الوردية #{shiftId} (للمالك والمراجع المخوّل؛ لا يصحّحه من فتح الوردية)</p>
      <div className="mb-2 grid grid-cols-3 gap-2">
        {CURRENCIES.map((currency) => (
          <label key={currency} className="block text-xs font-bold text-slate-700">
            العدّ المصحَّح {currency}
            <input inputMode="decimal" value={amounts[currency]} onChange={(e) => setAmounts({ ...amounts, [currency]: e.target.value })}
              className="mt-1 w-full rounded-xl border border-slate-200 px-2 py-1.5 text-sm" />
          </label>
        ))}
      </div>
      <label className="mb-2 block text-xs font-bold text-slate-700">
        سبب التصحيح
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      </label>
      {message ? <p role={message.ok ? "status" : "alert"} className={`mb-2 text-xs font-bold ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p> : null}
      <button type="submit" disabled={busy || !any || reason.trim().length < 3}
        className="rounded-xl bg-navy-900 px-4 py-2 text-xs font-black text-white disabled:opacity-50">
        {busy ? "جارٍ التسجيل…" : "سجّل التصحيح"}
      </button>
    </form>
  );
}

export default function ShiftOpeningReviews({ openShiftId, openShiftReviews, openShiftCorrections = [], pending, canReview, onReviewed }: {
  openShiftId?: number | null;
  openShiftReviews: OpeningReviewItem[];
  openShiftCorrections?: OpeningCorrectionItem[];
  pending: number;
  canReview: boolean;
  onReviewed: () => void;
}) {
  const [list, setList] = useState<OpeningReviewFull[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/shifts/opening-reviews?status=pending", { cache: "no-store" });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(payload?.reviews)) { setLoadError(payload?.message ?? "تعذّر تحميل الفروق المعلّقة."); return; }
      setList((payload.reviews as OpeningReviewItem[]).filter(isFull));
    } catch { setLoadError("تعذّر الاتصال بالخادم."); }
  }, []);
  const canCorrect = canReview && typeof openShiftId === "number";
  if (!openShiftReviews.length && pending <= 0 && !openShiftCorrections.length && !canCorrect) return null;
  return (
    <section data-testid="opening-differences" aria-label="فروق افتتاح الوردية" className="mb-4 rounded-3xl border border-amber-300 bg-amber-50 p-4">
      <h3 className="mb-2 text-sm font-black text-amber-900">فرق بين افتتاح الوردية وإقفال الوردية السابقة</h3>
      {openShiftReviews.length ? (
        <ul className="mb-2 space-y-1 text-xs text-amber-900">
          {openShiftReviews.map((row) => (
            <li key={row.id} data-testid="opening-difference">
              {describeOpeningDifference(row)} — {row.state === "reviewed" ? `روجع${isFull(row) && row.reviewedBy ? ` (${row.reviewedBy})` : ""}` : "بانتظار المراجعة"}
            </li>
          ))}
        </ul>
      ) : null}
      {openShiftReviews.some(row => !isFull(row)) ? (
        <p className="mb-2 text-xs text-amber-900" data-testid="opening-difference-blind">
          عُدّ الافتتاح وسُجّل كما أُدخل، وأُحيل الفرق إلى المراجعة. لا يظهر رصيد الإقفال السابق ولا مقدار الفرق إلا للمالك والمراجع المخوّل.
        </p>
      ) : null}
      {openShiftCorrections.length ? (
        <ul className="mb-2 space-y-1 text-xs text-amber-900" data-testid="opening-corrections">
          {openShiftCorrections.map((row) => (
            <li key={row.id}>
              {row.fromMinor !== undefined && row.toMinor !== undefined
                ? `صُحّح عدّ ${CURRENCY_SHORT[row.currency]} من ${formatMoney(row.fromMinor, row.currency)} إلى ${formatMoney(row.toMinor, row.currency)} (${row.correctedBy}): ${row.reason}`
                : `صُحّح عدّ ${CURRENCY_SHORT[row.currency]} من قِبل مراجع مخوّل.`}
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
      {canCorrect ? <CorrectionForm shiftId={openShiftId!} onDone={onReviewed} /> : null}
    </section>
  );
}
