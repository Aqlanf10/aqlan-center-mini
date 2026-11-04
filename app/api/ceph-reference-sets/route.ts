import { NextResponse } from "next/server";
import { listCephReferenceSets } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalCephReferenceRefusal, readCanonicalCephReferences } from "@/lib/canonical-ceph-references";

export const dynamic = "force-dynamic";

/**
 * المجموعات المرجعية المفعلة بقيمها.
 *
 * القياسات لا تحمل حكمًا داخلها: متوسط كل تحليل وانحرافه يأتي من مجموعة
 * مرجعية معلومة المصدر والإصدار — والأدمن يضيف مجموعات محلية لاحقًا دون
 * تغيير كود. المسار القديم يبقي قراءته لكل جلسة؛ المسار القانوني يحتاج
 * صلاحية الصور المستقلة، دون أن يمنح نطاقًا على مرضى أو دراسات.
 */
export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    if ([...new URL(request.url).searchParams.keys()].length) return NextResponse.json({ message: "طلب المجموعات المرجعية غير صالح." }, { status: 400, headers: NO_STORE });
    try {
      return NextResponse.json(await readCanonicalCephReferences(selected.handle), { headers: NO_STORE });
    } catch (error) {
      if (error instanceof CanonicalCephReferenceRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: 409, headers: NO_STORE });
      return canonicalPatientReadFailure(error, "تعذّر تحميل المراجع؛ لم تُعتبر القائمة فارغة.");
    }
  }
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    const sets = await listCephReferenceSets();
    return NextResponse.json({ sets });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المجموعات المرجعية." }, { status: 500 });
  }
}
