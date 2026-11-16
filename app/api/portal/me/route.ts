import { NextResponse } from "next/server";
import { getPortalPatientProfileSummary } from "@/lib/portal-data";
import { requirePortalSession } from "@/lib/portal-server";
import { readPortalSettings, visibleSectionsFromSettings } from "@/lib/portal-settings";

export const dynamic = "force-dynamic";

/**
 * من الذي يطلب؟ — الصفحة تسأله لتفصل بين شاشة الدخول والبوابة،
 * وتعرض الشريط الإداري عند المعاينة، وتقرأ الأقسام المسموح بعرضها وملخص الملف الآمن.
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }

  try {
    const settings = await readPortalSettings();
    const visibleSections = visibleSectionsFromSettings(settings);
    const profile = settings.showProfile
      ? await getPortalPatientProfileSummary(session.patientId)
      : null;

    return NextResponse.json({
      patientNumber: session.patientNumber,
      fullName: session.fullName,
      operatingMode: settings.effectiveOperatingMode,
      visibleSections,
      profile,
      ...(session.adminPreview ? { adminPreview: session.adminPreview } : {}),
    });
  } catch {
    return NextResponse.json({
      patientNumber: session.patientNumber,
      fullName: session.fullName,
      ...(session.adminPreview ? { adminPreview: session.adminPreview } : {}),
    });
  }
}
