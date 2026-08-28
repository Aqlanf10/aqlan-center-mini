import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getPlan, getSettings, recordPlanInstallment, setPlanStatus } from "@/lib/db";
import { isCurrency, parseAmount, type Currency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney } from "@/lib/roles";
import { rateFromSettings } from "@/lib/settings";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** تسجيل قسط: فاتورة بقيمته ودفعة عليها في معاملة واحدة. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "التحصيل للإدارة والاستقبال." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const planId = Number(rawId);
  if (!Number.isInteger(planId) || planId <= 0) {
    return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const plan = await getPlan(planId, today);
  if (!plan) return NextResponse.json({ message: "الخطة غير موجودة." }, { status: 404 });
  if (plan.status !== "active") {
    return NextResponse.json({ message: "الخطة غير جارية." }, { status: 409 });
  }

  const currency = source.currency;
  if (!isCurrency(currency)) {
    return NextResponse.json({ message: "اختر العملة." }, { status: 400 });
  }
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor === 0) {
    return NextResponse.json({ message: "اكتب مبلغًا أكبر من صفر." }, { status: 400 });
  }

  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }
  const exchangeRate = rateFromSettings(settings, currency, base);
  if (exchangeRate === null) {
    return NextResponse.json(
      { message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية." },
      { status: 409 },
    );
  }

  // رقم القسط يُشتقّ من عدد المسدَّد لا يُقبل من الواجهة: رقمٌ مكرر يجعل سندين
  // يحملان «قسط 3» ولا يُعرف أيّهما.
  const installmentNumber = Math.min(plan.progress.paidCount + 1, plan.installments.length || 1);
  const method = source.method === "transfer" ? "transfer" : "cash";
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  try {
    const result = await recordPlanInstallment({
      planId, patientId: plan.patientId, installmentNumber, planTitle: plan.title,
      amountMinor, currency, baseCurrency: base, exchangeRate, method, note,
      createdBy: session.username,
    });
    if ("reason" in result) {
      return NextResponse.json(
        { message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة الصندوق أولًا." },
        { status: 409 },
      );
    }
    return NextResponse.json(result, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل القسط. أعد المحاولة." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const status = (body as Record<string, unknown>)?.status;
  if (status !== "active" && status !== "completed" && status !== "cancelled") {
    return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400 });
  }

  try {
    const done = await setPlanStatus(id, status);
    if (!done) return NextResponse.json({ message: "الخطة غير موجودة." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء." }, { status: 500 });
  }
}
