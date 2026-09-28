import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { effectiveTemplates } from "@/lib/specialty-templates";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (SPEC-T1/T2) قوالب الخطط حسب التخصص — المحفوظة في الإعدادات إن عدّلها المالك، وإلا الجاهزة.
 * لا مال فيها ولا بيانات مرضى: خطواتٌ وفئات خدماتٍ وجلسات، والأسعار تُحسب من الدليل عند
 * الإنشاء على الخادم. والتعديل عبر مسار الإعدادات المدقَّق نفسه (plans.specialty_templates).
 */
export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    const { templates, customized } = effectiveTemplates((await getSettings())["plans.specialty_templates"]);
    return NextResponse.json({ templates, customized, canEdit: isAdmin(session.role) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قوالب الخطط." }, { status: 500 });
  }
}
