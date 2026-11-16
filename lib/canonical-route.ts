import "server-only";
import { NextResponse } from "next/server";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import { staffAdmissionRefusal } from "./staff-capability-editor";

/**
 * مدخل مسارات الهوية الموحّدة: يختار مغلّف الطلب بالقاعدة الواحدة ويعيد مقبض الجلسة
 * الموقّعة، أو ردًّا عربيًا جاهزًا. المقبض ليس قبولًا: كل مسار يقبله بعدها بإثبات
 * قاعدة البيانات الحالي وقدرته الدقيقة داخل معاملته.
 */
export const NO_STORE = { "Cache-Control": "private, no-store" } as const;
export async function canonicalEnvelopeOrResponse(): Promise<VerifiedDurableSession | NextResponse> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "canonical") return selected.handle;
  if (selected.kind === "legacy") {
    return NextResponse.json({ message: "هذه الشاشة متاحة في وضع الهوية الموحّدة فقط." }, { status: 403, headers: NO_STORE });
  }
  return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
}
/** Maps admission/policy refusals to Arabic answers; anything else is a generic 500. */
export function canonicalErrorResponse(error: unknown): NextResponse {
  const refusal = staffAdmissionRefusal(error);
  if (refusal) return NextResponse.json({ message: refusal.message, code: refusal.code }, { status: refusal.status, headers: NO_STORE });
  return NextResponse.json({ message: "تعذّر إتمام العملية. أعد المحاولة." }, { status: 500, headers: NO_STORE });
}
