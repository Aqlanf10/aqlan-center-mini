import { IDEMPOTENCY_KEY_PATTERN, newIdempotencyKey } from "./idempotency-key";

/**
 * Client side of the expense request key (docs/finance/EXPENSE_COMMANDS_0128.md §2.1).
 *
 * One key per intended voucher. The key is reused for every send of the exact same request body until
 * the server gives a definitive answer, so a double click, a retry or a lost response replays the first
 * voucher instead of writing a second one. The pending attempt is kept in the tab's session storage, so a
 * reload followed by the same entry still reuses the key. A changed body is a new voucher with a new key.
 */
export const EXPENSE_ATTEMPT_STORAGE_KEY = "aqlan-expense-attempt:v1";
export const EXPENSE_UNCERTAIN = "تعذّر تأكيد تسجيل سند الصرف؛ قد يكون سُجّل. أعد الإرسال بالقيم نفسها للتحقق — لن يُسجَّل سند ثانٍ.";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface Pending { body: string; key: string }

function read(storage: StorageLike | null): Pending[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(EXPENSE_ATTEMPT_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((row): row is Pending => typeof row === "object" && row !== null
      && typeof (row as Pending).body === "string" && typeof (row as Pending).key === "string"
      && IDEMPOTENCY_KEY_PATTERN.test((row as Pending).key)).slice(-20) : [];
  } catch { return []; }
}
function write(storage: StorageLike | null, rows: Pending[]) {
  if (!storage) return;
  try {
    if (rows.length) storage.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, JSON.stringify(rows.slice(-20)));
    else storage.removeItem(EXPENSE_ATTEMPT_STORAGE_KEY);
  } catch { /* storage full or blocked: the in-page attempt still holds the key */ }
}

/** The key for this exact body: the pending one if this body was sent before without a definitive answer. */
export function expenseAttemptKey(storage: StorageLike | null, body: string): string {
  const rows = read(storage);
  const found = rows.find((row) => row.body === body);
  if (found) return found.key;
  const key = newIdempotencyKey("exp");
  write(storage, [...rows, { body, key }]);
  return key;
}

/** A definitive answer (saved, replayed or refused): the key is spent or unused, never retried again. */
export function settleExpenseAttempt(storage: StorageLike | null, key: string) {
  write(storage, read(storage).filter((row) => row.key !== key));
}

/** 2xx and 4xx are definitive; 5xx, a redirect or a network failure leaves the outcome unknown. */
export function isDefinitiveExpenseAnswer(status: number): boolean {
  return status >= 200 && status < 500 && !(status >= 300 && status < 400);
}

export function sessionStorageOrNull(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}
