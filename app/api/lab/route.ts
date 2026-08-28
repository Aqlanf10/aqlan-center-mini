import { NextResponse } from "next/server";
import { createLabOrder, getSettings, labCounts, listLabNames, listLabOrders, listParties } from "@/lib/db";
import { isCurrency, parseAmount, type Currency } from "@/lib/money";
import { toWhatsAppNumber } from "@/lib/reminders";
import { rateFromSettings } from "@/lib/settings";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  if (!(await requireSession())) return denied();
  // اللوحة تسأل عن الأرقام وحدها كل عشرين ثانية، فتُعدّ في Postgres بلا جلب صفوف.
  const summaryOnly = new URL(request.url).searchParams.get("summary") === "1";
  try {
    if (summaryOnly) {
      return NextResponse.json(await labCounts());
    }
    const [orders, labs] = await Promise.all([listLabOrders(), listLabNames()]);
    return NextResponse.json({ orders, labs });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل أعمال المختبر." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }
  const labName = typeof source.labName === "string" ? source.labName.trim() : "";
  if (!labName || labName.length > 80) {
    return NextResponse.json({ message: "اكتب اسم المختبر." }, { status: 400 });
  }
  const workType = typeof source.workType === "string" ? source.workType.trim() : "";
  if (!workType || workType.length > 80) {
    return NextResponse.json({ message: "اختر نوع العمل." }, { status: 400 });
  }
  const sentDate = typeof source.sentDate === "string" ? source.sentDate : "";
  const dueDate = typeof source.dueDate === "string" ? source.dueDate : "";
  if (!DATE_PATTERN.test(sentDate) || !DATE_PATTERN.test(dueDate)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }
  // موعد تسليم قبل الإرسال يجعل العمل «متأخرًا» لحظة إنشائه، فيسمّم قائمة المتأخر كلها.
  if (dueDate < sentDate) {
    return NextResponse.json({ message: "موعد التسليم قبل تاريخ الإرسال." }, { status: 400 });
  }

  let labPhone: string | null = null;
  if (typeof source.labPhone === "string" && source.labPhone.trim()) {
    labPhone = toWhatsAppNumber(source.labPhone) ?? source.labPhone.trim().slice(0, 30);
  }

  const details = typeof source.details === "string" && source.details.trim()
    ? source.details.trim().slice(0, 300) : null;
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  // تكلفة العمل اختيارية، لكن متى ذُكرت لزم معها المختبر المسجّل: تكلفةٌ بلا جهة
  // لا تصير التزامًا يُطالَب به، فتظهر العيادة رابحة وهي مدينة.
  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }

  const partyIdRaw = Number(source.partyId);
  const labParties = new Set((await listParties("lab")).map((party) => party.id));
  const partyId = Number.isInteger(partyIdRaw) && labParties.has(partyIdRaw) ? partyIdRaw : null;

  let costMinor: number | null = null;
  let costCurrency: Currency | null = null;
  let exchangeRate = 1;
  if (source.cost !== undefined && String(source.cost).trim() !== "") {
    costCurrency = isCurrency(source.costCurrency) ? source.costCurrency : base;
    costMinor = parseAmount(String(source.cost), costCurrency);
    if (costMinor === null || costMinor <= 0) {
      return NextResponse.json({ message: "اكتب تكلفة صحيحة أو اتركها فارغة." }, { status: 400 });
    }
    if (!partyId) {
      return NextResponse.json(
        { message: "اختر المختبر من قائمة الجهات لتُسجَّل التكلفة عليه." },
        { status: 400 },
      );
    }
    const rate = rateFromSettings(settings, costCurrency, base);
    if (rate === null) {
      return NextResponse.json({ message: "سعر الصرف غير مضبوط في الإعدادات." }, { status: 409 });
    }
    exchangeRate = rate;
  }

  try {
    const created = await createLabOrder({
      patientId, labName, labPhone, workType, details, sentDate, dueDate, note,
      partyId, costMinor, costCurrency, baseCurrency: base, exchangeRate,
      createdBy: session.username,
    });
    if (!created) return NextResponse.json({ message: "تعذّر حفظ العمل." }, { status: 500 });
    return NextResponse.json(created, { status: 201 });
  } catch {
    // المريض المحذوف أو غير الموجود يسقط على قيد المفتاح الأجنبي.
    return NextResponse.json({ message: "تعذّر حفظ العمل. تأكد من المريض وأعد المحاولة." }, { status: 500 });
  }
}
