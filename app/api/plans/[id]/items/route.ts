import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { addPlanItem, doctorOwnsPatient, findUserByUsername, getPlanCurrency, getPlanPatientId, getService, getSettings, recordAudit, removePlanItem, updatePlanItem } from "@/lib/db";
import { agreementPricedService, checkInvoiceAuthority, formatPriceOverrides, type InvoicePriceOverride } from "@/lib/invoice-pricing";
import { foreignRatesFromSettings } from "@/lib/service-pricing";
import { canHandleMoney } from "@/lib/roles";
import { CLINIC_BASE_CURRENCY, parseAmount } from "@/lib/money";
import { requireSession } from "@/lib/session";
import type { BillingRule } from "@/lib/plans";

export const dynamic = "force-dynamic";

/**
 * بنود خطة العلاج.
 *
 * السعر يُقرأ من **دليل الخدمات** لا من الطلب: سعرٌ يأتي من المتصفّح سعرٌ يمكن
 * تغييره في المتصفّح. والدليل هو مصدر الحقيقة الوحيد للأسعار في البرنامج كلّه —
 * وهو ما يجعل تعديل السعر مرةً واحدةً في مكانٍ واحد يسري على كل ما بعده.
 *
 * (TD-05 owner review — Finding 2) أسعار الدليل أساسيةٌ (YER). فخطةٌ بعملة
 * اتفاق (SAR/USD) لا يُنسخ إليها سعر الدليل أبدًا — فذلك تحويلٌ صامت بلا سعر
 * صرف يجعل ١٥٬٠٠٠ يمنيّ «١٥٬٠٠٠ دولارًا». البند في الخطة الأجنبية يتطلب سعرًا
 * صريحًا بعملة الخطة نفسها، والخادم يرفض بدونه — حماية الواجهة لا تكفي.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const forbidden = () =>
  NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });

const planIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/** رقمٌ صحيح ضمن حدود — قاعدة الفوترة والجلسات والزيارات المخطَّطة أرقامٌ صغيرة. */
function normalizeCount(value: unknown, min: number, max: number): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return undefined;
  return Math.min(max, Math.max(min, num));
}

function billingRuleFrom(value: unknown): BillingRule {
  return value === "per_session" || value === "on_start" || value === "package"
    ? value
    : "on_completion";
}

function doctorIdFrom(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

/** صلاحيات الوكيل المساعد: الطبيب يعدّل بنود خطط مرضاه فقط إن فتح المدير له
 * التحديد — والأسعار تُفرض من الدليل كما هي في V2، لا من الطلب أبدًا. */
async function doctorBlockedForPlan(session: { username: string; role: string; partyId?: number | null }, planId: number): Promise<string | null> {
  if (session.role !== "doctor") return null;
  const user = await findUserByUsername(session.username).catch(() => null);
  if (user?.permissions && user.permissions.canEditPlans === false) {
    return "غير مصرّح لك بإضافة أو تعديل بنود خطة العلاج.";
  }
  const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
  if (!doctorPartyId) return "خطط العلاج للإدارة والاستقبال.";
  const patientId = await getPlanPatientId(planId).catch(() => null);
  if (patientId === null) return "رقم الخطة غير صالح.";
  const owns = await doctorOwnsPatient(doctorPartyId, patientId).catch(() => false);
  if (!owns) return "غير مصرّح لك بتعديل بنود خطة هذا المريض.";
  return null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();

  const planId = await planIdFrom(context);
  if (!planId) return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });

  const doctorBlocked = await doctorBlockedForPlan(session, planId);
  if (doctorBlocked) return NextResponse.json({ message: doctorBlocked }, { status: 403 });
  if (session.role !== "doctor" && !canHandleMoney(session.role)) return forbidden();

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const serviceId = Number(source.serviceId);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return NextResponse.json({ message: "اختر الخدمة من الدليل." }, { status: 400 });
  }

  const quantity = Math.round(Number(source.quantity ?? 1));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) {
    return NextResponse.json({ message: "العدد بين 1 و99." }, { status: 400 });
  }

  const toothCode = source.toothCode === null || source.toothCode === undefined || source.toothCode === ""
    ? null : Number(source.toothCode);
  if (toothCode !== null && !Number.isInteger(toothCode)) {
    return NextResponse.json({ message: "رقم السن غير صالح." }, { status: 400 });
  }

  try {
    const service = await getService(serviceId);
    if (!service) return NextResponse.json({ message: "الخدمة غير موجودة في الدليل." }, { status: 404 });

    /* (TD-05 owner review — Finding 2) عملة الخطة تُقرأ من الخطة نفسها في
     * الخادم: الخطة الأساسية يبقى لها سعر الدليل، والخطة بعملة اتفاق يتطلب
     * بندَها سعرًا صريحًا بعملتها — لا يُنسخ، ولا يُحوَّل بسعر اليوم أبدًا. */
    const planCurrency = await getPlanCurrency(planId);
    if (!planCurrency) return NextResponse.json({ message: "الخطة غير موجودة." }, { status: 404 });

    let unitPriceMinor: number;
    let overrides: InvoicePriceOverride[] = [];
    if (planCurrency === CLINIC_BASE_CURRENCY) {
      unitPriceMinor = service.priceMinor;
    } else {
      const priceRaw = source.price;
      if (priceRaw === undefined || priceRaw === null || String(priceRaw).trim() === "") {
        return NextResponse.json(
          {
            message: `سعر البند بعملة الخطة (${planCurrency}) إلزامي — سعر الدليل بالعملة الأساسية لا يُنسخ إلى خطة بعملة اتفاق.`,
          },
          { status: 400 },
        );
      }
      const explicit = parseAmount(String(priceRaw), planCurrency);
      if (explicit === null || explicit <= 0) {
        return NextResponse.json(
          { message: `اكتب سعرًا صحيحًا أكبر من صفر بعملة الخطة (${planCurrency}).` },
          { status: 400 },
        );
      }
      unitPriceMinor = explicit;
      /* (FIN-5) السعر المكتوب بعملة الاتفاق يُقارن بسعر الدليل بها (سعرها الخاص أو المحوَّل)
         — الخصم بسببٍ وفي الحد لغير المدير، والرفع للمدير — كالزيارة والفاتورة. */
      const settings = await getSettings();
      const authority = checkInvoiceAuthority({
        lines: [{
          description: service.name, service: agreementPricedService(service, planCurrency), requestedMinor: explicit, quantity, explicit: true,
          reason: typeof source.priceReason === "string" ? source.priceReason : null,
        }],
        currency: planCurrency,
        rates: foreignRatesFromSettings(settings),
        role: session.role,
        maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
        totalMinor: explicit * quantity,
        discountMinor: 0,
        discountReason: null,
      });
      if (!authority.ok) return NextResponse.json({ message: authority.message }, { status: 400 });
      overrides = authority.overrides;
    }

    const result = await addPlanItem({
      planId,
      serviceId: service.id,
      serviceName: service.name,
      category: service.category,
      toothCode,
      surfaces: typeof source.surfaces === "string" ? source.surfaces : null,
      quantity,
      unitPriceMinor,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      /* تنظيم الجلسات: الزيارة المخطَّطة وقاعدة الفوترة وعدد الجلسات وطبيب البند. */
      plannedVisitNumber: normalizeCount(source.plannedVisitNumber, 1, 30),
      billingRule: billingRuleFrom(source.billingRule),
      sessionCount: normalizeCount(source.sessionCount, 1, 30),
      doctorId: doctorIdFrom(source.doctorId),
    });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    if (overrides.length > 0) {
      await recordAudit({
        action: "plan.price_override", entity: "treatment_plan", entityId: planId,
        entityLabel: service.name,
        details: { العملة: planCurrency, أسعار_معدلة: formatPriceOverrides(overrides) },
        actor: session.username, actorRole: session.role,
      });
    }
    return NextResponse.json({ totalMinor: result.totalMinor }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إضافة البند." }, { status: 500 });
  }
}

/** تحديث بند خطة: توزيع الجلسات — الزيارة المخطَّطة وقاعدة الفوترة والجلسات
 * والطبيب والملاحظة. تنظيميٌ لا مالي: لا يغيّر السعر ولا الكمية ولا الحالة. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();

  const planId = await planIdFrom(context);
  if (!planId) return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });

  const doctorBlocked = await doctorBlockedForPlan(session, planId);
  if (doctorBlocked) return NextResponse.json({ message: doctorBlocked }, { status: 403 });
  if (session.role !== "doctor" && !canHandleMoney(session.role)) return forbidden();

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const itemId = Number(source.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });
  }

  try {
    const result = await updatePlanItem({
      planId,
      itemId,
      plannedVisitNumber: source.plannedVisitNumber !== undefined
        ? normalizeCount(source.plannedVisitNumber, 1, 30) : undefined,
      billingRule: source.billingRule !== undefined ? billingRuleFrom(source.billingRule) : undefined,
      sessionCount: source.sessionCount !== undefined
        ? normalizeCount(source.sessionCount, 1, 30) : undefined,
      doctorId: source.doctorId !== undefined ? doctorIdFrom(source.doctorId) : undefined,
      note: source.note !== undefined
        ? (typeof source.note === "string" ? source.note.slice(0, 300) : null) : undefined,
      actor: session.username,
      actorRole: session.role,
    });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر تحديث البند." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();

  const planId = await planIdFrom(context);
  if (!planId) return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });

  const doctorBlocked = await doctorBlockedForPlan(session, planId);
  if (doctorBlocked) return NextResponse.json({ message: doctorBlocked }, { status: 403 });
  if (session.role !== "doctor" && !canHandleMoney(session.role)) return forbidden();

  const itemId = Number(new URL(request.url).searchParams.get("itemId"));
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });
  }

  try {
    const result = await removePlanItem(planId, itemId, { actor: session.username, actorRole: session.role });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف البند." }, { status: 500 });
  }
}
