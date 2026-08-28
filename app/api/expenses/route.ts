import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getSettings, listExpensesBetween, recordAudit, recordExpense } from "@/lib/db";
import { isExpenseCategory } from "@/lib/expenses";
import { isCurrency, parseAmount, type Currency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney } from "@/lib/roles";
import { rateFromSettings } from "@/lib/settings";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
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
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  if (!isExpenseCategory(source.category)) {
    return NextResponse.json({ message: "اختر تصنيف المصروف." }, { status: 400 });
  }
  const currency = source.currency;
  if (!isCurrency(currency)) {
    return NextResponse.json({ message: "اختر العملة." }, { status: 400 });
  }
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor === 0) {
    return NextResponse.json({ message: "اكتب مبلغًا أكبر من صفر." }, { status: 400 });
  }

  const partyIdRaw = Number(source.partyId);
  const partyId = Number.isInteger(partyIdRaw) && partyIdRaw > 0 ? partyIdRaw : null;
  const payeeText = typeof source.payee === "string" && source.payee.trim()
    ? source.payee.trim().slice(0, 120) : null;
  // جهة أو اسم مكتوب — أحدهما على الأقل: سند صرف بلا مستفيد ورقةٌ لا تُراجَع.
  if (!partyId && !payeeText) {
    return NextResponse.json({ message: "اكتب جهة الصرف أو اخترها من القائمة." }, { status: 400 });
  }

  const payableIdRaw = Number(source.payableId);
  const payableId = Number.isInteger(payableIdRaw) && payableIdRaw > 0 ? payableIdRaw : null;
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }
  const exchangeRate = rateFromSettings(settings, currency, base);
  if (exchangeRate === null) {
    return NextResponse.json(
      { message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل الصرف بعملة أجنبية." },
      { status: 409 },
    );
  }

  try {
    const { expense, reason } = await recordExpense({
      category: source.category, partyId, payeeText, amountMinor, currency,
      baseCurrency: base, exchangeRate, payableId, note, createdBy: session.username,
    });
    if (reason === "no_shift") {
      return NextResponse.json(
        { message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة الصندوق أولًا." },
        { status: 409 },
      );
    }
    if (expense) {
      await recordAudit({
        action: "expense.create",
        entity: "expense", entityId: expense.id, entityLabel: expense.voucherNumber,
        details: {
          البند: expense.category, المبلغ: expense.amountMinor, العملة: expense.currency,
          المكافئ: expense.baseAmountMinor, الجهة: expense.partyId ?? expense.payeeText,
        },
        actor: session.username, actorRole: session.role,
      });
    }
    return NextResponse.json(expense, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الصرف. أعد المحاولة." }, { status: 500 });
  }
}
