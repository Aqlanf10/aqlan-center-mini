import { NextResponse } from "next/server";
import { listPendingOrthoDecisions } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** (P1-C) شدّات خارج العقد بانتظار قرار فوترة — للمدير والاستقبال كلها، وللطبيب ما يخصّه. */
export async function GET() {
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
