"use client";

import { useState, useSyncExternalStore } from "react";
import {
  EXPENSE_UNCERTAIN, NO_EXPENSE_ATTEMPTS, dismissExpenseAttempt, expenseAttemptsSnapshot, sendExpenseAttempt,
  sessionStorageOrNull, subscribeExpenseAttempts, type ExpenseAttempt, type ExpenseSurface,
} from "@/lib/expense-attempt";

/**
 * Review #483 6882465665: an expense request whose outcome is not proven stays visible to the user who sent
 * it until it is verified. «تحقّق» resends the exact stored request with its key: the server replays the
 * saved voucher, or proves nothing is recorded under the key. Nothing here creates a new request.
 */
export default function PendingExpenseAttempts({ actor, surface, onSettled }: {
  actor: string | null | undefined;
  surface?: ExpenseSurface;
  onSettled?: (voucherId: number | null) => void;
}) {
  const all = useSyncExternalStore(subscribeExpenseAttempts,
    () => actor ? expenseAttemptsSnapshot(sessionStorageOrNull(), actor) : NO_EXPENSE_ATTEMPTS,
    () => NO_EXPENSE_ATTEMPTS);
  const pending = surface ? all.filter((row) => row.surface === surface) : all;
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (!actor || pending.length === 0) return null;

  const verify = async (attempt: ExpenseAttempt) => {
    if (busy) return;
    setBusy(attempt.key);
    try {
      const result = await sendExpenseAttempt(sessionStorageOrNull(), attempt);
      const message = typeof result.payload?.message === "string" ? result.payload.message : "";
      if (result.answer === "saved") {
        setNotes((n) => ({ ...n, [attempt.key]: `تأكّد: السند ${String(result.payload?.voucherNumber ?? "")} محفوظ مرة واحدة.` }));
        onSettled?.(Number(result.payload?.id));
      } else if (result.answer === "refused") {
        setNotes((n) => ({ ...n, [attempt.key]: `ثبت أنه لم يُسجَّل: ${message}` }));
        onSettled?.(null);
      } else {
        setNotes((n) => ({ ...n, [attempt.key]: message ? `${message}\n${EXPENSE_UNCERTAIN}` : EXPENSE_UNCERTAIN }));
      }
    } finally { setBusy(null); }
  };
  const dismiss = (attempt: ExpenseAttempt) => {
    if (!window.confirm("لم تثبت نتيجة هذا الطلب. أخفِه فقط إن تحققت بنفسك من سجل الصرف أن السند سُجّل أو لم يُسجّل. متابعة؟")) return;
    dismissExpenseAttempt(sessionStorageOrNull(), attempt.key);
  };

  return (
    <section aria-label="طلبات صرف غير مؤكدة" data-testid="pending-expense-attempts"
      className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
      <p className="font-black">طلب صرف لم تتأكد نتيجته — لا تسجّله من جديد</p>
      <ul className="mt-2 space-y-2">
        {pending.map((attempt) => (
          <li key={attempt.key} className="flex flex-wrap items-center gap-2" data-testid="pending-expense-attempt">
            <span className="font-bold">{attempt.label}</span>
            <button type="button" onClick={() => void verify(attempt)} disabled={busy !== null}
              className="rounded-lg bg-amber-700 px-3 py-1 font-black text-white disabled:opacity-50">
              {busy === attempt.key ? "جارٍ التحقق…" : "تحقّق"}
            </button>
            <button type="button" onClick={() => dismiss(attempt)} disabled={busy !== null}
              className="rounded-lg border border-amber-400 px-3 py-1 font-bold">إخفاء بعد تحقق يدوي</button>
            {notes[attempt.key] ? <span className="w-full whitespace-pre-line" role="status">{notes[attempt.key]}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
