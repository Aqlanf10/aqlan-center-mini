import { NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/** من الذي يطلب؟ — الصفحة تسأله لتفصل بين شاشة الدخول والبوابة. */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  return NextResponse.json({
    patientNumber: session.patientNumber,
    fullName: session.fullName,
  });
}
