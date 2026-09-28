import { NextResponse } from "next/server";
import { DEFAULT_SPECIALTY_TEMPLATES } from "@/lib/specialty-templates";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (SPEC-T1) قوالب الخطط حسب التخصص — لشاشة «خطة من قالب». لا مال فيها ولا بيانات مرضى:
 * خطواتٌ وفئات خدماتٍ وجلسات، والأسعار تُحسب من الدليل عند الإنشاء على الخادم.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  return NextResponse.json({ templates: DEFAULT_SPECIALTY_TEMPLATES });
}
