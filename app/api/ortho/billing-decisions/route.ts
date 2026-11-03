import { NextResponse } from "next/server";
import { listPendingOrthoDecisions } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalOrthoFailure, readCanonicalOrthoBillingDecisions } from "@/lib/canonical-ortho-operations";

export const dynamic = "force-dynamic";

/** (P1-C) شدّات خارج العقد بانتظار قرار فوترة — للمدير والاستقبال كلها، وللطبيب ما يخصّه. */
export async function GET() {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") {
    try {
      return NextResponse.json(await readCanonicalOrthoBillingDecisions(selected.handle), { headers: NO_STORE });
    } catch (error) {
      return canonicalOrthoFailure(error, "تعذّر تحميل الشدّات المعلّقة.");
    }
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
