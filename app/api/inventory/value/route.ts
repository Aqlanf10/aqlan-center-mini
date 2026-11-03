import { NextResponse } from "next/server";
import { readInventoryValuation } from "@/lib/inventory-domain/read";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { inventoryValuationCanonicalResponse } from "@/lib/canonical-invoices-payments-services";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";

export const dynamic = "force-dynamic";

/**
 * قيمةُ ما في المخزن — **للمدير وحده**. (من مستودع الوكيل الآخر.)
 *
 * فهي تكشف ما اشترى المركز وبكم، كأسعار المختبر وسقوف المصروف. والطبيب يحتاج
 * الرصيد ليعرف أتكفي المادّة، ولا يحتاج ثمنها.
 */
export async function GET() {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") return inventoryValuationCanonicalResponse(selected.handle);
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "قيمة المخزون للمدير وحده." }, { status: 403 });
  }
  try {
    // (TD-05) الأساس دستوري من الكود — والعملة تخرج مع الأرقام كما هي:
    // شاشةٌ تفترض الريال تعرض دولارًا على أنه ريال.
    const baseCurrency = CLINIC_BASE_CURRENCY;
    const valuation = await readInventoryValuation();
    return NextResponse.json({ ...valuation, baseCurrency });
  } catch {
    return NextResponse.json({ message: "تعذّر حساب قيمة المخزون." }, { status: 500 });
  }
}
