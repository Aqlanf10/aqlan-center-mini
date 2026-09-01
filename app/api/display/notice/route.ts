import { NextResponse } from "next/server";
import { getSettings, recordAudit, saveSettings } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * رسالة الاعتذار عن التأخير — مفتاح بضغطة واحدة للاستقبال.
 *
 * المرضى يصبرون على التأخير أكثر مما يصبرون على تجاهله. الشريط على التلفاز
 * («نعتذر لوجود تأخير بسيط…») يشغّله موظف الاستقبال من لوحة اليوم بضغطة، فلا
 * يحتاج أن يفتح شاشة الإعدادات ولا أن يستأذن المدير — وهو لا يغيّر شيئًا في
 * الإعدادات الحرجة: المفتاح واحد ولا يلمس المال ولا الصلاحيات.
 *
 * لذلك هذا المسار لأي طاقم مسجَّل، بعكس تعديل الإعدادات العام (للمدير وحده).
 */
export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const raw = (body as Record<string, unknown> | null)?.on;
  if (typeof raw !== "boolean") {
    return NextResponse.json({ message: "القيمة المطلوبة: on صحيح أو خطأ." }, { status: 400 });
  }
  try {
    await saveSettings({ "display.delay_notice": raw ? "true" : "false" });
    // القيمة لا اسم الموظف: السجل يفسر «متى شُغّل» لا «من يلوم» — رسالة اعتذار
    // ليست إجراءً يحتاج محاسبة، لكن تاريخها يفيد الإدارة في فهم أيام التأخير.
    await recordAudit({
      action: "display.delay_notice",
      actor: session.username,
      details: { القيمة: raw ? "مفعّلة" : "متوقفة" },
    });
    return NextResponse.json({ ok: true, on: raw });
  } catch {
    return NextResponse.json({ message: "تعذّر الحفظ. أعد المحاولة." }, { status: 500 });
  }
}

export async function GET() {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    const settings = await getSettings();
    return NextResponse.json({ on: settings["display.delay_notice"] === "true" });
  } catch {
    return NextResponse.json({ message: "تعذّر التحميل." }, { status: 500 });
  }
}
