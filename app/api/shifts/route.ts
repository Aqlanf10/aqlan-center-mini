import { NextResponse } from "next/server";
import { asPaymentLikes, closeShift, getOpenShift, listShiftExpenses, listShiftPayments, listShifts, openShift, recordAudit } from "@/lib/db";
import { expenseTotals } from "@/lib/expenses";
import { parseAmount, shiftTotals, type Currency } from "@/lib/money";
import { canHandleMoney } from "@/lib/roles";
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
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  try {
    const open = await getOpenShift();
    const [payments, expenses] = open
      ? await Promise.all([listShiftPayments(open.id), listShiftExpenses(open.id)])
      : [[], []];
    return NextResponse.json({
      open,
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
  try { body = await request.json(); } catch {
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
  try { body = await request.json(); } catch {
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

  try {
    const closed = await closeShift({ id, closedBy: session.username, counted, note });
    if (!closed) {
      return NextResponse.json({ message: "الوردية مغلقة بالفعل أو غير موجودة." }, { status: 409 });
    }
    await recordAudit({
      action: "shift.close", entity: "shift", entityId: id,
      details: { المعدود: counted, ملاحظة: note },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(closed);
  } catch {
    return NextResponse.json({ message: "تعذّر إغلاق الوردية." }, { status: 500 });
  }
}

