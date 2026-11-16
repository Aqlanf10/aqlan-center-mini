import type { CaseParticipant } from "./commission";
import { CASE_PARTICIPATION_SOURCES, type CaseParticipationSource, type CaseParticipationStatus } from "./commission-participation-db";

/** The request body of a case participation decision. Shares arrive as whole basis points
 * (100% = 10,000): no percentage text is parsed and nothing is rounded on the way in. */
export interface CaseParticipationRequest {
  caseId: number; status: CaseParticipationStatus; participants: CaseParticipant[];
  source: CaseParticipationSource; reason: string; expectedHeadId: number | null;
}
const KEYS = ["caseId", "status", "participants", "source", "reason", "expectedHeadId"];
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseCaseParticipationRequest(body: unknown): { ok: true; value: CaseParticipationRequest } | { ok: false; message: string } {
  const invalid = (message: string) => ({ ok: false as const, message });
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("طلب غير صالح.");
  const source = body as Record<string, unknown>;
  if (Object.keys(source).some(key => !KEYS.includes(key))) return invalid("طلب غير صالح: حقل غير معروف.");
  if (!positive(source.caseId)) return invalid("رقم الحالة غير صالح.");
  if (source.status !== "approved" && source.status !== "pending" && source.status !== "void") return invalid("حدّد القرار: اعتماد التوزيع، أو تعليقه للمراجعة، أو إلغاء المشاركة.");
  if (typeof source.source !== "string" || !CASE_PARTICIPATION_SOURCES.includes(source.source as CaseParticipationSource)) {
    return invalid("حدّد مصدر قرار التوزيع: قرار المركز، أو استرشاد بعدد الجلسات، أو تقسيم متساوٍ.");
  }
  if (typeof source.reason !== "string" || source.reason.trim().length < 3) return invalid("اكتب سبب قرار توزيع المشاركة.");
  if (source.expectedHeadId !== null && !positive(source.expectedHeadId)) return invalid("أعد تحميل قرار المشاركة الحالي قبل تغييره.");
  const raw = source.participants === undefined ? [] : source.participants;
  if (!Array.isArray(raw) || raw.length > 12) return invalid("قائمة المشاركين غير صالحة.");
  const participants: CaseParticipant[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid("قائمة المشاركين غير صالحة.");
    const part = entry as Record<string, unknown>;
    if (Object.keys(part).sort().join(",") !== "doctorId,shareBp" || !positive(part.doctorId) || !positive(part.shareBp)) {
      return invalid("كل مشارك يحتاج طبيبًا ونسبة صحيحة موجبة بنقاط الأساس (100٪ = 10000).");
    }
    participants.push({ doctorId: part.doctorId, shareBp: part.shareBp });
  }
  return { ok: true, value: { caseId: source.caseId, status: source.status, participants, source: source.source as CaseParticipationSource,
    reason: source.reason.trim().slice(0, 500), expectedHeadId: source.expectedHeadId as number | null } };
}
