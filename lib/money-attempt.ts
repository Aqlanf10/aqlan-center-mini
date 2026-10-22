import { newIdempotencyKey } from "./idempotency-key";
import {readSplitCollectionEvidence,type SplitCollectionEvidence} from "./agreement-split-collection";
import {formatSimilarCollectionReviewHeader,readSimilarCollectionRefusal,SIMILAR_COLLECTION_REVIEW_HEADER,type SimilarCollectionReceipt,type SimilarCollectionReview} from "./similar-collection";

export const MONEY_UNCERTAIN = "تعذّر تأكيد نتيجة العملية. قد تكون سُجّلت ماليًا. أعد التحقق بنفس الطلب قبل تسجيل عملية أخرى.";
/** A later refusal is diagnostic, never proof that the first write failed. */
export function moneyRecoveryFailure(status: number, message: unknown): string {
  return status >= 400 && status < 500 && typeof message === "string" && message.trim()
    ? `تعذّرت المحاولة الحالية: ${message.trim()}\n${MONEY_UNCERTAIN}`
    : MONEY_UNCERTAIN;
}
export type MoneyRequest = Readonly<{
  url: string;
  body: string;
  operation: "payment" | "installment" | "correct" | "void";
}>;
type Receipt = { id: number; receiptNumber: string };
export type MoneyAcknowledgment = { paymentId: number | null; reversal?: Receipt; replacement?: Receipt | null;
  paymentIds?:number[];collection?:SplitCollectionEvidence };
/**
 * "review": the server proved it wrote nothing and reported similar receipts (advisory).
 * `proven` = no earlier send with this key can still be in flight (every send of this key got
 * a definitive answer), so cancelling may retire the attempt; otherwise it stays uncertain.
 */
export type MoneyAttempt = Readonly<{
  request: MoneyRequest;
  key: string;
  phase: "sending" | "uncertain" | "confirmed" | "review";
  acknowledgment?: MoneyAcknowledgment;
  similar?: Readonly<{ receipts: SimilarCollectionReceipt[]; proven: boolean }>;
}>;
export type MoneyResult = { kind: "confirmed"; attempt: MoneyAttempt; acknowledgment: MoneyAcknowledgment }
  | { kind: "refused" | "uncertain" | "blocked"; message: string }
  | { kind: "similar"; receipts: SimilarCollectionReceipt[] }
  | { kind: "busy" };
type Result = MoneyResult;

/** Collections whose keys the server can prove (0068). Receipt corrections keep their own evidence path. */
export const RECONCILABLE_OPERATIONS: ReadonlySet<MoneyRequest["operation"]> = new Set(["payment", "installment"]);
export const MONEY_RETIRED = "ثبت من الخادم أن المحاولة السابقة لم تُحفظ ولن تُحفظ، فأُلغيت. يمكنك تصحيح الطلب وتسجيله من جديد.";
/**
 * Ask the server to prove a collection key's outcome. "retired": nothing was recorded and nothing
 * can be recorded under this key any more. "committed": a receipt exists; replay the same request.
 * null: not proven (network, permission, malformed answer) — keep the attempt.
 */
export async function retireMoneyAttempt(transport: typeof fetch, request: MoneyRequest, key: string): Promise<"retired" | "committed" | null> {
  try {
    // The retirement is bound to the patient of the saved request itself, never to the current screen.
    const patientId = object(JSON.parse(request.body))?.patientId;
    if (!id(patientId)) return null;
    const response = await transport("/api/payments/attempts/retire", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: key, patientId }) });
    if (!response.ok || response.redirected) return null;
    const state = object(await response.json())?.state;
    return state === "retired" || state === "committed" ? state : null;
  } catch { return null; }
}

/** Headers for a send; the review never enters the body, so the request/fingerprint stays identical. */
export function moneyHeaders(key: string, review?: SimilarCollectionReview): Record<string, string> {
  return { "Content-Type": "application/json", "Idempotency-Key": key,
    ...(review ? { [SIMILAR_COLLECTION_REVIEW_HEADER]: formatSimilarCollectionReviewHeader(review) } : {}) };
}
/** A 409 that proves an advisory review is needed for THIS send (nothing was written). */
export function similarReview(previous: MoneyAttempt | null, status: number, payload: unknown): MoneyAttempt["similar"] | null {
  const receipts = status === 409 ? readSimilarCollectionRefusal(payload) : null;
  if (!receipts) return null;
  return { receipts, proven: previous === null || (previous.phase === "review" && previous.similar?.proven === true) };
}

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
    if(operation==="payment"&&Object.hasOwn(row,"collection")){
      const split=readSplitCollectionEvidence(row);
      return split?{paymentId:split.paymentIds[0],paymentIds:split.paymentIds,collection:split}:null;
    }
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
  /** Operator cancelled a similar-receipt review. Retire only when no send of this key can still land. */
  dismiss(scope: string): "retired" | "kept" | null {
    const current = this.get(scope);
    if (!current || current.phase !== "review") return null;
    if (current.similar?.proven) { this.publish(scope, null); return "retired"; }
    this.publish(scope, { request: current.request, key: current.key, phase: "uncertain" });
    return "kept";
  }
  /** Prove an uncertain collection's outcome: retire it only on server proof, replay it if it committed. */
  async reconcile(scope: string): Promise<Result | { kind: "retired" }> {
    const current = this.get(scope);
    if (!current || current.phase !== "uncertain" || !RECONCILABLE_OPERATIONS.has(current.request.operation)) return { kind: "busy" };
    this.publish(scope, { ...current, phase: "sending" }); // no concurrent resend while proving
    const state = await retireMoneyAttempt(this.transport, current.request, current.key);
    if (state === "retired") { this.publish(scope, null); return { kind: "retired" }; }
    this.publish(scope, { ...current, phase: "uncertain" });
    if (state === "committed") return this.run(scope);
    return { kind: "uncertain", message: MONEY_UNCERTAIN };
  }
  async run(scope: string, request?: MoneyRequest, review?: SimilarCollectionReview): Promise<Result> {
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
      ? { request: previous.request, key: previous.key, phase: "sending" }
      : { request: { ...request! }, key: this.key(), phase: "sending" };
    this.publish(scope, attempt); // synchronous lock, before fetch/React renders
    let failure = MONEY_UNCERTAIN;
    try {
      const response = await this.transport(attempt.request.url, {
        method: "POST",
        headers: moneyHeaders(attempt.key, review),
        body: attempt.request.body,
      });
      const payload: unknown = await response.json(); // malformed JSON is never a refusal/ack
      const acknowledgment = response.ok ? moneyAcknowledgment(attempt.request.operation, payload) : null;
      if (acknowledgment) {
        const confirmed: MoneyAttempt = { ...attempt, phase: "confirmed", acknowledgment };
        this.publish(scope, confirmed);
        return { kind: "confirmed", attempt: confirmed, acknowledgment };
      }
      const similar = response.redirected ? null : similarReview(previous, response.status, payload);
      if (similar) {
        this.publish(scope, { ...attempt, phase: "review", similar });
        return { kind: "similar", receipts: similar.receipts };
      }
      const message = object(payload)?.message;
      if (!response.redirected) failure = moneyRecoveryFailure(response.status, message);
      // These routes return their explicit pre-commit refusals as 4xx. Once a
      // reply was lost, even a later permission/shift/target refusal cannot clear it.
      if (!previous && [400, 404, 422].includes(response.status) && typeof message === "string" && message.trim()) {
        this.publish(scope, null);
        return { kind: "refused", message };
      }
      // An ordinary 409 refusal of a first send is retired only on server proof that the key
      // never committed and never can; otherwise it stays uncertain below.
      if (!previous && !response.redirected && response.status === 409 && RECONCILABLE_OPERATIONS.has(attempt.request.operation)
        && typeof message === "string" && message.trim() && await retireMoneyAttempt(this.transport, attempt.request, attempt.key) === "retired") {
        this.publish(scope, null);
        return { kind: "refused", message };
      }
    } catch {
      // The server may have committed. Never rotate the key here.
    }
    this.publish(scope, { ...attempt, phase: "uncertain" });
    return { kind: "uncertain", message: failure };
  }
}

export const moneyAttempts = new MoneyAttemptStore();
