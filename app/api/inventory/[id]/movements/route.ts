import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createInventoryMovement, getSettings } from "@/lib/db";
import { isMovementKind } from "@/lib/inventory";
import { isCurrency, parseAmount } from "@/lib/money";
import { canManageInventory } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * حركة على بند — إدخالٌ أو صرفٌ أو تسوية.
 *
 * الصلاحيات مقسومة بحسب خطر الحركة: الصرفُ للجميع (الطبيب يستهلك وهو يعمل)،
 * والإدخالُ والتسوية للمدير والاستقبال — فالتسوية هي ما يغيّر الرصيد بلا ورقة،
 * وصاحبها من يحاسب على الجرد. وسببُ التسوية إلزامي هنا قبل أن يصل إلى القاعدة:
 * الدستور يمنع تسوية بلا مبرر موثَّق.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const { id: rawId } = await context.params;
  const itemId = Number(rawId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  if (!isMovementKind(source.kind)) {
    return NextResponse.json({ message: "نوع الحركة غير معروف." }, { status: 400 });
  }
  const kind = source.kind;
  if (!canManageInventory(session.role) && kind !== "out") {
    return NextResponse.json(
      { message: "الإدخال والتسوية للمدير والاستقبال — والطبيب يسجّل استهلاكه." },
      { status: 403 },
    );
  }

  const qty = Number(source.qty);
  if (!Number.isFinite(qty) || (kind !== "adjust" && qty <= 0) || (kind === "adjust" && qty === 0)) {
    return NextResponse.json({ message: "اكتب كمية غير صفرية." }, { status: 400 });
  }
  if (Math.abs(qty) > 1_000_000) {
    return NextResponse.json({ message: "الكمية خارج المدى المعقول." }, { status: 400 });
  }

  const reason = typeof source.reason === "string" && source.reason.trim()
    ? source.reason.trim().slice(0, 300) : null;
  if (kind === "adjust" && !reason) {
    return NextResponse.json(
      { message: "سبب التسوية إلزامي — اكتب مبرر الجرد (نقص، تلف، تصحيح إحصاء...)." },
      { status: 400 },
    );
  }
  const expiryDate = typeof source.expiryDate === "string" && DATE_PATTERN.test(source.expiryDate)
    ? source.expiryDate : null;
  /* ثمن الوحدة للشراء (من مستودع الوكيل الآخر) — للمدير والاستقبال الذين
     يسجّلون الإدخال، وللطبيب أن يسجّل استهلاكه بلا أثمان. والقيمة تُشتقّ منه
     بالمتوسّط المرجّح، فلا تُكتب التكلفة إلا مع الشراء. وبالعملة الأساسية
     من الإعدادات — فالثمن لحظةَ الشراء لا بسعر اليوم. */
  const settings = await getSettings();
  const baseCurrency = isCurrency(settings["finance.base_currency"])
    ? settings["finance.base_currency"] : "YER";
  const unitCost = kind === "in" && canManageInventory(session.role)
    && typeof source.unitCost === "string" && source.unitCost.trim() !== ""
    ? parseAmount(source.unitCost, baseCurrency) : null;
  if (kind === "in" && typeof source.unitCost === "string"
      && source.unitCost.trim() !== "" && unitCost === null) {
    return NextResponse.json({ message: "ثمن الوحدة رقمٌ غير صالح." }, { status: 400 });
  }
  const isReturn = kind === "in" && source.isReturn === true;
  const visitIdRaw = Number(source.visitId);
  const visitId = Number.isInteger(visitIdRaw) && visitIdRaw > 0 ? visitIdRaw : null;
  const patientIdRaw = Number(source.patientId);
  const patientId = Number.isInteger(patientIdRaw) && patientIdRaw > 0 ? patientIdRaw : null;
  if (patientId && !(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بربط حركة المواد بهذا المريض." }, { status: 403 });
  }

  try {
    const result = await createInventoryMovement({
      itemId, kind, qty, expiryDate, reason, visitId, patientId, createdBy: session.username,
      unitCostMinor: unitCost,
      isReturn,
    });
    if (!result.ok) {
      return NextResponse.json({ message: result.message }, { status: 409 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الحركة. أعد المحاولة." }, { status: 500 });
  }
}
