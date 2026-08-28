import { NextResponse } from "next/server";
import { createPayable, getSettings, partyBalances, partyStatement } from "@/lib/db";
import { isCurrency, parseAmount, type Currency } from "@/lib/money";
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
  const partyId = Number(new URL(request.url).searchParams.get("partyId"));

  try {
    const settings = await getSettings();
    const base = settings["finance.base_currency"];
    const baseCurrency = isCurrency(base) ? base : "YER";

    if (Number.isInteger(partyId) && partyId > 0) {
      const statement = await partyStatement(partyId);
      return NextResponse.json({ ...statement, baseCurrency });
    }
    return NextResponse.json({ balances: await partyBalances(), baseCurrency });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المستحقات." }, { status: 500 });
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

  const partyId = Number(source.partyId);
  if (!Number.isInteger(partyId) || partyId <= 0) {
    return NextResponse.json({ message: "اختر الجهة." }, { status: 400 });
  }
  const description = typeof source.description === "string" ? source.description.trim() : "";
  if (!description || description.length > 200) {
    return NextResponse.json({ message: "اكتب بيان الالتزام." }, { status: 400 });
  }
  const currency = isCurrency(source.currency) ? source.currency : null;
  if (!currency) return NextResponse.json({ message: "اختر العملة." }, { status: 400 });

  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor === 0) {
    return NextResponse.json({ message: "اكتب مبلغًا أكبر من صفر." }, { status: 400 });
  }

  const dueDate = typeof source.dueDate === "string" && DATE_PATTERN.test(source.dueDate)
    ? source.dueDate : null;
  const category = typeof source.category === "string" && source.category.trim()
    ? source.category.trim().slice(0, 40) : "supplier";

  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }
  const exchangeRate = rateFromSettings(settings, currency, base);
  if (exchangeRate === null) {
    return NextResponse.json({ message: "سعر الصرف غير مضبوط في الإعدادات." }, { status: 409 });
  }

  try {
    const payable = await createPayable({
      partyId, category, description, amountMinor, currency,
      baseCurrency: base, exchangeRate, labOrderId: null, dueDate,
      createdBy: session.username,
    });
    if (!payable) return NextResponse.json({ message: "تعذّر حفظ الالتزام." }, { status: 500 });
    return NextResponse.json(payable, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الالتزام. تأكد من الجهة." }, { status: 500 });
  }
}
