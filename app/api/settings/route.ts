import { NextResponse } from "next/server";
import { getSettings, recordAudit, saveSettings } from "@/lib/db";
import { ALL_SETTING_KEYS, validateSetting, type SettingKey } from "@/lib/settings";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET() {
  if (!(await requireSession())) return denied();
  try {
    return NextResponse.json(await getSettings());
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الإعدادات." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  // الإعدادات تحكم المال والتشغيل معًا: سعر صرف خاطئ يفسد كل تقرير بعده، وعدد كراسٍ
  // خاطئ يفسد كل حجز. فالتعديل للمدير وحده لا لكل من يملك جلسة.
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تعديل الإعدادات للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const values: Partial<Record<SettingKey, string>> = {};
  for (const key of ALL_SETTING_KEYS) {
    const raw = source[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      return NextResponse.json({ message: "قيمة غير صالحة." }, { status: 400 });
    }
    const problem = validateSetting(key, raw);
    // الرسالة تسمّي الحقل: «قيمة غير صالحة» وحدها تترك المدير يفتّش عن الخطأ في
    // أربعة عشر حقلًا.
    if (problem) return NextResponse.json({ message: problem, key }, { status: 400 });
    values[key] = raw.trim();
  }

  if (Object.keys(values).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحفظ." }, { status: 400 });
  }

  try {
    const saved = await saveSettings(values);
    // المفاتيح لا القيم: سعر الصرف قيمةٌ عادية، لكن قائمة المفاتيح تكفي للسؤال
    // «من غيّر الإعدادات قبل الجرد؟» بلا نقل أي قيمة حسّاسة إلى سجل لا يُحذف منه.
    await recordAudit({
      action: "settings.update",
      details: { المفاتيح: Object.keys(values) },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(saved);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الإعدادات. أعد المحاولة." }, { status: 500 });
  }
}
