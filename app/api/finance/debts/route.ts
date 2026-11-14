import { NextResponse } from "next/server";
import { patientDebtReport } from "@/lib/db";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalPatientDebts } from "@/lib/canonical-patient-account";

export const dynamic = "force-dynamic";

export async function GET() {
  // M2 slice 88: finance.patient-ledger.view; rows only inside the actor's patient scope.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalPatientDebts(selected.handle), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر تحميل المديونية."); }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "المديونية للإدارة والاستقبال." }, { status: 403 });
  }

  try {
    const rows = await patientDebtReport();
    // (TD-05) الأساس دستوري من الكود.
    return NextResponse.json({ rows, baseCurrency: CLINIC_BASE_CURRENCY });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المديونية." }, { status: 500 });
  }
}
