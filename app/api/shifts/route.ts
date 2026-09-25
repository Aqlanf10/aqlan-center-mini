import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { asPaymentLikes, closeShift, findUserByUsername, getOpenShift, listShiftExpenses, listShiftPayments, listShifts, openShift, recordAudit, shiftDrawerBreakdown } from "@/lib/db";
import { expenseTotals } from "@/lib/expenses";
import { CURRENCIES, formatMoney, parseAmount, shiftTotals, type Currency } from "@/lib/money";
import { canHandleMoney, canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** يقرأ ثلاثة مبالغ — واحدًا لكل عملة — ويرفض ما لا يُقرأ رقمًا. */
function readAmounts(source: Record<string, unknown>, key: string): Record<Currency, number> | null {
  const raw = (source[key] ?? {}) as Record<string, unknown>;
  const result: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
  for (const currency of ["YER", "SAR", "USD"] as Currency[]) {
    const value = raw[currency];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    const minor = parseAmount(String(value), currency);
    if (minor === null) return null;
    result[currency] = minor;
  }
  return result;
}

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  /* صلاحيات الوكيل المساعد: الصندوق والورديات من «المالية المخفية» — الطبيب
     يراها بتصريح المدير فقط؛ والفتح والإغلاق يبقيان للإدارة والاستقبال. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!user?.permissions?.canViewCashDrawer) {
      return NextResponse.json(
        { message: "الصندوق والورديات مخفية بحسب صلاحيات الطبيب." },
        { status: 403 },
      );
    }
  } else if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  try {
    const open = await getOpenShift();
    const [payments, expenses, drawer] = open
      ? await Promise.all([listShiftPayments(open.id), listShiftExpenses(open.id), shiftDrawerBreakdown(open)])
      : [[], [], null];
    return NextResponse.json({
      open,
      /* (P1-3) الدرج بالقاعدة الواحدة (lib/shift-close.ts): النقد وحده — التحويل
         يُعرض منفصلًا ولا يدخل «المتوقَّع في الدرج». */
      drawer,
      totals: shiftTotals(asPaymentLikes(payments)),
      // المصروف يُطرح من المتوقَّع في الصندوق. إهماله أشيع خطأ في إغلاق الصناديق:
      // كل إغلاق يبدو ناقصًا بمقدار ما صُرف، فيُتجاهل الفرق ويصير الجرد بلا فائدة.
      expenseTotals: expenseTotals(expenses),
      payments,
      expenses,
      recent: await listShifts(15),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الوردية." }, { status: 500 });
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
  const opening = readAmounts(source, "opening");
  if (!opening) return NextResponse.json({ message: "مبلغ افتتاحي غير صحيح." }, { status: 400 });

  try {
    const shift = await openShift({ openedBy: session.username, opening });
    if (!shift) {
      return NextResponse.json(
        { message: "هناك وردية مفتوحة بالفعل. أغلقها أولًا." },
        { status: 409 },
      );
    }
    await recordAudit({
      action: "shift.open", entity: "shift", entityId: shift.id,
      details: { الافتتاحي: shift.opening },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(shift, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر فتح الوردية." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
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
  const id = Number(source.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الوردية غير صالح." }, { status: 400 });
  }
  const counted = readAmounts(source, "counted");
  if (!counted) return NextResponse.json({ message: "مبلغ الجرد غير صحيح." }, { status: 400 });

  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;
  const differenceReason = typeof source.differenceReason === "string" && source.differenceReason.trim()
    ? source.differenceReason.trim().slice(0, 300) : null;

  try {
    const result = await closeShift({ id, closedBy: session.username, counted, note, differenceReason });
    if (result.reason === "not_open") {
      return NextResponse.json({ message: "الوردية مغلقة بالفعل أو غير موجودة." }, { status: 409 });
    }
    if (result.reason === "difference_reason_required" && result.difference) {
      /* (P1-3) الجرد أعمى: الفرق يُكشف بعد إدخال المعدود لا قبله، ولا يُقفَل بلا سبب. */
      const parts = CURRENCIES
        .filter((currency) => result.difference![currency] !== 0)
        .map((currency) => {
          const value = result.difference![currency];
          return `${value < 0 ? "عجز" : "زيادة"} ${formatMoney(Math.abs(value), currency)}`;
        });
      return NextResponse.json(
        {
          message: `الجرد لا يطابق المتوقَّع (${parts.join("، ")}). راجع العدّ، وإن صحّ فاكتب سبب الفرق لإقفال الوردية.`,
          code: "difference_reason_required",
          difference: result.difference,
          expected: result.breakdown?.expected ?? null,
        },
        { status: 409 },
      );
    }
    await recordAudit({
      action: "shift.close", entity: "shift", entityId: id,
      details: {
        المعدود: counted,
        المتوقع: result.breakdown?.expected,
        الفرق: result.difference,
        سبب_الفرق: result.shift?.differenceReason ?? null,
        ملاحظة: note,
      },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(result.shift);
  } catch {
    return NextResponse.json({ message: "تعذّر إغلاق الوردية." }, { status: 500 });
  }
}

