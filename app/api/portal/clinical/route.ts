import { NextResponse } from "next/server";
import { getPortalSignedVisits, getPortalTreatmentPlans } from "@/lib/portal-data";
import { requirePortalSession } from "@/lib/portal-server";
import { readPortalSettings } from "@/lib/portal-settings";

export const dynamic = "force-dynamic";

/**
 * ملخص الزيارات الموقّعة وخطط العلاج المعتمدة للمريض صاحب الجلسة فقط:
 * - لا تُعرض مسودات الزيارات غير الموقّعة أو خطط العلاج المسودة/الملغاة أو أي ملاحظات داخلية.
 * - تُحترم مفاتيح الإظهار المحددة من إدارة المركز في `patient_portal_settings`.
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }

  try {
    const settings = await readPortalSettings();
    if (!settings.showVisits && !settings.showTreatmentPlans) {
      return NextResponse.json(
        { message: "عرض الزيارات وخطط العلاج غير متاح حاليًا في إعدادات بوابة المريض." },
        { status: 403 },
      );
    }

    const [visits, plans] = await Promise.all([
      settings.showVisits ? getPortalSignedVisits(session.patientId) : Promise.resolve([]),
      settings.showTreatmentPlans
        ? getPortalTreatmentPlans(session.patientId, settings.showStatement)
        : Promise.resolve([]),
    ]);

    return NextResponse.json({
      showVisits: settings.showVisits,
      showTreatmentPlans: settings.showTreatmentPlans,
      showAmounts: settings.showStatement,
      visits,
      plans,
    });
  } catch {
    return NextResponse.json(
      { message: "تعذّر تحميل الزيارات وخطط العلاج." },
      { status: 500 },
    );
  }
}
