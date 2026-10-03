import { checkPerioDraft, summarizePerio, type PerioDraft } from "@/lib/periodontics";
import type { PerioExamView } from "@/lib/periodontics-db";

export class PerioApiError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly code: string | null = null) { super(message); }
  get uncertain() { return this.status === null || this.status >= 500; }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableText = (value: unknown) => value === null || typeof value === "string";
/** Never display malformed, cross-patient or mixed revision snapshots as saved. */
export function readExam(value: unknown, patientId: number): PerioExamView {
  if (!record(value)) throw new PerioApiError("استجابة الفحص غير صالحة. أعد تحميل السجل.", null);
  const draft = checkPerioDraft(value);
  if (!draft.ok || !positive(value.id) || !positive(value.visitId) || value.patientId !== patientId || !positive(value.revision)
    || typeof value.doctorName !== "string" || !nullableText(value.caseTitle) || typeof value.recordedBy !== "string"
    || typeof value.recordedAt !== "string" || !nullableText(value.updatedAt) || !nullableText(value.updatedBy)
    || !nullableText(value.signedAt) || !nullableText(value.signedBy) || !Array.isArray(value.addenda)
    || value.addenda.some((item) => !record(item) || !positive(item.id) || typeof item.body !== "string" || typeof item.author !== "string" || typeof item.createdAt !== "string")) {
    throw new PerioApiError("استجابة الفحص غير متطابقة مع ملف المريض. أعد تحميل السجل.", null);
  }
  return { ...(value as unknown as PerioExamView), ...draft.value, summary: summarizePerio(draft.value.sites) };
}
export interface PerioWorkspaceApi {
  list(patientId: number, signal: AbortSignal): Promise<PerioExamView[]>;
  save(patientId: number, visitId: number, body: PerioDraft & { expectedRevision: number | null }, signal: AbortSignal): Promise<PerioExamView>;
  addendum(patientId: number, examId: number, body: { text: string; requestKey: string }, signal: AbortSignal): Promise<PerioExamView>;
}
async function request(url: string, signal: AbortSignal, method = "GET", body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method, signal, cache: "no-store", credentials: "same-origin",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PerioApiError("تعذّر التأكد من النتيجة عبر الاتصال. سيُعاد تحميل السجل قبل إعادة المحاولة.", null);
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new PerioApiError(record(json) && typeof json.message === "string" ? json.message : "تعذّر إتمام الطلب.", response.status,
    record(json) && typeof json.code === "string" ? json.code : null);
  if (!record(json)) throw new PerioApiError("استجابة غير مكتملة. أعد تحميل السجل قبل إعادة المحاولة.", null);
  return json;
}
export const perioWorkspaceApi: PerioWorkspaceApi = {
  async list(patientId, signal) {
    const data = await request(`/api/patients/${patientId}/perio`, signal);
    if (!record(data) || !Array.isArray(data.exams)) throw new PerioApiError("تعذّر قراءة سجل الفحوص.", null);
    const exams = data.exams.map((item) => readExam(item, patientId));
    if (new Set(exams.map((exam) => exam.visitId)).size !== exams.length) throw new PerioApiError("سجل الفحوص غير متسق.", null);
    return exams;
  },
  async save(patientId, visitId, body, signal) {
    const data = await request(`/api/patients/${patientId}/perio/visits/${visitId}`, signal, "PUT", body);
    const exam = readExam(record(data) ? data.exam : null, patientId);
    if (exam.visitId !== visitId) throw new PerioApiError("الاستجابة لا تخص الزيارة الحالية.", null);
    return exam;
  },
  async addendum(patientId, examId, body, signal) {
    const data = await request(`/api/patients/${patientId}/perio/exams/${examId}/addenda`, signal, "POST", body);
    const exam = readExam(record(data) ? data.exam : null, patientId);
    if (exam.id !== examId) throw new PerioApiError("الاستجابة لا تخص الفحص المحدد.", null);
    return exam;
  },
};
