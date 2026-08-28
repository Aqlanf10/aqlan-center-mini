import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, clearPatientOpeningBalance, getPatientOpeningBalance, getSettings, isPeriodLocked, listOpeningBalances, recordAudit, setPatientOpeningBalance } from "@/lib/db";
import { isCurrency, parseAmount } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * الأرصدة الافتتاحية **للمدير وحده**.
 *
 * ليست عملية صندوق: سطرٌ يُكتب هنا يزيد مديونية مريض بلا فاتورة ولا قبض، ويدخل
 * الدفاتر أصلًا افتتاحيًا. تركه لكل من يجلس على الاستقبال يجعل الدَّين رقمًا
 * يُكتب بلا مستند — وهو بالضبط ما جاء النظام ليمنعه.
 */
const forbidden = () =>
  NextResponse.json({ message: "الأرصدة الافتتاحية للمدير وحده." }, { status: 403 });

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  try {
    const [balances, settings] = await Promise.all([listOpeningBalances(), getSettings()]);
    const base = settings["finance.base_currency"];
    return NextResponse.json({
      balances,
      baseCurrency: isCurrency(base) ? base : "YER",
      totalMinor: balances.reduce((sum, row) => sum + row.amountMinor, 0),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الأرصدة الافتتاحية." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }

  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }

  // الرصيد الافتتاحي دَينٌ على المريض. أما من له رصيدٌ عندنا فحالته مختلفة محاسبيًا
  // (التزام على العيادة لا أصل)، ولا تُعالج بقلب الإشارة هنا.
  const amountMinor = parseAmount(String(source.amount ?? ""), base);
  if (amountMinor === null || amountMinor <= 0) {
    return NextResponse.json({ message: "اكتب المبلغ الذي كان على المريض قبل بدء النظام." }, { status: 400 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const asOfDate = typeof source.asOfDate === "string" && DATE_PATTERN.test(source.asOfDate)
    ? source.asOfDate : today;
  if (asOfDate > today) {
    return NextResponse.json({ message: "تاريخ الرصيد الافتتاحي لا يكون في المستقبل." }, { status: 400 });
  }
  if (await isPeriodLocked(asOfDate)) {
    return NextResponse.json({ message: "الفترة مقفلة. اختر تاريخًا بعد تاريخ الإقفال." }, { status: 409 });
  }

  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  try {
    const balance = await setPatientOpeningBalance({
      patientId, amountMinor, asOfDate, note, createdBy: session.username,
    });
    if (!balance) {
      return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
    }
    await recordAudit({
      action: "opening_balance.set", entity: "patient", entityId: patientId,
      entityLabel: balance.patientName,
      details: { المبلغ: amountMinor, التاريخ: asOfDate, ملاحظة: note },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(balance, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الرصيد الافتتاحي." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }

  try {
    const existing = await getPatientOpeningBalance(patientId);
    if (!existing) return NextResponse.json({ message: "لا رصيد افتتاحي لهذا المريض." }, { status: 404 });
    if (await isPeriodLocked(existing.asOfDate)) {
      return NextResponse.json({ message: "الفترة مقفلة. لا يُحذف رصيد افتتاحي داخلها." }, { status: 409 });
    }
    await clearPatientOpeningBalance(patientId);
    await recordAudit({
      action: "opening_balance.clear", entity: "patient", entityId: patientId,
      entityLabel: existing.patientName,
      details: { المبلغ_المحذوف: existing.amountMinor, التاريخ: existing.asOfDate },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف الرصيد الافتتاحي." }, { status: 500 });
  }
}
