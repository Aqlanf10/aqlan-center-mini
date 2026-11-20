import { numberingDraft, numberingPreviewProblem } from "./patient-numbering-preview-model";

/** A hosting adapter must obtain this from authenticated server reconciliation.
 * readId identifies a newly completed server read, not a client-made counter.
 * It is a UI freshness gate, never authentication or permission by itself.
 */
export type NumberingReadGate = { state: "unverified" | "unresolved" } | { state: "verified"; readId: string };
export function verifiedReadId(gate?: NumberingReadGate): string | null {
  return gate?.state === "verified" && typeof gate.readId === "string" && gate.readId.trim().length > 0 ? gate.readId : null;
}

/** Proposed injected transport contract, NOT an existing route or authority. */
export interface NumberingSaveDraft { prefix: string; next: string; reason: string }
export interface NumberingSaveTicket extends NumberingSaveDraft {
  preview: string;
  expectedRevision: string;
  /** Issued by the provider, never regenerated for a retry. */
  requestId: string;
  /** Opaque provider-issued binding. The current command service does not implement it. */
  previewToken: string;
}
export type SavePreviewResult = { ok: true; ticket: NumberingSaveTicket } | { ok: false; reason: string };
export type NumberingSaveResult = {
  ok: true; value: { prefix: string; next: string; preview: string; revision: string }; replay: boolean;
} | { ok: false; reason: string };
export interface NumberingSaveOperations {
  preview(input: NumberingSaveDraft): Promise<SavePreviewResult>;
  /** Adapter must validate the token and fresh owner, then execute the command atomically. */
  save(input: NumberingSaveTicket): Promise<NumberingSaveResult>;
}
export const isCommandRevision = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
export function saveDraft(prefix: string, next: string, reason: string): NumberingSaveDraft | null {
  const number = numberingDraft(prefix, next);
  return number && reason.trim() && reason.length <= 500 ? { prefix: number.prefix, next: number.next, reason: reason.trim() } : null;
}
export function readSaveTicket(raw: unknown, draft: NumberingSaveDraft): NumberingSaveTicket | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.prefix !== draft.prefix || r.next !== draft.next || r.reason !== draft.reason
    || r.preview !== numberingDraft(draft.prefix, draft.next)!.preview || !isCommandRevision(r.expectedRevision)
    || typeof r.requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(r.requestId)
    || typeof r.previewToken !== "string" || r.previewToken.length === 0 || r.previewToken.length > 8192) return null;
  // Copy exactly the reviewed fields; never forward arbitrary provider metadata.
  return { ...draft, preview: r.preview as string, expectedRevision: r.expectedRevision,
    requestId: r.requestId, previewToken: r.previewToken };
}
export function readSaveSuccess(raw: unknown, ticket: NumberingSaveTicket): Extract<NumberingSaveResult, { ok: true }> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>, value = r.value as Record<string, unknown> | undefined;
  if (r.ok !== true || typeof r.replay !== "boolean" || !value || typeof value !== "object"
    || value.prefix !== ticket.prefix || value.next !== ticket.next || value.preview !== ticket.preview
    || !isCommandRevision(value.revision)) return null;
  return { ok: true, replay: r.replay, value: { prefix: ticket.prefix, next: ticket.next, preview: ticket.preview, revision: value.revision } };
}
/** Only an initial explicit pre-write refusal is safe to treat as non-application. */
export function isDefiniteSaveRefusal(reason: unknown): reason is string {
  return typeof reason === "string" && ["invalid-input", "owner-required", "owner-numbering-not-activated", "stale-preview",
    "history-unverified", "invalid-snapshot", "would-reuse-or-rewind", "idempotency-conflict", "invalid-preview", "preview-authority-changed", "preview-command-mismatch", "preview-expired", "session-required", "numbering-clock-unavailable"].includes(reason);
}

export function saveProblem(reason: string): string {
  const messages: Record<string, string> = {
    "session-required": "تعذّر التحقق من الجلسة. أعد تسجيل الدخول ومراجعة الحالة قبل طلب جديد.",
    "invalid-preview": "تعذّر التحقق من رمز المعاينة. يلزم فحص جديد بعد مراجعة الحالة.",
    "preview-authority-changed": "تغيّرت صلاحية المالك أو الجلسة بعد المعاينة. راجع الحالة وأعد الفحص.",
    "preview-command-mismatch": "الطلب لا يطابق القيم المعاينة. لا تعِد استخدام هذه المعاينة.",
    "preview-expired": "انتهت صلاحية المعاينة دون نتيجة مؤكدة لهذا الطلب. راجع الحالة قبل معاينة جديدة.",
    "numbering-clock-unavailable": "تعذّر التحقق من وقت صلاحية المعاينة. راجع الحالة قبل إعادة الفحص.",
    "invalid-snapshot": "حالة سلسلة الأرقام غير صالحة للفحص. يلزم التحقق من الخادم.",
  };
  return Object.hasOwn(messages, reason) ? messages[reason] : numberingPreviewProblem(reason);
}
