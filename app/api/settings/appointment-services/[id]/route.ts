import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getAppointmentService, updateAppointmentService } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { readServiceInput } from "@/lib/appointment-service-input";

export const dynamic = "force-dynamic";

/**
 * تعديل خدمة — والرمز لا يُغيَّر أبدًا.
 *
 * الرمز هوية: تُشير إليه المواعيد المحجوزة والتكاملات والقواعد. والاسم العربي
 * يُحرَّر بحرّية لأنه عرضٌ لا هوية — وهذا بالضبط سبب ألّا يكون الاسم هو المفتاح.
 *
 * ولا حذف صلبًا: خدمةٌ حُجزت بها مواعيد إن مُحيت صار تاريخُ المركز يشير إلى
 * لا شيء. التعطيل يمنع الحجز الجديد ويُبقي القديم مقروءًا.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة خدمات المواعيد للمدير وحده." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الخدمة غير صالح." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  try {
    const current = await getAppointmentService(id);
    if (!current) {
      return NextResponse.json({ message: "الخدمة غير موجودة." }, { status: 404 });
    }
    /* تعديلٌ جزئيّ على ما هو قائم: الشاشة قد ترسل حقلًا واحدًا (تعطيل مثلًا)،
       فالحقول الغائبة تبقى كما هي ولا تُصفَّر بصمت. */
    const parsed = readServiceInput(body, current);
    if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });

    const result = await updateAppointmentService(id, parsed.input, {
      actor: session.username, actorRole: session.role,
    });
    return result.ok
      ? NextResponse.json(result.service)
      : NextResponse.json({ message: result.message }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الخدمة. أعد المحاولة." }, { status: 500 });
  }
}
