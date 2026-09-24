import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, findUserByUsername, getSettings, listExpensesBetween, ratesFromSettings, recordAudit, recordExpense, voidExpense } from "@/lib/db";
import { parseExpenseRequest, refusalStatus } from "@/lib/expense-request";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { refusalMessage } from "@/lib/supplier-payments";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { canDoctorViewExpenses } from "@/lib/doctor-permissions";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  /* صلاحيات الوكيل المساعد: المصروفات من «المالية المخفية» — تُفتح للطبيب
     بتصريح المدير الصريح فقط، وللإدارة والاستقبال كما كانت. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!canDoctorViewExpenses(user?.permissions, session.role)) {
      return NextResponse.json(
        { message: "المصروفات وبنود الصرف مخفية بحسب سياسة المالية المخفية." },
        { status: 403 },
      );
    }
  } else if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : today;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  try {
    return NextResponse.json({ from, to, expenses: await listExpensesBetween(from, to) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المصروفات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  // (TD-05) الأساس دستوري من الكود — والإعدادات لأسعار الصرف لحظة الدفع.
  const base = CLINIC_BASE_CURRENCY;
  const settingsRates = ratesFromSettings(await getSettings());
  const parsed = parseExpenseRequest(source, settingsRates, isAdmin(session.role));
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: parsed.status });
  const request_ = parsed.value;

  try {
    const { expense, reason, quote } = await recordExpense({
      category: request_.category, partyId: request_.partyId, payeeText: request_.payeeText,
      amountMinor: request_.amountMinor, currency: request_.currency, baseCurrency: base,
      exchangeRate: request_.exchangeRate, payableId: request_.payableId, note: request_.note,
      createdBy: session.username, rates: settingsRates,
      payableExchangeRate: request_.payableExchangeRate,
      rateOverrideReason: request_.rateOverrideReason,
      prepaymentReason: request_.prepaymentReason,
    });
    if (reason) {
      return NextResponse.json(
        { message: refusalMessage(reason, quote), code: reason, quote },
        { status: refusalStatus(reason) },
      );
    }
    if (expense) {
      await recordAudit({
        action: "expense.create",
        entity: "expense", entityId: expense.id, entityLabel: expense.voucherNumber,
        details: {
          البند: expense.category, المبلغ: expense.amountMinor, العملة: expense.currency,
          سعر_الدفع: expense.exchangeRate, المكافئ: expense.baseAmountMinor,
          الجهة: expense.partyId ?? expense.payeeText,
          ...(expense.payableId !== null ? {
            الالتزام: expense.payableId,
            عملة_الفاتورة: expense.payableCurrency,
            قيمة_الفاتورة: expense.payableAmountMinor,
            سعر_الفاتورة: expense.payableExchangeRate,
            المخصوم_من_الفاتورة: expense.payableSettledMinor,
            المتبقي_بعد: quote?.payable?.remainingAfterMinor,
          } : {}),
        },
        actor: session.username, actorRole: session.role,
      });
      if (expense.rateOverrideReason) {
        await recordAudit({
          action: "expense.rate_override",
          entity: "expense", entityId: expense.id, entityLabel: expense.voucherNumber,
          details: {
            العملة: expense.currency,
            سعر_الإعدادات: request_.settingsExchangeRate,
            السعر_المستعمل: expense.exchangeRate,
            عملة_الفاتورة: expense.payableCurrency,
            سعر_الفاتورة_بالإعدادات: expense.payableCurrency ? settingsRates[expense.payableCurrency] ?? null : null,
            سعر_الفاتورة_المستعمل: expense.payableExchangeRate,
            السبب: expense.rateOverrideReason,
          },
          actor: session.username, actorRole: session.role,
        });
      }
      if (quote?.party?.prepayment) {
        await recordAudit({
          action: "expense.prepayment",
          entity: "expense", entityId: expense.id, entityLabel: expense.voucherNumber,
          details: {
            الجهة: expense.partyId, المبلغ: expense.amountMinor, العملة: expense.currency,
            المستحق_قبل: quote.party.outstandingBeforeMinor,
            السبب: request_.prepaymentReason,
          },
          actor: session.username, actorRole: session.role,
        });
      }
    }
    return NextResponse.json(expense, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الصرف. أعد المحاولة." }, { status: 500 });
  }
}

/* حذف سند صرف — المدير وحده، وضمن ورديةٍ مفتوحة، ولا لسند يسدّد التزامًا. */
export async function DELETE(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف سندات الصرف للمدير وحده." }, { status: 403 });
  }

  /* الجسم يُقرأ مرة واحدة (قيد الاستهلاك): الرقم من الاستعلام أو من الجسم،
     والسبب معه في القراءة نفسها. */
  const params = new URL(request.url).searchParams;
  let id = Number(params.get("id"));
  let reason: string | null = null;
  if (!Number.isInteger(id) || id <= 0) {
    try {
      const body = (await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES));
      const bodyId = Number(body?.id);
      if (Number.isInteger(bodyId) && bodyId > 0) id = bodyId;
      if (typeof body?.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 300);
      }
    } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; /* فراغ */ }
  } else {
    try {
      const body = (await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES));
      if (typeof body?.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 300);
      }
    } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; /* لا سبب — ليس شرطًا */ }
  }
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم السند غير صالح." }, { status: 400 });
  }

  try {
    const result = await voidExpense(id, { actor: session.username, actorRole: session.role, reason });
    if (!result.ok) {
      if (result.reason === "missing_reason") {
        return NextResponse.json(
          { message: "اكتب سبب الإبطال — تصحيح مالي بلا سبب مُوثَّق غير مقبول." },
          { status: 400 },
        );
      }
      if (result.reason === "already_voided") {
        return NextResponse.json(
          { message: "السند مُبطَل أصلًا — لا يُبطَل قيد الإبطال نفسه." },
          { status: 409 },
        );
      }
      if (result.reason === "closed_shift") {
        return NextResponse.json(
          { message: "وردية السند مقفلة ومجرودة — لا يُبطَل منها شيء بعد الاعتماد؛ القيد التصحيحي يُسجَّل في وردية مفتوحة." },
          { status: 409 },
        );
      }
      if (result.reason === "no_shift") {
        return NextResponse.json(
          { message: "لا توجد وردية مفتوحة. إبطال سداد المورد قيدٌ في وردية اليوم — افتح الوردية أولًا." },
          { status: 409 },
        );
      }
      return NextResponse.json({ message: "السند غير موجود." }, { status: 404 });
    }
    return NextResponse.json({
      message: `أُبطل السند بقيد معاكس (${result.voidedVoucherNumber ?? ""}) وسُجِّل الإبطال في التدقيق — الأصل باقٍ بلا تعديل.`,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف السند. أعد المحاولة." }, { status: 500 });
  }
}
