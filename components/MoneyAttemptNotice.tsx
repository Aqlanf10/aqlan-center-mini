"use client";

import { MONEY_UNCERTAIN, RECONCILABLE_OPERATIONS, type MoneyAttempt } from "@/lib/money-attempt";
import { SimilarCollectionWarning } from "./SimilarCollectionWarning";

/** `onSimilar` answers an advisory similar-receipt review: confirm resends the same request/key
 * with the reviewed receipt IDs; cancel retires the attempt only when nothing can still land. */
export function MoneyAttemptNotice({ attempt, onRetry, onSimilar, onReconcile, busy = false }: {
  attempt: MoneyAttempt | null; onRetry: () => void; busy?: boolean;
  /** Server proof (0068): retire an uncertain collection only if it never committed; replay it if it did. */
  onReconcile?: () => void;
  onSimilar?: { confirm: (observedReceiptIds: number[]) => void; cancel: () => void };
}) {
  if (!attempt) return null;
  if (attempt.phase === "sending") return <p role="status" className="mb-3 text-sm">جارٍ انتظار إقرار العملية. لا تعِد تحميل الصفحة.</p>;
  if (attempt.phase === "review" && attempt.similar) {
    const receipts = attempt.similar.receipts;
    // One decision point: the screen that sent the request owns the review; others only report it.
    if (!onSimilar) return <p role="status" className="mb-3 text-sm">بانتظار قرار مراجعة سند قبض مشابه في نافذة التحصيل؛ لم يُسجَّل شيء بعد.</p>;
    return <SimilarCollectionWarning receipts={receipts} busy={busy}
      onConfirm={() => onSimilar.confirm(receipts.map((receipt) => receipt.id))} onCancel={onSimilar.cancel} />;
  }
  const original = JSON.parse(attempt.request.body) as { amount?: string; currency?: string };
  const label = { payment: "سند قبض", installment: "قسط خطة", correct: "تصحيح سند", void: "إبطال سند" }[attempt.request.operation];
  return (
    <div role="status" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <p>{attempt.phase === "confirmed" ? "وصل إقرار صالح للعملية السابقة. اعرض نتيجتها قبل تسجيل عملية أخرى." : MONEY_UNCERTAIN}</p>
      <p>العملية المحفوظة: {label}</p>
      {original.amount && original.currency ? <p>المبلغ في الطلب المحفوظ: {original.amount} {original.currency}</p> : null}
      <button type="button" onClick={onRetry}
        className="mt-2 rounded-lg border border-amber-600 px-3 py-2 font-bold disabled:opacity-50">
        {attempt.phase === "confirmed" ? "عرض نتيجة العملية السابقة" : "إعادة التحقق من العملية السابقة"}
      </button>
      {attempt.phase === "uncertain" && onReconcile && RECONCILABLE_OPERATIONS.has(attempt.request.operation) ? <>
        <button type="button" onClick={onReconcile} disabled={busy} data-testid="money-attempt-reconcile"
          className="mt-2 ms-2 rounded-lg border border-slate-400 bg-white px-3 py-2 font-bold disabled:opacity-50">
          التحقق من الخادم وإلغاء المحاولة إن لم تُحفظ
        </button>
        <p className="mt-1 text-xs text-slate-600">لا يُرسل الطلب المالي. إن كانت المحاولة محفوظة تُعرض نتيجتها؛ وإلا تُلغى نهائيًا ويمكنك تصحيح الطلب.</p>
      </> : null}
    </div>
  );
}
