import { NextResponse } from "next/server";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { ReportInputError, buildReport, dbTodayISO, parseFilters, reportOptions } from "@/lib/reports";

export const dynamic = "force-dynamic";

/**
 * مسار التقارير الموحد — نوع التقرير معاملٌ واحد، والباقي فلاتر مشتركة.
 *
 * الصلاحية: التقارير كلها مالية أو تمس أرصدة المرضى، فبابها واحد — صلاحية المال
 * (المدير والاستقبال). الطبيب الذي لا صلاحية مالية له لا يرى هذه التقارير أصلًا،
 * وهو عين ما تنص عليه وثيقة المتطلبات (البند ١١): تقرير الطبيب المالي للإدارة.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "مركز التقارير للإدارة والاستقبال — الطبيب له شاشة التقرير التشغيلي." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const report = params.get("report") ?? "daily";

  if (report === "options") {
    try {
      return NextResponse.json(await reportOptions());
    } catch {
      return NextResponse.json({ message: "تعذّر تحميل خيارات الفلاتر." }, { status: 500 });
    }
  }

  try {
    // «اليوم» من القاعدة نفسها — مطابقةً للطريقة التي حُسبت بها تواريخ كل حركة.
    const filters = parseFilters(params, await dbTodayISO());
    const result = await buildReport(report, filters);
    /* (P1-2) العقد الذي تقرؤه الصفحة (`LoadedReport`): التقرير داخل `result`. كان
       يُعاد مسطّحًا ({...result}) فتقرأ الصفحة `data.result` غير معرَّف وتنهار لكل
       مستخدم — والمسار نفسه يعيد 200. */
    return NextResponse.json({ result, generatedAt: new Date().toISOString(), generatedBy: session.username });
  } catch (error) {
    // رسائل المدخلات عربية مكتوبة للمستخدم؛ غيرها لا تُكشف تفاصيله (CLAUDE.md).
    if (error instanceof ReportInputError) {
      return NextResponse.json({ message: error.message }, { status: 400 });
    }
    return NextResponse.json({ message: "تعذّر إعداد التقرير. أعد المحاولة." }, { status: 500 });
  }
}
