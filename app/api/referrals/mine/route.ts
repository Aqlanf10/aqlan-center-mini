import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalClinicalRecordsFailure, readCanonicalMyReferrals } from "@/lib/canonical-clinical-records";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { findUserByUsername, myClinicalWork } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (REF-1/REF-2) «عملي السريري»: المحالة إليّ، والتي أحلتُها ولم تعد، والتي عادت إليّ ولم أطّلع عليها،
 * ومرضاي اليوم مع سياق إحالتهم.
 */
export async function GET() {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      return NextResponse.json(await readCanonicalMyReferrals(selected.handle), { headers: NO_STORE });
    } catch (error) {
      return canonicalClinicalRecordsFailure(error, "تعذّر تحميل الإحالات.");
    }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (session.role !== "doctor" && session.role !== "admin") {
    return NextResponse.json({ message: "قائمة الإحالات الشخصية للأطباء." }, { status: 403 });
  }
  const user = await findUserByUsername(session.username).catch(() => null);
  if (!user || !user.isActive) return NextResponse.json({ message: "الحساب غير نشط." }, { status: 403 });
  if (!user.partyId) return NextResponse.json({ toMe: [], sentOpen: [], returnedToMe: [], today: [] });
  try {
    return NextResponse.json(await myClinicalWork(user.partyId));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الإحالات." }, { status: 500 });
  }
}
