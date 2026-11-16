import { NextResponse } from "next/server";
import { getPortalDocuments } from "@/lib/portal-data";
import { requirePortalSession } from "@/lib/portal-server";
import { readPortalSettings } from "@/lib/portal-settings";

export const dynamic = "force-dynamic";

/**
 * قائمة المستندات والتقارير المسموح بعرضها للمريض صاحب الجلسة فقط.
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }

  try {
    const settings = await readPortalSettings();
    if (!settings.showDocuments) {
      return NextResponse.json(
        { message: "عرض المستندات والتقارير غير متاح حاليًا في إعدادات بوابة المريض." },
        { status: 403 },
      );
    }

    const documents = await getPortalDocuments(session.patientId, settings);
    return NextResponse.json({
      includeXrays: settings.showXrayDocuments,
      documents,
    });
  } catch {
    return NextResponse.json(
      { message: "تعذّر تحميل المستندات والتقارير." },
      { status: 500 },
    );
  }
}
