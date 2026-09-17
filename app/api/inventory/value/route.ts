import { NextResponse } from "next/server";
import { inventoryValue } from "@/lib/db";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * قيمةُ ما في المخزن — **للمدير وحده**. (من مستودع الوكيل الآخر.)
 *
 * فهي تكشف ما اشترى المركز وبكم، كأسعار المختبر وسقوف المصروف. والطبيب يحتاج
 * الرصيد ليعرف أتكفي المادّة، ولا يحتاج ثمنها.
 */
export async function GET() {
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
    const items = await inventoryValue();
    return NextResponse.json({
      items, baseCurrency,
      totalMinor: items.reduce((sum, one) => sum + one.valueMinor, 0),
      // وبنودٌ بلا ثمنٍ مسجَّل تُعدّ وتُقال: قيمةٌ تُعرض ناقصةً بلا بيانٍ تُقرأ كاملة.
      withoutCost: items.filter((one) => one.qty > 0 && one.unitCostMinor === null).length,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر حساب قيمة المخزون." }, { status: 500 });
  }
}
