import { NextResponse } from "next/server";
import { canAccessUnifiedReport, isKnownUnifiedReport } from "@/lib/report-access";
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
  const params = new URL(request.url).searchParams;
  const report = params.get("report") ?? "daily";

  /*
   * الاستقبال يدير الصندوق لكنه لا يرى دخل المركز/الربحية/العمولات.
   * الفصل هنا خادميّ: إخفاء زرٍّ وحده لا يمنع طلب API مباشرًا.
   */
  // نوعٌ مجهول خطأ مدخلات (400) قبل سؤال الصلاحية — لا نكشف قائمة التقارير لغير المخوّل بأكثر من هذا.
  if (!isKnownUnifiedReport(report)) {
    return NextResponse.json({ message: "نوع تقرير غير معروف." }, { status: 400 });
  }
  if (!canAccessUnifiedReport(session.role, report)) {
    return NextResponse.json(
      { message: session.role === "reception"
          ? "هذا التقرير مالي/إداري ومتاح للمدير فقط."
          : "مركز التقارير غير متاح لهذا الدور." },
      { status: 403 },
    );
  }

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
