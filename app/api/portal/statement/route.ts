import { NextResponse } from "next/server";
import { ledgerBalancesByCurrency, patientLedger, patientPlanCurrencies } from "@/lib/db";
import { requirePortalSession } from "@/lib/portal-server";
import { portalStatementView } from "@/lib/portal-statement";

export const dynamic = "force-dynamic";

/**
 * كشف حساب المريض في البوابة.
 *
 * لا معرّف مريض من العميل — المعرّف من الجلسة الموقّعة وحدها. والحساب يُقرأ من
 * `patientLedger()` نفسها التي تخدم شاشة الحساب الداخلية، وبنفس خريطة الحساب
 * في `patientBalance` حرفيًا: نفس الفواتير، نفس الدفعات، نفس الافتتاحي. لو ظهر
 * رقم مختلف هنا فالخلل في البوابة لا في المصدر.
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  try {
    const [{ invoices, payments, openings }, planCurrencies] = await Promise.all([
      patientLedger(session.patientId),
      patientPlanCurrencies(session.patientId),
    ]);
    /* (TD-05 · P1-5ب) بوابة المريض ترى ما يراه الصندوق: أرصدةً بعملاتها المستقلة —
       بالقاعدة نفسها التي يقرأ بها كشف الحساب (ledgerBalancesByCurrency). */
    const balances = ledgerBalancesByCurrency(session.patientId, { invoices, payments, openings }, planCurrencies);
    /* (FIN-INT-8) نفس مستندات الكشف المطبوع ونفس تسمياته، ولا شيء داخلي: لا ملغاة،
       ولا اسم موظف ولا ملاحظة ولا وردية. الأرصدة من الحساب الكانوني كما هي. */
    return NextResponse.json(portalStatementView({ invoices, payments, openings }, balances, "YER"));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل كشف الحساب." }, { status: 500 });
  }
}
