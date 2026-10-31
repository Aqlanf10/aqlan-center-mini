import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalClinicalRecordsFailure, readCanonicalClinicalContext } from "@/lib/canonical-clinical-records";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { guardPatient, json } from "@/lib/case-route";
import { readClinicalContext, parseClinicalId } from "@/lib/patient-navigation";
import { resolveClinicalNavigationContext } from "@/lib/clinical-navigation-db";

export const dynamic = "force-dynamic";

/** Validates an exact navigation graph. Read-only, with the ordinary patient/plan authority. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      return NextResponse.json(
        await readCanonicalClinicalContext(selected.handle, (await params).id, new URL(request.url).searchParams),
        { headers: NO_STORE },
      );
    } catch (error) {
      return canonicalClinicalRecordsFailure(error, "تعذّر التحقق من مرجع العلاج. أعد المحاولة.");
    }
  }
  const patientId = parseClinicalId((await params).id);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const parsed = readClinicalContext(new URL(request.url).searchParams);
  if (parsed.contextError) return json("مرجع العلاج في الرابط غير صالح. اختر الحالة صراحةً.", 400);
  const context = parsed.context ?? {};
  const guard = await guardPatient(patientId, false, context.planId !== undefined || context.planItemId !== undefined ? "view" : undefined);
  if (!guard.ok) return guard.response;
  try {
    const result = await resolveClinicalNavigationContext(patientId, context);
    if (!result.ok) return NextResponse.json({ reason: result.reason,
      message: "تعذّر التحقق من الحالة أو البند المقصود. لم يتم اختيار حالة بديلة." }, { status: result.reason === "not_found" ? 404 : 409 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return json("تعذّر التحقق من مرجع العلاج. أعد المحاولة.", 500);
  }
}
