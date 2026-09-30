import { NextResponse } from "next/server";
import { findUserByUsername, listMyReferrals } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** (REF-1) إحالاتي الداخلية: المحالة إليّ، والتي أحلتُها ولم تعد، والتي عادت إليّ ولم أطّلع عليها. */
export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (session.role !== "doctor" && session.role !== "admin") {
    return NextResponse.json({ message: "قائمة الإحالات الشخصية للأطباء." }, { status: 403 });
  }
  const user = await findUserByUsername(session.username).catch(() => null);
  if (!user || !user.isActive) return NextResponse.json({ message: "الحساب غير نشط." }, { status: 403 });
  if (!user.partyId) return NextResponse.json({ toMe: [], sentOpen: [], returnedToMe: [] });
  try {
    return NextResponse.json(await listMyReferrals(user.partyId));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الإحالات." }, { status: 500 });
  }
}
