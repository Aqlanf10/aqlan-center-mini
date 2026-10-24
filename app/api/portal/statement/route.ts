import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, ledgerBalancesByCurrency, patientStatementSnapshot } from "@/lib/db";
import { requirePortalSession } from "@/lib/portal-server";
import { portalStatementView } from "@/lib/portal-statement";
import { clinicDateString } from "@/lib/schedule";
import { historicalOpeningBuckets } from "@/lib/statement-historical-details";

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
    // The printed statement's readers, in one snapshot: balances and agreement progress
    // in a response always describe the same committed state.
    // Previous-treatment details ride the same snapshot. A malformed saved historical fact withholds that
    // section only (null); it never fails or alters the balances, which never depend on it.
    const { ledger: { invoices, payments, openings }, planCurrencies, plans, historicalAgreements } =
      await patientStatementSnapshot(session.patientId, clinicDateString(new Date(), CLINIC_TIME_ZONE), { historicalAgreements: "tolerant" });
    /* (TD-05 · P1-5ب) بوابة المريض ترى ما يراه الصندوق: أرصدةً بعملاتها المستقلة —
       بالقاعدة نفسها التي يقرأ بها كشف الحساب (ledgerBalancesByCurrency). */
    const balances = ledgerBalancesByCurrency(session.patientId, { invoices, payments, openings }, planCurrencies);
    /* (FIN-INT-8) نفس مستندات الكشف المطبوع ونفس تسمياته، ولا شيء داخلي: لا ملغاة،
       ولا اسم موظف ولا ملاحظة ولا وردية. الأرصدة من الحساب الكانوني كما هي. */
    const historicalBuckets = historicalAgreements ? historicalOpeningBuckets(historicalAgreements, openings, payments) : null;
    return NextResponse.json(portalStatementView({ invoices, payments, openings }, balances, "YER", plans, historicalBuckets));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل كشف الحساب." }, { status: 500 });
  }
}
