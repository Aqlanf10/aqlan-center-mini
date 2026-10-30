import { NextResponse } from "next/server";
import { getMyHrSummary } from "@/lib/hr-self-service";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    const summary = await getMyHrSummary(session);
    return NextResponse.json(summary, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الملف الوظيفي." }, { status: 500 });
  }
}
