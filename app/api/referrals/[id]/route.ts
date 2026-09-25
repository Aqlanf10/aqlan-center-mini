import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { closeReferral, getReferral } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { checkReferralClose } from "@/lib/referrals";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P3-8) إغلاق الإحالة: «اكتملت» بنتيجتها أو «أُلغيت» بسببٍ مكتوب. مرةً واحدة —
 * المغلقة لا تُعاد فتحها ولا تُغلق ثانية (409).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ message: "رقم إحالة غير صالح." }, { status: 400 });

  let body: Record<string, unknown>;
  try { body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const close = checkReferralClose(body ?? {});
  if (!close.ok) return NextResponse.json({ message: close.message }, { status: 400 });

  try {
    const existing = await getReferral(id);
    if (!existing) return NextResponse.json({ message: "لا توجد إحالة بهذا الرقم." }, { status: 404 });
    if (!(await canAccessPatient(session, existing.patientId).catch(() => false))) {
      return NextResponse.json({ message: "غير مصرّح لك بملف هذا المريض." }, { status: 403 });
    }
    const result = await closeReferral({
      id, status: close.value.status, note: close.value.note, actor: session.username, actorRole: session.role,
    });
    if (!result.ok) {
      return result.reason === "not_found"
        ? NextResponse.json({ message: "لا توجد إحالة بهذا الرقم." }, { status: 404 })
        : NextResponse.json({ message: "هذه الإحالة أُغلقت من قبل." }, { status: 409 });
    }
    return NextResponse.json(result.referral);
  } catch {
    return NextResponse.json({ message: "تعذّر تحديث الإحالة. أعد المحاولة." }, { status: 500 });
  }
}
