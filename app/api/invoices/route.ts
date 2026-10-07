import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, listParties, listPatientInvoices, listServices } from "@/lib/db";
import { createLinkedInvoice, type LinkedInvoiceLineInput } from "@/lib/invoice-linkage-db";
import {
  INVOICE_IDEMPOTENCY_PATTERN, INVOICE_LINKAGE_MESSAGE, invoiceRequestFingerprint, linkageRefusalStatus, parseLineSiteFields,
} from "@/lib/invoice-clinical-linkage";
import { effectiveTemplates } from "@/lib/specialty-templates";
import { checkInvoiceAuthority, formatPriceOverrides, type InvoiceLineAuthorityInput } from "@/lib/invoice-pricing";
import { foreignRatesFromSettings } from "@/lib/service-pricing";
import { isCurrency, parseAmount, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { canHandleMoney, canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listPatientInvoices(patientId));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الفواتير." }, { status: 500 });
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

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }

  /* (TD-05) عملة الفاتورة من الطلب — YER/SAR/USD بحسب اتفاق المريض،
     والافتراضي هو العملة الأساسية. وعملةٌ غير معروفة تُرفض لا تُبدَّل بصمت. */
  if (source.currency !== undefined && source.currency !== null
    && String(source.currency).trim() !== "" && !isCurrency(source.currency)) {
    return NextResponse.json({ message: "عملة الفاتورة يجب أن تكون YER أو SAR أو USD." }, { status: 400 });
  }
  const base = isCurrency(source.currency) ? source.currency : CLINIC_BASE_CURRENCY;

  const rawItems = Array.isArray(source.items) ? source.items : [];
  if (rawItems.length === 0 || rawItems.length > 40) {
    return NextResponse.json({ message: "أضف بندًا واحدًا على الأقل." }, { status: 400 });
  }

  // الأسعار تُقرأ من قائمة الأسعار حين يُختار منها بند، ومن الطلب حين يُكتب مبلغ
  // يدويًا. والوصف يُؤخذ من الخدمة نفسها لا من الواجهة، فلا تُطبع فاتورة باسم خدمة
  // وسعرِ أخرى.
  const services = new Map((await listServices(true)).map((service) => [service.id, service]));

  // الأطباء المسجّلون: بندٌ يشير إلى جهةٍ ليست طبيبًا يُرفض، وإلا نُسبت عمولة إلى
  // مختبر أو مورّد.
  const doctors = new Set((await listParties("doctor")).map((party) => party.id));

  /* (INV-LINK B) مفتاح الإعادة: نقرةٌ مزدوجة أو ردٌّ ضائع يعيد الفاتورة نفسها لا فاتورةً ثانية. */
  const idempotencyKey = typeof source.idempotencyKey === "string" && source.idempotencyKey.trim()
    ? source.idempotencyKey.trim() : null;
  if (idempotencyKey !== null && !INVOICE_IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    return NextResponse.json({ message: "مفتاح الطلب غير صالح." }, { status: 400 });
  }

  const items: LinkedInvoiceLineInput[] = [];
  /* (FIN-4) ما تحتاجه سلطة السعر لكل بند: خدمة الدليل، وهل كُتب السعر، وسببه. */
  const authorityLines: InvoiceLineAuthorityInput[] = [];
  for (const raw of rawItems as Record<string, unknown>[]) {
    const quantity = Math.max(1, Math.round(Number(raw.quantity ?? 1)));
    if (!Number.isFinite(quantity) || quantity > 999) {
      return NextResponse.json({ message: "الكمية غير منطقية." }, { status: 400 });
    }

    const serviceId = Number(raw.serviceId);
    const service = Number.isInteger(serviceId) ? services.get(serviceId) : undefined;

    const description = service
      ? service.name
      : typeof raw.description === "string" ? raw.description.trim().slice(0, 160) : "";
    if (!description) {
      return NextResponse.json({ message: "اكتب وصف البند." }, { status: 400 });
    }

    const priceRaw = raw.price;
    let unitPriceMinor: number | null;
    if (priceRaw === undefined || String(priceRaw).trim() === "") {
      /* (TD-05 owner review — Finding 3) سقوط سعر الدليل مسموحٌ للفاتورة
       * الأساسية وحدها — فاتورةُ عملة اتفاق (SAR/USD) بلا سعرٍ صريحٍ بعملتها
       * تُرفض بوضوح: سعر الدليل يمنيّ، ونسخه إليها فسادٌ مالي صامت. الحماية
       * في الخادم لا في الواجهة — فالمسار المباشر لا يمرّ بواجهة أصلًا. */
      if (base !== CLINIC_BASE_CURRENCY) {
        return NextResponse.json(
          {
            message: `سعر البند «${description}» بعملة الفاتورة (${base}) إلزامي — سعر الدليل بالعملة الأساسية لا يدخل فاتورةً بعملة اتفاق.`,
          },
          { status: 400 },
        );
      }
      unitPriceMinor = service ? service.priceMinor : null;
    } else {
      unitPriceMinor = parseAmount(String(priceRaw), base);
    }
    if (unitPriceMinor === null) {
      return NextResponse.json({ message: `اكتب سعرًا صحيحًا لبند «${description}».` }, { status: 400 });
    }

    const doctorIdRaw = Number(raw.doctorId);
    const doctorId = Number.isInteger(doctorIdRaw) && doctors.has(doctorIdRaw) ? doctorIdRaw : null;
    if (raw.doctorId !== undefined && String(raw.doctorId).trim() !== "" && doctorId === null) {
      return NextResponse.json({ message: "الطبيب المختار غير مسجّل." }, { status: 400 });
    }

    /* (INV-LINK B) السنّ والحالة والجلسات للبند العلاجي — اختيارية؛ والخاطئ يُرفض لا يُسقط صامتًا. */
    const optionalInt = (value: unknown, min: number, max: number): number | null | undefined => {
      if (value === undefined || value === null || String(value).trim() === "") return null;
      const number = Number(value);
      return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
    };
    const toothCode = optionalInt(raw.toothCode, 11, 85);
    const caseId = optionalInt(raw.caseId, 1, 2_147_483_647);
    const sessions = optionalInt(raw.sessions, 1, 60);
    if (toothCode === undefined) return NextResponse.json({ message: "رقم السن غير صحيح بالترقيم الدولي." }, { status: 400 });
    if (caseId === undefined) return NextResponse.json({ message: "الحالة المختارة غير صالحة." }, { status: 400 });
    if (sessions === undefined) return NextResponse.json({ message: "عدد جلسات البند بين ١ و٦٠." }, { status: 400 });
    /* (INV-LINK TOOTH) أسطح الحشوة، أسنان حلقة التاج/الجسر، ونطاق التقويم/اللثة — كما اختيرت من مخطط الأسنان. */
    const siteFields = parseLineSiteFields(raw);
    if (!siteFields) return NextResponse.json({ message: "بيانات موضع البند (الأسنان/الأسطح/النطاق) غير صالحة." }, { status: 400 });

    items.push({
      serviceId: service ? service.id : null, category: service?.category ?? null, doctorId, description, quantity,
      unitPriceMinor, toothCode, caseId, sessions, ...siteFields,
    });
    authorityLines.push({
      description, service: service ?? null, requestedMinor: unitPriceMinor, quantity,
      explicit: !(priceRaw === undefined || String(priceRaw).trim() === ""),
      reason: typeof raw.priceReason === "string" ? raw.priceReason : null,
    });
  }

  const discountMinor = source.discount === undefined || String(source.discount).trim() === ""
    ? 0 : parseAmount(String(source.discount), base);
  if (discountMinor === null) {
    return NextResponse.json({ message: "اكتب خصمًا صحيحًا." }, { status: 400 });
  }

  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  /* (FIN-4) حدّ الخصم نفسه الذي يحكم الزيارة: سعر خدمة الدليل المكتوب أقل، والخصم على
     الفاتورة — بسببٍ مكتوب، ولغير المدير حتى `billing.max_discount_percent`. */
  const settings = await getSettings();
  const authority = checkInvoiceAuthority({
    lines: authorityLines,
    currency: base,
    rates: foreignRatesFromSettings(settings),
    role: session.role,
    maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
    totalMinor: items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0),
    discountMinor,
    discountReason: typeof source.discountReason === "string" ? source.discountReason : null,
  });
  if (!authority.ok) {
    return NextResponse.json({ message: authority.message }, { status: 400 });
  }

  try {
    const result = await createLinkedInvoice({
      patientId, baseCurrency: base, discountMinor, note, createdBy: session.username, actorRole: session.role, items,
      templates: effectiveTemplates(settings["plans.specialty_templates"]).templates,
      idempotencyKey,
      requestHash: idempotencyKey ? invoiceRequestFingerprint({ patientId, currency: base, discountMinor, note, items }) : null,
      auditDetails: {
        ...(authority.discount ? { سبب_الخصم: authority.discount.reason, نسبة_الخصم: authority.discount.percent } : {}),
        ...(authority.overrides.length ? { أسعار_معدلة: formatPriceOverrides(authority.overrides) } : {}),
      },
    });
    if (!result.ok) {
      if (result.reason === "no_patient") return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
      const prefix = result.line !== null ? `البند ${result.line + 1}: ` : "";
      const status = linkageRefusalStatus(result.reason);
      return NextResponse.json({ message: prefix + INVOICE_LINKAGE_MESSAGE[result.reason] }, { status });
    }
    return NextResponse.json(
      { ...result.invoice, clinical: { planId: result.planId, links: result.links }, replayed: result.replayed },
      { status: result.replayed ? 200 : 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء الفاتورة. أعد المحاولة." }, { status: 500 });
  }
}
