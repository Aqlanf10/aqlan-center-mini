/**
 * (COMM-DETAIL-1 · F-11) التحقق من طلب نسبة خاصة بحالة/خطة — منطقٌ خالص برسائل عربية.
 * لا يُقبل شيءٌ ناقص: الطبيب، وهدفٌ واحد (حالة أو خطة)، والفعل، والنسبة للتعيين،
 * والسبب دائمًا، وتاريخ سريانٍ صحيح إن كُتب.
 */
export interface CaseOverrideRequest {
  doctorId: number;
  caseId: number | null;
  planId: number | null;
  action: "set" | "void";
  percent: number | null;
  reason: string;
  effectiveDate: string | null;
  supersedesId: number | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const positiveInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

export function parseCaseOverrideRequest(raw: unknown):
  { ok: true; value: CaseOverrideRequest } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "طلب غير صالح." };
  const input = raw as Record<string, unknown>;
  const doctorId = positiveInt(input.doctorId);
  if (!doctorId) return { ok: false, message: "اختر الطبيب." };
  const caseId = input.caseId == null ? null : positiveInt(input.caseId);
  const planId = input.planId == null ? null : positiveInt(input.planId);
  if ((input.caseId != null && caseId === null) || (input.planId != null && planId === null)) {
    return { ok: false, message: "رقم الحالة أو الخطة غير صالح." };
  }
  if ((caseId === null) === (planId === null)) return { ok: false, message: "اختر حالةً واحدة أو خطةً واحدة." };
  const action = input.action === "void" ? "void" : input.action === "set" ? "set" : null;
  if (!action) return { ok: false, message: "الفعل غير معروف." };
  let percent: number | null = null;
  if (action === "set") {
    if (typeof input.percent !== "number" || !Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100) {
      return { ok: false, message: "النسبة بين 0 و100." };
    }
    percent = Math.round(input.percent * 100) / 100;
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 3) return { ok: false, message: "اكتب سبب النسبة الخاصة." };
  if (reason.length > 500) return { ok: false, message: "السبب أطول من المسموح (500 حرف)." };
  let effectiveDate: string | null = null;
  if (input.effectiveDate != null && input.effectiveDate !== "") {
    if (typeof input.effectiveDate !== "string" || !DATE_PATTERN.test(input.effectiveDate)
      || Number.isNaN(Date.parse(`${input.effectiveDate}T00:00:00Z`))) {
      return { ok: false, message: "تاريخ السريان غير صالح." };
    }
    effectiveDate = input.effectiveDate;
  }
  const supersedesId = input.supersedesId == null ? null : positiveInt(input.supersedesId);
  if (input.supersedesId != null && supersedesId === null) return { ok: false, message: "مرجع النسبة السابقة غير صالح." };
  if (action === "void" && supersedesId === null) return { ok: false, message: "اختر النسبة الخاصة التي تُلغى." };
  return { ok: true, value: { doctorId, caseId, planId, action, percent, reason, effectiveDate, supersedesId } };
}
