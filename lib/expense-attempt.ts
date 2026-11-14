import { IDEMPOTENCY_KEY_PATTERN, newIdempotencyKey } from "./idempotency-key";

/**
 * Client side of the expense request key (docs/finance/EXPENSE_COMMANDS_0128.md §2.1; owner's review
 * #483 6882465665).
 *
 * One key per intended voucher, owned by the user who first sent it. The attempt, with the exact body
 * that was sent, stays pending until an answer PROVES its outcome:
 *  - "saved": a readable receipt (a voucher id and number). A replay of the same key returns the same
 *    receipt, so resending a pending attempt can only ever confirm it.
 *  - "refused": a refusal in which the server states `requestKeyState: "unused"`, i.e. it checked the
 *    key under its lock and nothing is recorded under it.
 *  - everything else is "unknown": a network failure, a 5xx, a redirect, a success whose body cannot be
 *    read, a 401/403 (the request never reached the key check), a key conflict, or a refusal without the
 *    server's statement. The attempt and its key are kept, never replaced by a new key.
 * Pending attempts are kept in the tab's session storage and, in every case, in page memory, so a broken
 * or blocked storage still keeps the key stable for retries in the same page (`persisted: false` tells the
 * screen that a reload would lose it).
 */
export const EXPENSE_ATTEMPT_STORAGE_KEY = "aqlan-expense-attempt:v2";
export const EXPENSE_UNCERTAIN = "تعذّر تأكيد نتيجة سند الصرف؛ قد يكون سُجّل. لا تسجّله من جديد: استعمل «تحقّق» أو أعد الإرسال بالقيم نفسها — لن يُسجَّل سند ثانٍ.";
export const EXPENSE_NOT_PERSISTED = "تخزين المتصفح غير متاح: يبقى الطلب غير المؤكد محفوظًا في هذه الصفحة فقط. لا تُعِد تحميلها قبل التحقق.";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ExpenseSurface = "petty" | "bill";
export interface ExpenseAttempt {
  key: string;
  /** The username that first sent it; only that user sees, resends or dismisses it. */
  actor: string;
  surface: ExpenseSurface;
  /** What identifies the same intended voucher (the request without volatile preview values). */
  match: string;
  /** The exact body sent, resent as is when verifying. */
  body: string;
  /** A short Arabic description for the pending notice. */
  label: string;
  createdAt: number;
}
export type ExpenseAnswer = "saved" | "refused" | "unknown";

const MAX = 20;
const memory = new Map<string, ExpenseAttempt>();

function valid(row: unknown): row is ExpenseAttempt {
  if (!row || typeof row !== "object") return false;
  const a = row as Record<string, unknown>;
  return typeof a.key === "string" && IDEMPOTENCY_KEY_PATTERN.test(a.key) && typeof a.actor === "string" && a.actor.length > 0
    && (a.surface === "petty" || a.surface === "bill") && typeof a.match === "string" && typeof a.body === "string"
    && typeof a.label === "string" && typeof a.createdAt === "number";
}
function readStored(storage: StorageLike | null): ExpenseAttempt[] | null {
  if (!storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(EXPENSE_ATTEMPT_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch { return null; }
}
function all(storage: StorageLike | null): ExpenseAttempt[] {
  const merged = new Map(memory);
  for (const row of readStored(storage) ?? []) if (!merged.has(row.key)) merged.set(row.key, row);
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}
const listeners = new Set<() => void>();
/** For useSyncExternalStore: the pending notice re-reads after any change in this page. */
export function subscribeExpenseAttempts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const snapshots = new Map<string, { text: string; rows: ExpenseAttempt[] }>();
/** A stable snapshot per user (same array while nothing changed). */
export function expenseAttemptsSnapshot(storage: StorageLike | null, actor: string): ExpenseAttempt[] {
  const rows = pendingExpenseAttempts(storage, actor);
  const text = JSON.stringify(rows);
  const cached = snapshots.get(actor);
  if (cached && cached.text === text) return cached.rows;
  snapshots.set(actor, { text, rows });
  return rows;
}
export const NO_EXPENSE_ATTEMPTS: ExpenseAttempt[] = [];

function write(storage: StorageLike | null, rows: ExpenseAttempt[]): boolean {
  memory.clear();
  for (const row of rows.slice(-MAX)) memory.set(row.key, row);
  queueMicrotask(() => { for (const listener of listeners) listener(); });
  if (!storage) return false;
  try {
    if (memory.size) storage.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, JSON.stringify([...memory.values()]));
    else storage.removeItem(EXPENSE_ATTEMPT_STORAGE_KEY);
    return true;
  } catch { return false; }
}

/** The pending attempt of this user for this intended voucher, or a new one. */
export function beginExpenseAttempt(storage: StorageLike | null, input: Omit<ExpenseAttempt, "key" | "createdAt">):
  { attempt: ExpenseAttempt; persisted: boolean } {
  const rows = all(storage);
  const found = rows.find((row) => row.actor === input.actor && row.surface === input.surface && row.match === input.match);
  if (found) {
    // Keep the key; the latest exact body is what a verify resends (its fingerprint excludes preview values).
    const updated = { ...found, body: input.body, label: input.label };
    return { attempt: updated, persisted: write(storage, rows.map((row) => row.key === found.key ? updated : row)) };
  }
  const attempt: ExpenseAttempt = { ...input, key: newIdempotencyKey("exp"), createdAt: Date.now() };
  return { attempt, persisted: write(storage, [...rows, attempt]) };
}

export function pendingExpenseAttempts(storage: StorageLike | null, actor: string): ExpenseAttempt[] {
  return all(storage).filter((row) => row.actor === actor);
}

/** Only after a "saved" or "refused" answer. */
export function settleExpenseAttempt(storage: StorageLike | null, key: string) {
  write(storage, all(storage).filter((row) => row.key !== key));
}
/** Only on the user's explicit confirmation that they checked the outcome themselves. */
export const dismissExpenseAttempt = settleExpenseAttempt;

export function classifyExpenseAnswer(status: number, redirected: boolean, payload: unknown): ExpenseAnswer {
  if (redirected) return "unknown";
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if ((status === 200 || status === 201) && body && Number.isSafeInteger(body.id) && (body.id as number) > 0
    && typeof body.voucherNumber === "string" && body.voucherNumber.length > 0) return "saved";
  if (status >= 400 && status < 500 && body?.requestKeyState === "unused") return "refused";
  return "unknown";
}

export function sessionStorageOrNull(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}

/** Test seam: page memory only lives as long as the module. */
export function resetExpenseAttemptMemoryForTesting() { memory.clear(); }

/**
 * Send (or resend) an attempt and read what the answer proves. The body is read before anything is
 * settled; a pending attempt is settled only on "saved" or "refused".
 */
export async function sendExpenseAttempt(storage: StorageLike | null, attempt: ExpenseAttempt, transport: typeof fetch = fetch):
  Promise<{ answer: ExpenseAnswer; status: number | null; payload: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await transport("/api/expenses", { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key }, body: attempt.body });
  } catch {
    return { answer: "unknown", status: null, payload: null };
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch { payload = null; }
  const answer = classifyExpenseAnswer(response.status, response.redirected, payload);
  if (answer !== "unknown") settleExpenseAttempt(storage, attempt.key);
  return { answer, status: response.status, payload };
}
