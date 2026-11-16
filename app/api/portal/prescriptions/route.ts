import { NextResponse } from "next/server";
import { getPortalPrescriptions } from "@/lib/portal-data";
import { requirePortalSession } from "@/lib/portal-server";
import { readPortalSettings } from "@/lib/portal-settings";

export const dynamic = "force-dynamic";

/**
 * الروشتات الطبية الصادرة للمريض صاحب الجلسة فقط (غير الملغاة).
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }

  try {
    const settings = await readPortalSettings();
    if (!settings.showPrescriptions) {
      return NextResponse.json(
        { message: "عرض الروشتات الطبية غير متاح حاليًا في إعدادات بوابة المريض." },
        { status: 403 },
      );
    }

    const prescriptions = await getPortalPrescriptions(session.patientId);
    return NextResponse.json({ prescriptions });
  } catch {
    return NextResponse.json(
      { message: "تعذّر تحميل الروشتات الطبية." },
      { status: 500 },
    );
  }
}
