import { newIdempotencyKey } from "./idempotency-key";

export const MONEY_UNCERTAIN = "تعذّر تأكيد نتيجة العملية. قد تكون سُجّلت ماليًا. أعد التحقق بنفس الطلب قبل تسجيل عملية أخرى، ولا تعِد تحميل الصفحة.";
export type MoneyRequest = Readonly<{
  url: string;
  body: string;
  operation: "payment" | "installment" | "correct" | "void";
}>;
type Receipt = { id: number; receiptNumber: string };
export type MoneyAcknowledgment = { paymentId: number | null; reversal?: Receipt; replacement?: Receipt | null };
export type MoneyAttempt = Readonly<{
  request: MoneyRequest;
  key: string;
  phase: "sending" | "uncertain" | "confirmed";
  acknowledgment?: MoneyAcknowledgment;
}>;
type Result = { kind: "confirmed"; attempt: MoneyAttempt; acknowledgment: MoneyAcknowledgment }
  | { kind: "refused" | "uncertain" | "blocked"; message: string }
  | { kind: "busy" };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function receipt(value: unknown): Receipt | null {
  const row = object(value);
  return row && id(row.id) && typeof row.receiptNumber === "string" && row.receiptNumber.trim()
    ? { id: row.id, receiptNumber: row.receiptNumber } : null;
}

export function moneyAcknowledgment(operation: MoneyRequest["operation"], value: unknown): MoneyAcknowledgment | null {
  const row = object(value);
  if (!row) return null;
  if (operation === "payment" || operation === "installment") {
    const paymentId = row[operation === "payment" ? "id" : "paymentId"];
    return id(paymentId) ? { paymentId } : null;
  }
  const reversal = receipt(row.reversal);
  if (!reversal) return null;
  if (operation === "void") return row.replacement === null ? { paymentId: null, reversal, replacement: null } : null;
  const replacement = receipt(row.replacement);
  return replacement ? { paymentId: replacement.id, reversal, replacement } : null;
}

/** Browser-memory only. A closed/unmounted form does not own the request's lifetime.
 * Keep the exact endpoint, body and key until a valid acknowledgment is consumed.
 * No timeout, form edit, read refresh or later refusal proves an ambiguous write failed.
 */
export class MoneyAttemptStore {
  private attempts = new Map<string, MoneyAttempt>();
  private listeners = new Set<() => void>();
  constructor(private transport: typeof fetch = (...args) => fetch(...args), private key = () => newIdempotencyKey("money")) {}
  get = (scope: string): MoneyAttempt | null => this.attempts.get(scope) ?? null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(scope: string, attempt: MoneyAttempt | null) {
    if (attempt) this.attempts.set(scope, attempt);
    else this.attempts.delete(scope);
    this.listeners.forEach((listener) => listener());
  }
  consume(scope: string, attempt: MoneyAttempt) {
    if (this.get(scope) === attempt && attempt.phase === "confirmed") this.publish(scope, null);
  }
  async run(scope: string, request?: MoneyRequest): Promise<Result> {
    const previous = this.get(scope);
    if (previous?.phase === "sending") return { kind: "busy" };
    if (previous && request && (previous.request.url !== request.url || previous.request.body !== request.body || previous.request.operation !== request.operation)) {
      return { kind: "blocked", message: MONEY_UNCERTAIN };
    }
    if (previous?.phase === "confirmed" && previous.acknowledgment) {
      return { kind: "confirmed", attempt: previous, acknowledgment: previous.acknowledgment };
    }
    if (!previous && !request) return { kind: "busy" };
    const attempt: MoneyAttempt = previous
      ? { ...previous, phase: "sending" }
      : { request: { ...request! }, key: this.key(), phase: "sending" };
    this.publish(scope, attempt); // synchronous lock, before fetch/React renders
    try {
      const response = await this.transport(attempt.request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key },
        body: attempt.request.body,
      });
      const payload: unknown = await response.json(); // malformed JSON is never a refusal/ack
      const acknowledgment = response.ok ? moneyAcknowledgment(attempt.request.operation, payload) : null;
      if (acknowledgment) {
        const confirmed: MoneyAttempt = { ...attempt, phase: "confirmed", acknowledgment };
        this.publish(scope, confirmed);
        return { kind: "confirmed", attempt: confirmed, acknowledgment };
      }
      const message = object(payload)?.message;
      // These routes return their explicit pre-commit refusals as 4xx. Once a
      // reply was lost, even a later permission/shift/target refusal cannot clear it.
      if (!previous && [400, 401, 403, 404, 409, 422].includes(response.status) && typeof message === "string" && message.trim()) {
        this.publish(scope, null);
        return { kind: "refused", message };
      }
    } catch {
      // The server may have committed. Never rotate the key here.
    }
    this.publish(scope, { ...attempt, phase: "uncertain" });
    return { kind: "uncertain", message: MONEY_UNCERTAIN };
  }
}

export const moneyAttempts = new MoneyAttemptStore();
