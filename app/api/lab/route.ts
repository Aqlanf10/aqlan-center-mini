import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createLabOrder, getSettings, labCounts, listLabNames, listLabOrders, listLabServices, listParties, recordAudit } from "@/lib/db";
import { DEFAULT_LAB_DAYS, PENDING_LAB_NAME } from "@/lib/lab";
import { LabOrderIdentityConflict } from "@/lib/lab-order-identity";
import { LabOrderPricingConflict } from "@/lib/lab-order-pricing";
import { canViewLabFinancials } from "@/lib/lab-financial-visibility";
import { projectLabOrderResponse } from "@/lib/lab-response";
import { canAccessPatient } from "@/lib/patient-access";
import { isCurrency, parseAmount, type Currency, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { toWhatsAppNumber } from "@/lib/reminders";
import { rateFromSettings } from "@/lib/settings";
import { addDays, clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  // Keep this CLINIC endpoint narrower than the shared patient-access helper.
  if (session.role !== "admin" && session.role !== "reception" && session.role !== "doctor") {
    return NextResponse.json({ message: "غير مصرّح لك بعرض أعمال المختبر." }, { status: 403 });
  }
  const url = new URL(request.url);
  const summaryOnly = url.searchParams.get("summary") === "1";
  const withServices = url.searchParams.get("services") === "1";

  const canViewFinancials = await canViewLabFinancials(session);

  try {
    if (summaryOnly) {
      // Existing count-only mode is global, even when patientId/services coexist.
      return NextResponse.json(await labCounts());
    }
    const patientIds = url.searchParams.getAll("patientId");
    let patientId: number | null = null;
    if (patientIds.length > 0) {
      patientId = Number(patientIds[0]);
      // Explicit empty, malformed, ambiguous or out-of-int4 scope never falls back globally.
      if (patientIds.length !== 1 || !/^\d+$/.test(patientIds[0])
        || !Number.isSafeInteger(patientId) || patientId <= 0 || patientId > 2_147_483_647) {
        return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
      }
      if (!await canAccessPatient(session, patientId)) {
        return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على ملف هذا المريض." }, { status: 403 });
      }
    }
    const [rawOrders, labs, labServices] = await Promise.all([
      patientId === null ? listLabOrders() : listLabOrders({ patientId }),
      listLabNames(),
      withServices ? listLabServices() : Promise.resolve([]),
    ]);
    const orders = rawOrders.map((order) => projectLabOrderResponse(order, canViewFinancials));
    return NextResponse.json({ orders, labs, ...(withServices ? { labServices } : {}) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل أعمال المختبر." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }

  /*
   * الطلب السياقي من الإجراء (§١٩): طبيبُ التاج نفّذ الإجراء فيريد طلب المختبر
   * من الزيارة نفسها — بلا نموذج ولا اسم مختبر. يُنشأ «لم يُرسل بعد»، ومن يعمل
   * مع المختبر يكمله من لوحة الأعمال. تاريخه اليوم ومهلته الافتراضية أسبوعًا.
   */
  const visitIdRaw = Number(source.visitId);
  const visitId = Number.isInteger(visitIdRaw) && visitIdRaw > 0 ? visitIdRaw : null;
  const toothCodeRaw = Number(source.toothCode);
  const toothCode = Number.isInteger(toothCodeRaw) && toothCodeRaw > 0 ? toothCodeRaw : null;
  const quickNeeded = source.status === "needed" && visitId !== null;

  const workType = typeof source.workType === "string" ? source.workType.trim() : "";
  if (!workType || workType.length > 80) {
    return NextResponse.json({ message: "اختر نوع العمل." }, { status: 400 });
  }

  const todayISO = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);

  let labName: string;
  let sentDate: string;
  let dueDate: string;
  if (quickNeeded) {
    labName = PENDING_LAB_NAME;
    sentDate = todayISO;
    dueDate = addDays(todayISO, DEFAULT_LAB_DAYS);
  } else {
    labName = typeof source.labName === "string" ? source.labName.trim() : "";
    if (!labName || labName.length > 80) {
      return NextResponse.json({ message: "اكتب اسم المختبر." }, { status: 400 });
    }
    sentDate = typeof source.sentDate === "string" ? source.sentDate : "";
    dueDate = typeof source.dueDate === "string" ? source.dueDate : "";
    if (!DATE_PATTERN.test(sentDate) || !DATE_PATTERN.test(dueDate)) {
      return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
    }
    // موعد تسليم قبل الإرسال يجعل العمل «متأخرًا» لحظة إنشائه، فيسمّم قائمة المتأخر كلها.
    if (dueDate < sentDate) {
      return NextResponse.json({ message: "موعد التسليم قبل تاريخ الإرسال." }, { status: 400 });
    }
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
  // (TD-05) الأساس دستوري من الكود — والإعدادات لأسعار الصرف.
  const base = CLINIC_BASE_CURRENCY;

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

  // الترحيل المحاسبي عند الإنشاء: بند المصروف وحساباه وحالة الترحيل —
  // من نموذج الإرسال للمختبر (المسؤول المالي يحدد البند قبل الإرسال).
  const expenseCategoryIdRaw = Number(source.expenseCategoryId);
  const expenseCategoryId = Number.isInteger(expenseCategoryIdRaw) && expenseCategoryIdRaw > 0
    ? expenseCategoryIdRaw : null;
  const expenseAccountCode = typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim()
    ? source.expenseAccountCode.trim().slice(0, 10) : null;
  const payableAccountCode = typeof source.payableAccountCode === "string" && source.payableAccountCode.trim()
    ? source.payableAccountCode.trim().slice(0, 10) : null;
  const isPosted = source.isPosted !== undefined ? Boolean(source.isPosted) : true;

  // Resolve before committing; permission lookup failure only withholds response metadata.
  const canViewFinancials = await canViewLabFinancials(session);

  try {
    const created = await createLabOrder({
      patientId, labName, labPhone, workType, details, sentDate, dueDate, note,
      partyId, costMinor, costCurrency, baseCurrency: base, exchangeRate,
      createdBy: session.username,
      visitId, toothCode,
      source: source.source === "auto" ? "auto" : "manual",
      status: quickNeeded ? "needed" : "sent",
      /* المختبرات السنية V2: الحقول السريرية الموسّعة — تُقرأ إن وُجدت وصفتها. */
      labServiceId: Number.isInteger(Number(source.labServiceId)) && Number(source.labServiceId) > 0
        ? Number(source.labServiceId) : null,
      doctorId: session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
        ? session.partyId
        : (Number.isInteger(Number(source.doctorId)) && Number(source.doctorId) > 0
          ? Number(source.doctorId) : null),
      toothNumbers: typeof source.toothNumbers === "string" ? source.toothNumbers.slice(0, 120) : null,
      shade: typeof source.shade === "string" ? source.shade.slice(0, 30) : null,
      stumpShade: typeof source.stumpShade === "string" ? source.stumpShade.slice(0, 30) : null,
      priority: source.priority === "urgent" || source.priority === "rush" ? source.priority : "normal",
      impressionType: source.impressionType === "digital_scan" || source.impressionType === "alginate"
        || source.impressionType === "silicone" || source.impressionType === "other"
        ? source.impressionType : "physical",
      technicianName: typeof source.technicianName === "string" && source.technicianName.trim()
        ? source.technicianName.trim().slice(0, 80) : null,
      actorRole: session.role,
      /* الترحيل المحاسبي (بنود المصروفات): البند يحدد الحساب إن غاب الصريح. */
      expenseCategoryId,
      expenseAccountCode,
      payableAccountCode,
      isPosted,
    });
    if (!created) {
      // الفهرس الفريد: سنّ واحد في الزيارة طلبٌ واحد — سؤال ثانٍ للسنّ نفسه ليس خطأ
      // خادم بل عملٌ مسجّل سلفًا.
      if (visitId && toothCode) {
        return NextResponse.json(
          { message: "طلب مختبر مسجَّل سلفًا لهذا السن في هذه الزيارة." },
          { status: 409 },
        );
      }
      return NextResponse.json({ message: "تعذّر حفظ العمل." }, { status: 500 });
    }
    // (TD-06) أمر المختبر يحمل تكلفةً على الذمم — يُسجَّل من أنشأه كما يُسجَّل من مساعد AI.
    await recordAudit({
      action: "lab_order.create", entity: "lab_order", entityId: String(created.id),
      entityLabel: `أمر معمل: ${created.patientName} (${created.labName})`,
      details: {
        العمل: created.workType, الموعد: created.dueDate, المصدر: source.source === "auto" ? "auto" : "manual",
        // التكلفة المحسومة فعلًا (قد تُشتق من جدول تسعير المختبر حين لا تُرسَل صراحةً).
        ...(created.costMinor != null ? { التكلفة: created.costMinor, العملة: created.costCurrency ?? null } : {}),
      },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(projectLabOrderResponse(created, canViewFinancials), { status: 201 });
  } catch (error) {
    if (error instanceof LabOrderIdentityConflict || error instanceof LabOrderPricingConflict) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: 409 });
    }
    return NextResponse.json({ message: "تعذّر حفظ العمل. تأكد من المريض وأعد المحاولة." }, { status: 500 });
  }
}
