"use client";

import { MONEY_UNCERTAIN, type MoneyAttempt } from "@/lib/money-attempt";

export function MoneyAttemptNotice({ attempt, onRetry }: { attempt: MoneyAttempt | null; onRetry: () => void }) {
  if (!attempt) return null;
  if (attempt.phase === "sending") return <p role="status" className="mb-3 text-sm">جارٍ انتظار إقرار العملية. لا تعِد تحميل الصفحة.</p>;
  const original = JSON.parse(attempt.request.body) as { amount?: string; currency?: string };
  return (
    <div role="status" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <p>{attempt.phase === "confirmed" ? "وصل إقرار صالح للعملية السابقة. اعرض نتيجتها قبل تسجيل عملية أخرى." : MONEY_UNCERTAIN}</p>
      {original.amount && original.currency ? <p>المبلغ في الطلب المحفوظ: {original.amount} {original.currency}</p> : null}
      <button type="button" onClick={onRetry}
        className="mt-2 rounded-lg border border-amber-600 px-3 py-2 font-bold disabled:opacity-50">
        {attempt.phase === "confirmed" ? "عرض نتيجة العملية السابقة" : "إعادة التحقق من العملية السابقة"}
      </button>
    </div>
  );
}
