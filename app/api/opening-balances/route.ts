import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, clearPatientOpeningBalance, getPatientOpeningBalance, isPeriodLocked, listOpeningBalanceHistory, listOpeningBalances, recordAudit, setPatientOpeningBalance } from "@/lib/db";
import { parseAmount, CLINIC_BASE_CURRENCY, isCurrency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { canViewFinancialReports, isAdmin } from "@/lib/roles";
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

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canViewFinancialReports(session.role)) return forbidden();

  // (P2-5) سجلّ مريضٍ واحد: كل قيمةٍ كانت ومن غيّرها ولماذا.
  const historyFor = Number(new URL(request.url).searchParams.get("history"));
  if (Number.isInteger(historyFor) && historyFor > 0) {
    try {
      return NextResponse.json({ history: await listOpeningBalanceHistory(historyFor) });
    } catch {
      return NextResponse.json({ message: "تعذّر تحميل سجل الرصيد الافتتاحي." }, { status: 500 });
    }
  }

  try {
    const balances = await listOpeningBalances();
    // (P1-5ب) المجموع لكل عملةٍ على حدة — لا رقمٌ واحد يمزج اليمني بالسعودي.
    const totalsByCurrency: Record<string, number> = {};
    for (const row of balances) totalsByCurrency[row.currency] = (totalsByCurrency[row.currency] ?? 0) + row.amountMinor;
    return NextResponse.json({
      balances,
      baseCurrency: CLINIC_BASE_CURRENCY,
      totalMinor: totalsByCurrency[CLINIC_BASE_CURRENCY] ?? 0,
      totalsByCurrency,
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
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }

  // (P1-5ب) الرصيد الافتتاحي بعملته — قرار المالك: السعودي يبقى سعوديًا. الغائبة = الأساس.
  const currency = source.currency === undefined || source.currency === null || source.currency === ""
    ? CLINIC_BASE_CURRENCY : source.currency;
  if (!isCurrency(currency)) {
    return NextResponse.json({ message: "عملة الرصيد غير صالحة." }, { status: 400 });
  }

  // الرصيد الافتتاحي دَينٌ على المريض. أما من له رصيدٌ عندنا فحالته مختلفة محاسبيًا
  // (التزام على العيادة لا أصل)، ولا تُعالج بقلب الإشارة هنا.
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
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
  const reason = typeof source.reason === "string" && source.reason.trim()
    ? source.reason.trim().slice(0, 300) : null;

  try {
    /* (P2-5) تعديل رصيدٍ قائم يمسّ دَينًا ظهر في كشوفٍ سابقة: لا يُستبدل بلا سبب،
       والقيمة السابقة تُحفظ في السجلّ والتدقيق. */
    const before = await getPatientOpeningBalance(patientId, currency);
    if (before && !reason) {
      return NextResponse.json({ message: "للمريض رصيدٌ افتتاحي مسجّل. اكتب سبب تعديله." }, { status: 400 });
    }
    if (before && await isPeriodLocked(before.asOfDate)) {
      return NextResponse.json({ message: "الرصيد الحالي في فترة مقفلة. لا يُعدَّل." }, { status: 409 });
    }
    const balance = await setPatientOpeningBalance({
      patientId, currency, amountMinor, asOfDate, note, createdBy: session.username, reason,
    });
    if (!balance) {
      return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
    }
    await recordAudit({
      action: "opening_balance.set", entity: "patient", entityId: patientId,
      entityLabel: balance.patientName,
      details: {
        المبلغ: amountMinor, العملة: currency, التاريخ: asOfDate, ملاحظة: note,
        ...(before ? { المبلغ_السابق: before.amountMinor, التاريخ_السابق: before.asOfDate, السبب: reason } : {}),
      },
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

  const params = new URL(request.url).searchParams;
  const patientId = Number(params.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  // (P2-5) المسح لا يمحو التاريخ، لكنه يُسقط دينًا — فبسببٍ مكتوب.
  const reason = (params.get("reason") ?? "").trim().slice(0, 300);
  const currencyParam = params.get("currency") || CLINIC_BASE_CURRENCY;
  if (!isCurrency(currencyParam)) {
    return NextResponse.json({ message: "عملة الرصيد غير صالحة." }, { status: 400 });
  }
  if (reason.length < 3) {
    return NextResponse.json({ message: "اكتب سبب حذف الرصيد الافتتاحي." }, { status: 400 });
  }

  try {
    const existing = await getPatientOpeningBalance(patientId, currencyParam);
    if (!existing) return NextResponse.json({ message: "لا رصيد افتتاحي لهذا المريض." }, { status: 404 });
    if (await isPeriodLocked(existing.asOfDate)) {
      return NextResponse.json({ message: "الفترة مقفلة. لا يُحذف رصيد افتتاحي داخلها." }, { status: 409 });
    }
    await clearPatientOpeningBalance(patientId, session.username, reason, currencyParam);
    await recordAudit({
      action: "opening_balance.clear", entity: "patient", entityId: patientId,
      entityLabel: existing.patientName,
      details: { المبلغ_المحذوف: existing.amountMinor, العملة: currencyParam, التاريخ: existing.asOfDate, السبب: reason },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف الرصيد الافتتاحي." }, { status: 500 });
  }
}
