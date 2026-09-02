import { NextResponse } from "next/server";
import {
  createLabPricingRule,
  getLaboratory,
  getLabService,
  listLabPricingRules,
  recordAudit,
  resolveLabOrderPrice,
  getPool,
} from "@/lib/db";
import { isCurrency, parseAmount, type Currency } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  const { searchParams } = new URL(request.url);
  const partyIdRaw = searchParams.get("partyId");
  const labServiceIdRaw = searchParams.get("labServiceId");
  const resolve = searchParams.get("resolve") === "1" || searchParams.get("resolve") === "true";
  const dateStr = searchParams.get("date");

  const partyId = partyIdRaw ? Number(partyIdRaw) : undefined;
  const labServiceId = labServiceIdRaw ? Number(labServiceIdRaw) : undefined;

  try {
    // استعلام محدد لتحديد السعر الفعال بتاريخ معين
    if (resolve && partyId && labServiceId) {
      const targetDate = dateStr && DATE_REGEX.test(dateStr) ? dateStr : new Date().toISOString().slice(0, 10);
      const resolved = await resolveLabOrderPrice(partyId, labServiceId, targetDate);
      return NextResponse.json({ resolved });
    }

    const rules = await listLabPricingRules(partyId, labServiceId);
    return NextResponse.json({ rules });
  } catch (error) {
    console.error("Failed to list lab pricing rules:", error);
    return NextResponse.json({ message: "تعذّر تحميل جدول تسعير خدمات المختبرات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة تسعير خدمات المختبرات للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const partyId = Number(source.partyId);
  if (!Number.isInteger(partyId) || partyId <= 0) {
    return NextResponse.json({ message: "يرجى اختيار المختبر أولًا." }, { status: 400 });
  }

  const labServiceId = Number(source.labServiceId);
  if (!Number.isInteger(labServiceId) || labServiceId <= 0) {
    return NextResponse.json({ message: "يرجى اختيار خدمة المختبر من الدليل." }, { status: 400 });
  }

  const costCurrency: Currency = isCurrency(source.costCurrency) ? source.costCurrency : "YER";
  const costMinor = source.costMinor !== undefined
    ? Number(source.costMinor)
    : parseAmount(String(source.cost ?? ""), costCurrency);

  if (costMinor === null || isNaN(costMinor) || costMinor < 0) {
    return NextResponse.json({ message: "يرجى إدخال مبلغ وسعر صالح للخدمة." }, { status: 400 });
  }

  const effectiveFrom = typeof source.effectiveFrom === "string" && DATE_REGEX.test(source.effectiveFrom)
    ? source.effectiveFrom
    : new Date().toISOString().slice(0, 10);

  let effectiveTo: string | null = null;
  if (typeof source.effectiveTo === "string" && source.effectiveTo.trim()) {
    if (!DATE_REGEX.test(source.effectiveTo.trim())) {
      return NextResponse.json({ message: "تاريخ انتهاء السريان غير صالح (الصيغة: YYYY-MM-DD)." }, { status: 400 });
    }
    if (source.effectiveTo.trim() < effectiveFrom) {
      return NextResponse.json({ message: "تاريخ انتهاء السريان يجب ألا يسبق تاريخ التفعيل." }, { status: 400 });
    }
    effectiveTo = source.effectiveTo.trim();
  }

  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300)
    : null;

  try {
    const [lab, service] = await Promise.all([
      getLaboratory(partyId),
      getLabService(labServiceId),
    ]);

    if (!lab) {
      return NextResponse.json({ message: "المختبر المحدد غير موجود." }, { status: 404 });
    }
    if (!service) {
      return NextResponse.json({ message: "خدمة المختبر المحددة غير موجودة في الدليل." }, { status: 404 });
    }

    // إغلاق القاعدة السابقة الفعالة تلقائيًا إذا رغب المستخدم في تحديث السعر اعتباراً من تاريخ التفعيل
    if (source.closePreviousRule === true) {
      await getPool().query(
        `UPDATE lab_pricing_rules
            SET effective_to = ($3::date - INTERVAL '1 day')
          WHERE party_id = $1
            AND lab_service_id = $2
            AND effective_from < $3::date
            AND (effective_to IS NULL OR effective_to >= $3::date)`,
        [partyId, labServiceId, effectiveFrom],
      );
    }

    const created = await createLabPricingRule({
      partyId,
      labServiceId,
      costMinor,
      costCurrency,
      effectiveFrom,
      effectiveTo,
      note,
      createdBy: session.username,
    });

    await recordAudit({
      actor: session.username,
      actorRole: session.role,
      action: "lab_pricing.create",
      entity: "lab_pricing_rule",
      entityId: String(created.id),
      entityLabel: `${lab.name} — ${service.name} (${costMinor} ${costCurrency})`,
      details: {
        id: created.id,
        partyId,
        labName: lab.name,
        labServiceId,
        serviceName: service.name,
        costMinor,
        costCurrency,
        effectiveFrom,
        effectiveTo,
        note,
      },
    });

    return NextResponse.json({ rule: created }, { status: 201 });
  } catch (error) {
    console.error("Failed to create lab pricing rule:", error);
    return NextResponse.json({ message: "تعذّر حفظ قاعدة التسعير للمختبر." }, { status: 500 });
  }
}
