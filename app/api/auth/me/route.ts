import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername } from "@/lib/db";
import { admitCanonicalStaffSession, selectRequestStaffEnvelope } from "@/lib/staff-session-admission";

export const dynamic = "force-dynamic";

export async function GET() {
  /* الجلسة الموحّدة المختارة تُقبل بإثبات القاعدة الحالي وحده — ولا تسقط إلى المسار
     القديم أبدًا. الإسقاط للعرض والقائمة فقط؛ كل عملية تُقبل بقدرتها في مسارها. */
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "canonical" || selected.kind === "denied") {
    const view = selected.kind === "canonical" ? await admitCanonicalStaffSession(selected.handle).catch(() => null) : null;
    if (!view) {
      return NextResponse.json({ message: "غير مسجل الدخول." }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json({
      canonical: true,
      id: view.userId,
      username: view.username,
      displayName: view.displayName,
      role: view.roleLabel,
      isOwner: view.isOwner,
      capabilities: view.capabilities,
      patientScope: view.patientScope,
      appointmentScope: view.appointmentScope,
      doctorPartyId: view.clinicianPartyId,
    }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "غير مسجل الدخول." }, { status: 401 });
  }

  const user = await findUserByUsername(session.username).catch(() => null);

  return NextResponse.json({
    username: session.username,
    displayName: user?.displayName ?? session.username,
    role: session.role,
    /* صلاحيات الوكيل المساعد: هوية الطبيب الكاملة للتطبيق — التخصص والفرع
       والجهة المرتبطة والصلاحيات وإعدادات العمولة، فيقرر الواجهة ما تعرضه. */
    id: user?.id,
    specialty: user?.specialty,
    branch: user?.branch,
    doctorPartyId: user?.partyId ?? null,
    permissions: user?.permissions,
    commissionConfig: user?.commissionConfig,
  });
}
