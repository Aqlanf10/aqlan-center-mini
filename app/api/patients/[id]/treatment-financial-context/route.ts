import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { financeAccessFor } from "@/lib/finance-permissions";
import { canViewMoney } from "@/lib/roles";
import { listTreatmentFinancialReferences } from "@/lib/treatment-financial-context-db";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalTreatmentFinancialContext } from "@/lib/canonical-patient-account";

export const dynamic = "force-dynamic";

/** Same visibility boundary as patient invoices; a clinical deep link grants no financial permission. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 88: finance.patient-ledger.view inside the patient scope, one snapshot.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalTreatmentFinancialContext(selected.handle, Number((await context.params).id)), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر التحقق من المراجع المالية؛ راجع السجل المالي قبل التحصيل."); }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!canViewMoney(session.role)) return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  if ((session.role === "cashier" || session.role === "accountant")
    && !financeAccessFor(session.role, session.financeAccess).viewPatientLedger) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على حساب هذا المريض." }, { status: 403 });
  }
  const patientId = Number((await context.params).id);
  if (!Number.isSafeInteger(patientId) || patientId <= 0) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  try {
    const result = await listTreatmentFinancialReferences(patientId);
    if (!result) return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر التحقق من المراجع المالية؛ راجع السجل المالي قبل التحصيل." }, { status: 500 });
  }
}
