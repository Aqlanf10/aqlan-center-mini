import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createAppointmentService, getSettings, listAppointmentServices } from "@/lib/db";
import { chairCount } from "@/lib/settings";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { readServiceInput } from "@/lib/appointment-service-input";

export const dynamic = "force-dynamic";

/**
 * كتالوج خدمات المواعيد — سجلّاتٌ يملكها المالك، لا مصفوفةٌ في الشيفرة.
 *
 * القراءة لكل جلسة: الاستقبال تحتاج القائمة لتحجز، والطبيب يراها في جدوله.
 * والكتابة للمدير وحده: مدّةُ الخدمة وفواصلها مدخلاتُ محرّك السعة، فمن يغيّرها
 * يغيّر كم مريضًا يستقبل المركز في اليوم.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  /* المعطَّلة تُطلب صراحةً: شاشة الحجز لا تريدها، وشاشة الإعدادات تريدها —
     فالمعطَّلة لا تُحذف بل تبقى ليقرأ التاريخُ ما حُجز بها. */
  const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "1";
  try {
    /* عدد الكراسي يُعاد مع الخدمات: نموذج الحجز يحتاج الاثنين معًا، وقراءة
       الإعدادات كاملةً تتطلّب صلاحيةً لا يملكها الاستقبال — ولا داعي أن يملكها
       ليعرف كم كرسيًّا في المركز. ولا رقمَ ثابتًا في الشاشة. */
    const [services, settings] = await Promise.all([
      listAppointmentServices({ includeInactive }), getSettings(),
    ]);
    return NextResponse.json({ services, chairs: chairCount(settings) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الخدمات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة خدمات المواعيد للمدير وحده." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const parsed = readServiceInput(body);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });

  try {
    const result = await createAppointmentService(parsed.input, {
      actor: session.username, actorRole: session.role,
    });
    return result.ok
      ? NextResponse.json(result.service, { status: 201 })
      : NextResponse.json({ message: result.message }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الخدمة. أعد المحاولة." }, { status: 500 });
  }
}
