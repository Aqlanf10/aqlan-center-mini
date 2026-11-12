import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, getSettings } from "@/lib/db";
import { createLegacyTreatment, listLegacyTreatments } from "@/lib/legacy-treatment-db";
import { LEGACY_TREATMENT_MESSAGE, LEGACY_TREATMENT_STATUS, parseLegacyTreatmentRequest } from "@/lib/legacy-treatment";
import { openingBalanceAccess } from "@/lib/opening-access";
import { canAccessPatient } from "@/lib/patient-access";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalLegacyTreatments } from "@/lib/canonical-legacy-reads";
import { commandCanonicalLegacyTreatment } from "@/lib/canonical-legacy-writes";
import { canonicalLegacyFailure } from "@/lib/canonical-legacy-http";
import { effectiveTemplates } from "@/lib/specialty-templates";
import { DebtRepaymentError } from "@/lib/debt-installments-db";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

function patientIdOf(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * (INV-LEGACY) الاتفاقات التاريخية لعلاجٍ بدأ قبل النظام — للإدارة والاستقبال، والطبيب بإذن «حساب المريض» وعلى
 * مرضاه (كحساب المريض). الصندوق والمحاسبة لا يبلغون مسارات ملف المريض من الباب أصلًا.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 95a (G4-2): the clinical description with the record read; amounts with the ledger view.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalLegacyTreatments(selected.handle, Number((await context.params).id)), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر تحميل العلاجات السابقة للنظام."); }
  }
  const session = await requireSession();
  if (!session) return denied();
  const patientId = patientIdOf((await context.params).id);
  if (session.role === "doctor") {
    if (patientId === null || !(await canAccessPatient(session, patientId, "canViewPatientPayments"))) {
      return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على حساب هذا المريض." }, { status: 403 });
    }
  } else if (session.role !== "admin" && session.role !== "reception") {
    return NextResponse.json({ message: "العلاجات السابقة للنظام وأرصدتها للإدارة والاستقبال." }, { status: 403 });
  }
  if (patientId === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  try {
    const settings = await getSettings().catch(() => null);
    const access = openingBalanceAccess(session.role, settings?.["finance.reception_adds_opening_balance"] === "true");
    return NextResponse.json(
      { agreements: (await listLegacyTreatments(patientId)).filter(agreement=>agreement.documentId===null), access: { add: access.add, edit: access.edit, void: session.role === "admin" } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل العلاجات السابقة للنظام." }, { status: 500 });
  }
}

/**
 * تسجيل علاجٍ بدأ قبل النظام: اتفاقٌ تاريخي ← بند خطة مغطّى ← حالة تخصصية، والمتبقي وحده رصيدٌ سابق بمحرّكه.
 * الصلاحية صلاحية إضافة الرصيد السابق نفسها (المدير، والاستقبال إن فعّلها الإعداد) — قبل قراءة الطلب.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 95b (G4-1, G4-6): finance.legacy.record; an existing opening also needs opening management.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const canonicalPatient = patientIdOf((await context.params).id);
      if (canonicalPatient === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE });
      const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      if (typeof body !== "object" || body === null || Array.isArray(body)) return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
      const parsed = parseLegacyTreatmentRequest(body as Record<string, unknown>, clinicDateString(new Date(), CLINIC_TIME_ZONE));
      if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400, headers: NO_STORE });
      const made = await commandCanonicalLegacyTreatment(selected.handle, canonicalPatient, parsed.value);
      return NextResponse.json(made, { status: made.replayed ? 200 : 201, headers: NO_STORE });
    } catch (error) { return canonicalLegacyFailure(error, "تعذّر تسجيل العلاج السابق للنظام. أعد المحاولة."); }
  }
  const session = await requireSession();
  if (!session) return denied();
  const settings = await getSettings().catch(() => null);
  const access = openingBalanceAccess(session.role, settings?.["finance.reception_adds_opening_balance"] === "true");
  if (!access.add) {
    return NextResponse.json({ message: "تسجيل العلاج السابق للنظام ورصيده للمدير والاستقبال المخوَّل." }, { status: 403 });
  }
  const patientId = patientIdOf((await context.params).id);
  if (patientId === null) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const parsed = parseLegacyTreatmentRequest(body as Record<string, unknown>, clinicDateString(new Date(), CLINIC_TIME_ZONE));
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });

  try {
    const result = await createLegacyTreatment({
      patientId, request: parsed.value, actor: session.username, actorRole: session.role, canEditOpening: access.edit,
      session,
      templates: effectiveTemplates(settings?.["plans.specialty_templates"]).templates,
    });
    if (!result.ok) {
      return NextResponse.json({ message: LEGACY_TREATMENT_MESSAGE[result.reason] }, { status: LEGACY_TREATMENT_STATUS[result.reason] });
    }
    return NextResponse.json(
      { agreement: result.agreement, replayed: result.replayed, caseCreated: result.caseCreated },
      { status: result.replayed ? 200 : 201 },
    );
  } catch(error) {
    if(error instanceof DebtRepaymentError)return NextResponse.json({code:error.code,message:error.message},{status:error.code==="unauthorized"?401:error.code==="invalid"?400:409});
    return NextResponse.json({ message: "تعذّر تسجيل العلاج السابق للنظام. أعد المحاولة." }, { status: 500 });
  }
}
