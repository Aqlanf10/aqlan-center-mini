import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { canonicalOrthoDecisionQuery, readCanonicalOrthoDecisions } from "@/lib/canonical-ortho-decisions";
import { NextResponse } from "next/server";
import { listPendingOrthoDecisions } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** (P1-C) شدّات خارج العقد بانتظار قرار فوترة — للمدير والاستقبال كلها، وللطبيب ما يخصّه. */
export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { canonicalOrthoDecisionQuery(new URL(request.url).searchParams); return NextResponse.json(await readCanonicalOrthoDecisions(selected.handle), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر التحقق من قائمة المراجعة؛ لم تُعتبر فارغة."); }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!["admin", "reception", "doctor"].includes(session.role)) {
    return NextResponse.json({ message: "قرارات فوترة الشدّات للإدارة والاستقبال والطبيب." }, { status: 403 });
  }
  const doctorPartyId = session.role === "doctor" ? (typeof session.partyId === "number" ? session.partyId : -1) : null;
  try {
    return NextResponse.json({ pending: await listPendingOrthoDecisions({ doctorPartyId }) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الشدّات المعلّقة." }, { status: 500 });
  }
}
