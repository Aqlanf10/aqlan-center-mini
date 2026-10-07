import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { voidLegacyTreatment } from "@/lib/legacy-treatment-db";
import { LEGACY_TREATMENT_MESSAGE, LEGACY_TREATMENT_STATUS } from "@/lib/legacy-treatment";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (INV-LEGACY) إبطال اتفاقٍ تاريخي — للمدير وحده وبسببٍ مكتوب (كتعديل الرصيد السابق ومسحه): تُحرَّر التغطية ويُصحَّح
 * الرصيد بمسار المحرّك نفسه، ولا يُحذف شيء.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string; agreementId: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إبطال العلاج السابق للنظام ورصيده للمدير وحده." }, { status: 403 });
  }
  const params = await context.params;
  const patientId = Number(params.id);
  const agreementId = Number(params.agreementId);
  if (!Number.isInteger(patientId) || patientId <= 0 || !Number.isInteger(agreementId) || agreementId <= 0) {
    return NextResponse.json({ message: "رقم المريض أو الاتفاق غير صالح." }, { status: 400 });
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const reason = typeof (body as { reason?: unknown } | null)?.reason === "string" ? (body as { reason: string }).reason : "";
  try {
    const result = await voidLegacyTreatment({ patientId, agreementId, reason, actor: session.username, actorRole: session.role });
    if (!result.ok) {
      return NextResponse.json({ message: LEGACY_TREATMENT_MESSAGE[result.reason] }, { status: LEGACY_TREATMENT_STATUS[result.reason] });
    }
    return NextResponse.json({ agreement: result.agreement });
  } catch {
    return NextResponse.json({ message: "تعذّر إبطال الاتفاق التاريخي. أعد المحاولة." }, { status: 500 });
  }
}
