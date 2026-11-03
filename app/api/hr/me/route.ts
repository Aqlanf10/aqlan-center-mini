import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { hrMeGetCanonicalResponse } from "@/lib/canonical-hr";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { getMyHrSummary } from "@/lib/hr-self-service";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") return hrMeGetCanonicalResponse(selected.handle);

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
