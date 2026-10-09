import { isCurrency, type Currency } from "./money";

/** Display-only evidence. Never feeds balances, posting, permissions or writers. */
export interface ReceiptReference { id: number; receiptNumber: string }
export interface ReceiptProvenance {
  status: "available" | "unavailable";
  reversal: null | {
    state: "none" | "partial" | "full" | "unverified";
    reversedMinor: number | null;
    remainingMinor: number | null;
  };
  reversalOf: ReceiptReference | null;
  correction: null | { mode: "correct" | "void"; reversal: ReceiptReference; replacement: ReceiptReference | null };
  correctionReversal: null | { mode: "correct" | "void"; original: ReceiptReference };
  replacementOf: ReceiptReference | null;
  correctionUnverified: boolean;
}

/** Raw database values stay unknown until checked; no JSON casts in the query. */
export interface ReceiptProvenancePayment {
  id: unknown; receiptNumber: unknown; patientId: unknown; kind: unknown;
  amountMinor: unknown; currency: unknown; reversalOfId: unknown;
  createdBy: unknown; createdAt: unknown;
}
export interface ReceiptProvenanceAudit {
  id: unknown; action: unknown; entity: unknown; entityId: unknown;
  details: unknown; actor: unknown; createdAt: unknown;
}

type Payment = ReceiptReference & {
  patientId: number; kind: "payment" | "refund"; amountMinor: number; currency: Currency;
  reversalOfId: number | null; createdBy: string | null; createdAt: string;
};
type Correction = { original: Payment; reversal: Payment; replacement: Payment | null; mode: "correct" | "void" };

export function receiptId(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9]\d*$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
}
function minor(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9]\d*$/.test(value))) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
function receiptNumber(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function auditId(value: unknown): boolean {
  // BIGSERIAL audit IDs need not fit a JavaScript number; never round them.
  return typeof value === "string" ? /^[1-9]\d{0,18}$/.test(value)
    && (value.length < 19 || value <= "9223372036854775807")
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function payment(row: ReceiptProvenancePayment): Payment | null {
  const id = receiptId(row.id), patientId = receiptId(row.patientId), amountMinor = minor(row.amountMinor);
  const reversalOfId = row.reversalOfId === null ? null : receiptId(row.reversalOfId);
  if (id === null || patientId === null || amountMinor === null || !receiptNumber(row.receiptNumber)
    || !isCurrency(row.currency) || (row.kind !== "payment" && row.kind !== "refund")
    || (row.reversalOfId !== null && reversalOfId === null)
    || (row.createdBy !== null && typeof row.createdBy !== "string") || !timestamp(row.createdAt)) return null;
  return { id, patientId, amountMinor, receiptNumber: row.receiptNumber, currency: row.currency,
    kind: row.kind, reversalOfId, createdBy: row.createdBy, createdAt: row.createdAt };
}
function ref(row: Payment): ReceiptReference { return { id: row.id, receiptNumber: row.receiptNumber }; }
export function unavailableReceiptProvenance(): ReceiptProvenance {
  return { status: "unavailable", reversal: null, reversalOf: null, correction: null,
    correctionReversal: null, replacementOf: null, correctionUnverified: true };
}

/**
 * A reversal link proves an accounting reversal, not its business purpose or an
 * actual movement of cash. Only the exact structured, atomic correction audit
 * identifies correction/void/replacement. Notes and summaries are never read.
 * Separate incoming/outgoing fields preserve replacement chains without recursion.
 */
export function projectReceiptProvenance(
  requestedIds: readonly number[], rawPayments: readonly ReceiptProvenancePayment[], rawAudits: readonly ReceiptProvenanceAudit[],
  completeness: { payments: boolean; audits: boolean } = { payments: true, audits: true },
): Record<string, ReceiptProvenance> {
  const requested = [...new Set(requestedIds.filter((id) => receiptId(id) !== null))];
  const result = Object.fromEntries(requested.map((id) => [id, unavailableReceiptProvenance()]));
  if (!completeness.payments) return result;

  const byId = new Map<number, Payment>();
  const byNumber = new Map<string, Payment>();
  const badIds = new Set<number>(), badNumbers = new Set<string>(), badOrigins = new Set<number>();
  for (const row of rawPayments) {
    const parsed = payment(row);
    if (!parsed) {
      const id = receiptId(row.id), origin = receiptId(row.reversalOfId);
      if (id !== null) badIds.add(id);
      if (origin !== null) badOrigins.add(origin);
      if (receiptNumber(row.receiptNumber)) badNumbers.add(row.receiptNumber);
      continue;
    }
    const duplicate = byId.get(parsed.id);
    if (duplicate) {
      badIds.add(parsed.id);
      if (duplicate.reversalOfId !== null) badOrigins.add(duplicate.reversalOfId);
      if (parsed.reversalOfId !== null) badOrigins.add(parsed.reversalOfId);
    }
    if (byNumber.has(parsed.receiptNumber)) badNumbers.add(parsed.receiptNumber);
    byId.set(parsed.id, parsed); byNumber.set(parsed.receiptNumber, parsed);
  }
  const usable = (row: Payment | undefined): row is Payment => Boolean(row && !badIds.has(row.id) && !badNumbers.has(row.receiptNumber));
  const reversals = new Map<number, Payment[]>();
  for (const row of byId.values()) {
    if (row.reversalOfId === null) continue;
    const rows = reversals.get(row.reversalOfId) ?? [];
    rows.push(row); reversals.set(row.reversalOfId, rows);
  }
  const summary = new Map<number, NonNullable<ReceiptProvenance["reversal"]>>();
  for (const row of byId.values()) {
    if (row.kind !== "payment") continue;
    let sum = 0;
    let valid = usable(row) && row.reversalOfId === null && !badOrigins.has(row.id);
    for (const reversal of reversals.get(row.id) ?? []) {
      if (!usable(reversal) || reversal.kind !== "refund" || reversal.patientId !== row.patientId
        || reversal.currency !== row.currency || reversal.id === row.id) valid = false;
      sum += reversal.amountMinor;
      if (!Number.isSafeInteger(sum) || sum > row.amountMinor) valid = false;
    }
    summary.set(row.id, valid ? { state: sum === 0 ? "none" : sum === row.amountMinor ? "full" : "partial",
      reversedMinor: sum, remainingMinor: row.amountMinor - sum }
      : { state: "unverified", reversedMinor: null, remainingMinor: null });
  }
  for (const id of requested) {
    const row = byId.get(id);
    if (!usable(row)) continue;
    const origin = row.reversalOfId === null ? undefined : byId.get(row.reversalOfId);
    const validOrigin = row.kind === "refund" && usable(origin) && origin.kind === "payment"
      && row.patientId === origin.patientId && row.currency === origin.currency && row.id !== origin.id
      && summary.get(origin.id)?.state !== "unverified";
    result[id] = { status: "available", reversal: row.kind === "payment" ? summary.get(id)! : null,
      reversalOf: validOrigin ? ref(origin) : null, correction: null, correctionReversal: null, replacementOf: null,
      correctionUnverified: !completeness.audits };
  }
  if (!completeness.audits) return result;

  const audits = rawAudits.filter((audit) => audit.action === "payment.correct" && audit.entity === "payment");
  const originalClaims = new Map<number, number>(), referenceClaims = new Map<string, number>();
  for (const audit of audits) {
    const id = receiptId(audit.entityId);
    if (id !== null) originalClaims.set(id, (originalClaims.get(id) ?? 0) + 1);
    if (!object(audit.details)) continue;
    for (const value of [audit.details["سند_العكس"], audit.details["السند_الصحيح"]]) {
      if (receiptNumber(value)) referenceClaims.set(value, (referenceClaims.get(value) ?? 0) + 1);
    }
  }
  const markUnverified = (audit: ReceiptProvenanceAudit) => {
    const originalId = receiptId(audit.entityId), original = originalId === null ? undefined : byId.get(originalId);
    if (originalId !== null && result[originalId]) result[originalId].correctionUnverified = true;
    if (!usable(original) || !object(audit.details)) return;
    for (const value of [audit.details["سند_العكس"], audit.details["السند_الصحيح"]]) {
      const related = typeof value === "string" ? byNumber.get(value) : undefined;
      if (usable(related) && related.patientId === original.patientId && result[related.id]) result[related.id].correctionUnverified = true;
    }
  };
  const validate = (audit: ReceiptProvenanceAudit): Correction | null => {
    const originalId = receiptId(audit.entityId);
    const original = originalId === null ? undefined : byId.get(originalId);
    const d = audit.details;
    if (originalId === null || originalClaims.get(originalId) !== 1 || !usable(original)
      || original.kind !== "payment" || original.reversalOfId !== null || summary.get(original.id)?.state !== "full"
      || !object(d) || !auditId(audit.id) || typeof audit.actor !== "string" || !audit.actor || !timestamp(audit.createdAt)
      || typeof d["المريض"] !== "number" || receiptId(d["المريض"]) !== original.patientId
      || typeof d["السبب"] !== "string" || d["السبب"].trim().length < 3
      || (d["السبب"].length > 300 && !(d["السبب"].length === 301 && d["السبب"].endsWith("…")))) return null;
    const mode = d["الطريقة"] === "تصحيح" ? "correct" : d["الطريقة"] === "إبطال" ? "void" : null;
    if (mode === null || !receiptNumber(d["سند_العكس"]) || referenceClaims.get(d["سند_العكس"]) !== 1) return null;
    const reversal = byNumber.get(d["سند_العكس"]);
    if (!usable(reversal) || reversal.kind !== "refund" || reversal.reversalOfId !== original.id
      || reversal.id === original.id || reversal.patientId !== original.patientId || reversal.currency !== original.currency
      || typeof d["المبلغ_المعكوس"] !== "number" || minor(d["المبلغ_المعكوس"]) !== reversal.amountMinor
      || d["العملة_المعكوسة"] !== reversal.currency || reversal.createdBy !== audit.actor
      || reversal.createdAt !== audit.createdAt) return null;
    if (mode === "void") {
      if (d["السند_الصحيح"] !== null || d["المبلغ_الصحيح"] !== null || d["العملة_الصحيحة"] !== null) return null;
      return { original, reversal, replacement: null, mode };
    }
    if (!receiptNumber(d["السند_الصحيح"]) || referenceClaims.get(d["السند_الصحيح"]) !== 1) return null;
    const replacement = byNumber.get(d["السند_الصحيح"]);
    if (!usable(replacement) || replacement.kind !== "payment" || replacement.reversalOfId !== null
      || replacement.patientId !== original.patientId || replacement.id === original.id || replacement.id === reversal.id
      || typeof d["المبلغ_الصحيح"] !== "number" || minor(d["المبلغ_الصحيح"]) !== replacement.amountMinor
      || d["العملة_الصحيحة"] !== replacement.currency || replacement.createdBy !== audit.actor
      || replacement.createdAt !== audit.createdAt) return null;
    return { original, reversal, replacement, mode };
  };
  const candidates = audits.map((audit) => ({ audit, correction: validate(audit) }));
  const successors = new Map(candidates.flatMap(({ correction }) => correction?.replacement
    ? [[correction.original.id, correction.replacement.id] as const] : []));
  const cyclic = new Set<number>();
  const visited = new Set<number>();
  for (const start of successors.keys()) {
    const trail: number[] = [], position = new Map<number, number>();
    let current: number | undefined = start;
    while (current !== undefined && !visited.has(current)) {
      const repeated = position.get(current);
      if (repeated !== undefined) {
        for (const id of trail.slice(repeated)) cyclic.add(id);
        break;
      }
      position.set(current, trail.length); trail.push(current); current = successors.get(current);
    }
    for (const id of trail) visited.add(id);
  }
  for (const { audit, correction: validated } of candidates) {
    if (!validated || cyclic.has(validated.original.id)) { markUnverified(audit); continue; }
    const { original, reversal, replacement, mode } = validated;
    if (result[original.id]) result[original.id].correction = { mode, reversal: ref(reversal), replacement: replacement ? ref(replacement) : null };
    if (result[reversal.id]) result[reversal.id].correctionReversal = { mode, original: ref(original) };
    if (replacement && result[replacement.id]) result[replacement.id].replacementOf = ref(original);
  }
  return result;
}

/** Wording describes recorded evidence; never asserts whether cash physically moved. */
export function receiptDocumentTitle(kind: "payment" | "refund", provenance?: ReceiptProvenance): string {
  if (kind === "payment") return "سند قبض";
  if (provenance?.correctionReversal?.mode === "void") return "قيد إبطال سند";
  if (provenance?.correctionReversal?.mode === "correct") return "قيد عكس لتصحيح سند";
  return provenance?.reversalOf ? "سند عكس مرتبط" : "سند عكس";
}

/** Validate the optional wire field independently; malformed evidence is never
 * promoted to ordinary/unreversed and cannot make the whole ledger fail. */
export function receiptProvenanceFor(
  evidence: unknown, paymentId: number, faceAmountMinor: number, kind: "payment" | "refund", ownReceiptNumber?: string,
): ReceiptProvenance | undefined {
  if (evidence === undefined) return undefined; // Compatibility with an older server.
  if (!object(evidence) || !Object.prototype.hasOwnProperty.call(evidence, paymentId)) return unavailableReceiptProvenance();
  const value = evidence[paymentId];
  if (!object(value) || (value.status !== "available" && value.status !== "unavailable")
    || typeof value.correctionUnverified !== "boolean") return unavailableReceiptProvenance();
  const validReference = (input: unknown): input is ReceiptReference => object(input)
    && typeof input.id === "number" && receiptId(input.id) !== null && receiptNumber(input.receiptNumber);
  const nullableReference = (input: unknown) => input === null || validReference(input);
  const mode = (input: unknown) => input === "correct" || input === "void";
  if (!nullableReference(value.reversalOf) || !nullableReference(value.replacementOf)) return unavailableReceiptProvenance();
  const outgoing = value.correction;
  if (outgoing !== null && (!object(outgoing) || !mode(outgoing.mode) || !validReference(outgoing.reversal)
    || !nullableReference(outgoing.replacement) || (outgoing.mode === "void" ? outgoing.replacement !== null : outgoing.replacement === null))) {
    return unavailableReceiptProvenance();
  }
  const incoming = value.correctionReversal;
  if (incoming !== null && (!object(incoming) || !mode(incoming.mode) || !validReference(incoming.original))) return unavailableReceiptProvenance();
  const reversal = value.reversal;
  if (reversal !== null) {
    if (!object(reversal)) return unavailableReceiptProvenance();
    if (reversal.state === "unverified") {
      if (reversal.reversedMinor !== null || reversal.remainingMinor !== null) return unavailableReceiptProvenance();
    } else {
      if (!["none", "partial", "full"].includes(String(reversal.state))
        || typeof reversal.reversedMinor !== "number" || !Number.isSafeInteger(reversal.reversedMinor) || reversal.reversedMinor < 0
        || typeof reversal.remainingMinor !== "number" || !Number.isSafeInteger(reversal.remainingMinor) || reversal.remainingMinor < 0
        || !Number.isSafeInteger(reversal.reversedMinor + reversal.remainingMinor)
        || reversal.reversedMinor + reversal.remainingMinor !== faceAmountMinor
        || (reversal.state === "none" && (reversal.reversedMinor !== 0 || reversal.remainingMinor <= 0))
        || (reversal.state === "partial" && (reversal.reversedMinor <= 0 || reversal.remainingMinor <= 0))
        || (reversal.state === "full" && (reversal.reversedMinor <= 0 || reversal.remainingMinor !== 0))) return unavailableReceiptProvenance();
    }
  }
  if (value.status === "unavailable") return unavailableReceiptProvenance();
  if ((kind === "payment" && (reversal === null || value.reversalOf !== null || incoming !== null))
    || (kind === "refund" && (reversal !== null || outgoing !== null || value.replacementOf !== null))
    || (kind !== "payment" && kind !== "refund")) return unavailableReceiptProvenance();
  const references = [value.reversalOf, value.replacementOf,
    ...(object(outgoing) ? [outgoing.reversal, outgoing.replacement] : []),
    ...(object(incoming) ? [incoming.original] : [])];
  const sameReference = (left: unknown, right: unknown) => validReference(left) && validReference(right)
    && (left.id === right.id || left.receiptNumber === right.receiptNumber);
  if (references.some((reference) => validReference(reference)
      && (reference.id === paymentId || reference.receiptNumber === ownReceiptNumber))
    || (object(outgoing) && (sameReference(value.replacementOf, outgoing.reversal) || sameReference(value.replacementOf, outgoing.replacement)))
    || (object(outgoing) && validReference(outgoing.replacement) && validReference(outgoing.reversal)
      && (outgoing.replacement.id === outgoing.reversal.id || outgoing.replacement.receiptNumber === outgoing.reversal.receiptNumber))
    || (reversal !== null && value.reversalOf !== null)
    || (value.replacementOf !== null && reversal === null)
    || (incoming !== null && (outgoing !== null || value.replacementOf !== null))) return unavailableReceiptProvenance();
  if ((outgoing !== null && (!object(reversal) || reversal.state !== "full"))
    || (incoming !== null && (reversal !== null || !validReference(value.reversalOf)
      || value.reversalOf.id !== (incoming as { original: ReceiptReference }).original.id
      || value.reversalOf.receiptNumber !== (incoming as { original: ReceiptReference }).original.receiptNumber))) return unavailableReceiptProvenance();
  return value as unknown as ReceiptProvenance;
}
