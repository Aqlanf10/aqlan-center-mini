import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, fxReport, postRevaluation } from "@/lib/db";
import { FinancialCurrencyIntegrityError, isCurrency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { canViewFinancialReports, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** إعادة التقييم تُغيّر ربح الفترة — للمدير وحده. */
const forbidden = () =>
  NextResponse.json({ message: "إعادة تقييم العملات للمدير وحده." }, { status: 403 });

function asOfFrom(request: Request): string {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const raw = new URL(request.url).searchParams.get("asOf");
  return raw && DATE_PATTERN.test(raw) && raw <= today ? raw : today;
}

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canViewFinancialReports(session.role)) return forbidden();

  try {
    return NextResponse.json(await fxReport(asOfFrom(request)));
  } catch (error) {
    if (error instanceof FinancialCurrencyIntegrityError) {
      return NextResponse.json(
        { message: "في المستندات دفعةٌ لا تُحلّ عملة تسويتها — راجع سجل المدفوعات قبل قراءة المراكز." },
        { status: 409 },
      );
    }
    return NextResponse.json({ message: "تعذّر حساب مراكز العملات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  if (!isCurrency(source.currency)) {
    return NextResponse.json({ message: "اختر العملة." }, { status: 400 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const asOf = typeof source.asOf === "string" && DATE_PATTERN.test(source.asOf) && source.asOf <= today
    ? source.asOf : today;

  try {
    const { reason } = await postRevaluation({
      currency: source.currency, asOf, createdBy: session.username,
    });
    if (reason === "locked") {
      return NextResponse.json(
        { message: "الفترة مقفلة. لا يُرحَّل فيها قيد." }, { status: 409 },
      );
    }
    /* (TD-REG-028) الدفاتر بعملاتها الأصلية: لا فرق سعرٍ يُقيَّد داخلها — قرارٌ موثَّق لا حذفٌ صامت.
       (docs/MULTI_CURRENCY_LEDGER_DESIGN.md §7) الترجمة معروضة للعلم في GET. */
    return NextResponse.json(
      {
        message: "الدفاتر بعملاتها الأصلية — لا يُرحَّل قيد إعادة تقييم. قيمة ما نملكه من كل عملة بسعر اليوم معروضةٌ للعلم في هذه الشاشة.",
        reason: "native_ledger",
      },
      { status: 409 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر معالجة طلب إعادة التقييم." }, { status: 500 });
  }
}
