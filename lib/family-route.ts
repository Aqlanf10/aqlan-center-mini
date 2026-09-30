import { NextResponse } from "next/server";
import type { FamilyWriteFailure, PatientFamilyRecord } from "@/lib/db";
import { canEditFamilies, familyViewOf } from "@/lib/family-view";
import { json } from "@/lib/case-route";
import { requireSession } from "@/lib/session";

/**
 * (PAT-4) حارس مسارات العائلات: الكتابة للمدير والاستقبال وحدهما، وكل رفضٍ برسالة عربية بلا
 * تفاصيل داخلية. الكاشير والمحاسب خارج هذه المسارات أصلًا (قائمة السماح عند الباب) — يطبعان
 * كشف العائلة المالي فقط.
 */
type Session = NonNullable<Awaited<ReturnType<typeof requireSession>>>;

export async function familyWriter(): Promise<{ ok: true; session: Session } | { ok: false; response: NextResponse }> {
  const session = await requireSession();
  if (!session) return { ok: false, response: json("انتهت الجلسة. سجّل الدخول من جديد.", 401) };
  if (!canEditFamilies(session.role)) {
    return { ok: false, response: json("ربط العائلات وضامنها للاستقبال والإدارة.", 403) };
  }
  return { ok: true, session };
}

const FAILURES: Record<FamilyWriteFailure, [string, number]> = {
  family_not_found: ["لا توجد عائلة بهذا الرقم.", 404],
  patient_not_found: ["لا يوجد مريض بهذا الرقم.", 404],
  guarantor_not_found: ["المريض الضامن غير موجود.", 404],
  already_in_family: ["هذا المريض مربوطٌ بعائلةٍ أخرى — افكك ربطه منها أولًا.", 409],
  not_member: ["هذا المريض ليس من أفراد هذه العائلة.", 404],
};

export function familyFailure(reason: FamilyWriteFailure): NextResponse {
  const [message, status] = FAILURES[reason];
  return json(message, status);
}

/** بعد الكتابة: العائلة كما يراها الكاتب (المدير/الاستقبال يرون كل شيء). */
export async function familyResponse(session: Session, record: PatientFamilyRecord, status = 200): Promise<NextResponse> {
  const view = await familyViewOf(session, record);
  if (!view.ok) return json("تعذّر عرض العائلة.", 500);
  return NextResponse.json(view.view, { status });
}
