import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { AUTO_MATERIAL_REASON_PREFIX, createInventoryMovement, visitPatientOf } from "@/lib/db";
import { isMovementKind } from "@/lib/inventory";
import { parseAmount, CLINIC_BASE_CURRENCY, type Currency } from "@/lib/money";
import { inventoryMovementForRead } from "@/lib/inventory-domain/presentation";
import { canHandleMoney, canManageInventory, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { createInventoryPurchase } from "@/lib/inventory-purchase-db";
import { normalizePurchaseReason, canonicalPurchaseRequest, INVENTORY_PURCHASE_KEY_HEADER, isPurchaseKey, isPurchaseRecord, purchaseEnvelope, isUnwrappedFinancialPurchase } from "@/lib/inventory-purchase-protocol";

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
  if (!Number.isInteger(itemId) || itemId <= 0 || itemId > 2_147_483_647) {
    return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const requestKey = request.headers.get(INVENTORY_PURCHASE_KEY_HEADER);
  const envelope = purchaseEnvelope(body);
  const keyed = requestKey !== null || (isPurchaseRecord(body) && Object.hasOwn(body, "protocol"));
  if (keyed && (!isPurchaseKey(requestKey) || !envelope)) {
    return NextResponse.json({ message: "صيغة طلب الشراء المحمي غير صالحة. حدّث الصفحة دون حذف الطلب المحفوظ." }, { status: 400 });
  }
  if (keyed && (request.headers.get("X-Purchase-Actor") !== encodeURIComponent(session.username)
    || request.headers.get("X-Purchase-Actor-Id") !== String(session.userId))) {
    // This is only a principal expectation, never an authentication credential.
    return NextResponse.json({ message: "تغيّرت جلسة المستخدم. عد إلى الحساب الذي أنشأ الطلب المحفوظ." }, { status: 409 });
  }
  if (keyed && envelope) {
    try { canonicalPurchaseRequest(itemId, envelope); } catch {
      return NextResponse.json({ message: "طلب الشراء يحتوي قيمة غير صالحة." }, { status: 400 });
    }
  }
  const source = envelope ?? (isPurchaseRecord(body) ? body : {});
  if (!keyed && isUnwrappedFinancialPurchase(source)) {
    return NextResponse.json({ message: "يلزم تحديث الصفحة لتسجيل الشراء بطلب محمي من التكرار." }, { status: 409 });
  }
  const refuse = async (message: string, status: 400 | 404 | 409 = 400) => {
    if (!keyed || !requestKey || !envelope) return NextResponse.json({ message }, { status });
    try {
      const rejected = await createInventoryPurchase({ session, requestKey, itemId, purchase: envelope,
        rejection: { message, httpStatus: status } });
      return NextResponse.json(rejected.body, { status: rejected.httpStatus });
    } catch {
      return NextResponse.json({ message: "تعذّر تأكيد نتيجة الطلب. أعد محاولة الطلب المحفوظ نفسه." }, { status: 500 });
    }
  };

  if (!isMovementKind(source.kind)) {
    return refuse("نوع الحركة غير معروف.");
  }
  const kind = source.kind;
  if (!canManageInventory(session.role) && kind !== "out") {
    return NextResponse.json(
      { message: "الإدخال والتسوية للمدير والاستقبال — والطبيب يسجّل استهلاكه." },
      { status: 403 },
    );
  }

  if (keyed && source.unitCost !== undefined && source.unitCost !== null && typeof source.unitCost !== "string") {
    return refuse("ثمن الوحدة رقمٌ غير صالح.");
  }
  if (keyed && [source.expiryDate, source.supplierDueDate].some(value => {
    if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value;
  })) return refuse("تاريخ الشراء غير صالح.");

  if (keyed && typeof source.qty !== "number" && typeof source.qty !== "string") {
    return refuse("اكتب كمية غير صفرية.");
  }
  const qty = Number(source.qty);
  if (!Number.isFinite(qty) || (kind !== "adjust" && qty <= 0) || (kind === "adjust" && qty === 0)) {
    return refuse("اكتب كمية غير صفرية.");
  }
  if (Math.abs(qty) > 1_000_000) {
    return refuse("الكمية خارج المدى المعقول.");
  }

  const reason = keyed ? normalizePurchaseReason(source.reason)
    : typeof source.reason === "string" && source.reason.trim() ? source.reason.trim().slice(0, 300) : null;
  if (keyed && reason?.includes("\u0000")) return refuse("سبب الشراء يحتوي محرفًا غير صالح.");
  if (kind === "adjust" && !reason) {
    return refuse("سبب التسوية إلزامي — اكتب مبرر الجرد (نقص، تلف، تصحيح إحصاء...).");
  }
  const expiryDate = typeof source.expiryDate === "string" && DATE_PATTERN.test(source.expiryDate)
    ? source.expiryDate : null;
  /* ثمن الوحدة للشراء (من مستودع الوكيل الآخر) — للمدير والاستقبال الذين
     يسجّلون الإدخال، وللطبيب أن يسجّل استهلاكه بلا أثمان. والقيمة تُشتقّ منه
     بالمتوسّط المرجّح، فلا تُكتب التكلفة إلا مع الشراء. وبالعملة الأساسية
     من الإعدادات — فالثمن لحظةَ الشراء لا بسعر اليوم. */
  // (TD-05) الأساس دستوري من الكود.
  const baseCurrency: Currency = CLINIC_BASE_CURRENCY;
  const unitCost = kind === "in" && canManageInventory(session.role)
    && typeof source.unitCost === "string" && source.unitCost.trim() !== ""
    ? parseAmount(source.unitCost, baseCurrency) : null;
  if (kind === "in" && typeof source.unitCost === "string"
      && source.unitCost.trim() !== "" && unitCost === null) {
    return refuse("ثمن الوحدة رقمٌ غير صالح.");
  }
  const isReturn = kind === "in" && source.isReturn === true;
  if (reason?.startsWith(AUTO_MATERIAL_REASON_PREFIX.trim())) {
    return refuse("هذا الوسم محجوز للخصم التلقائي من ربط الخدمات — اكتب سببًا آخر.");
  }
  const visitIdRaw = Number(source.visitId);
  const visitId = Number.isInteger(visitIdRaw) && visitIdRaw > 0 ? visitIdRaw : null;
  const patientIdRaw = Number(source.patientId);
  let patientId = Number.isInteger(patientIdRaw) && patientIdRaw > 0 ? patientIdRaw : null;
  /* (P4) الزيارة تحدد مريضها: حركةٌ على زيارةٍ تُربط بمريضها هو، ومريضٌ آخر في الطلب يُرفض —
     فلا تُنسب مادةٌ إلى زيارة مريضٍ لا يملك المستخدم ملفه. */
  if (visitId !== null) {
    if (kind !== "out") {
      return NextResponse.json({ message: "الزيارة تُربط بصرف المواد وحده." }, { status: 400 });
    }
    let visit: { patientId: number | null } | null;
    try {
      visit = await visitPatientOf(visitId);
    } catch {
      return NextResponse.json({ message: "تعذّر التحقق من بيانات الزيارة. أعد المحاولة." }, { status: 500 });
    }
    if (!visit) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    }
    /* الزيارة الحرّة بلا ملف بعد: تُربط بالزيارة وحدها، ويلحقها مريضها حين يُفتح ملفه. */
    if (visit.patientId !== null) {
      if (patientId !== null && patientId !== visit.patientId) {
        return NextResponse.json({ message: "الزيارة لا تخص هذا المريض." }, { status: 400 });
      }
      patientId = visit.patientId;
    } else if (patientId !== null) {
      return NextResponse.json({ message: "الزيارة لا تخص هذا المريض." }, { status: 400 });
    }
  }
  if (patientId) {
    let allowed = false;
    try {
      allowed = await canAccessPatient(session, patientId);
    } catch {
      return NextResponse.json({ message: "تعذّر التحقق من صلاحية ملف المريض. أعد المحاولة." }, { status: 500 });
    }
    if (!allowed) {
      return NextResponse.json({ message: "غير مصرّح لك بربط حركة المواد بهذا المريض." }, { status: 403 });
    }
  }

  /* (P2-10) مورّد الشراء: فاتورته تولد مع الإدخال. التزامٌ ماليٌّ فهو لمن يتعامل
     مع المال وحده، كسائر المستحقات. */
  const supplierRaw = source.supplierPartyId;
  let supplierPartyId: number | null = null;
  // Only an explicit empty choice may omit the payable. Malformed supplied
  // IDs must not silently become a stock-only purchase or coerce to another party.
  if (supplierRaw !== undefined && supplierRaw !== null && supplierRaw !== "") {
    const parsedSupplier = typeof supplierRaw === "number" ? supplierRaw
      : typeof supplierRaw === "string" && !/[^0-9]/.test(supplierRaw) ? Number(supplierRaw) : NaN;
    if (!Number.isInteger(parsedSupplier) || parsedSupplier <= 0 || parsedSupplier > 2_147_483_647) {
      return refuse("رقم المورّد غير صالح.");
    }
    supplierPartyId = parsedSupplier;
  }
  if (supplierPartyId !== null && !canHandleMoney(session.role)) {
    return NextResponse.json({ message: "تسجيل فاتورة المورّد للإدارة والاستقبال." }, { status: 403 });
  }
  const supplierDueDate = typeof source.supplierDueDate === "string" && DATE_PATTERN.test(source.supplierDueDate)
    ? source.supplierDueDate : null;

  try {
    const input = {
      itemId, kind, qty, expiryDate, reason, visitId, patientId, createdBy: session.username,
      unitCostMinor: unitCost, isReturn, supplierPartyId, supplierDueDate,
    };
    if (keyed && requestKey && envelope) {
      const result = await createInventoryPurchase({ session, requestKey, itemId, purchase: envelope, input });
      return NextResponse.json(result.body, { status: result.httpStatus });
    }
    const result = await createInventoryMovement(input);
    if (!result.ok) {
      return NextResponse.json({ message: result.message }, { status: 409 });
    }
    return NextResponse.json({ ...result, movement: inventoryMovementForRead(result.movement, isAdmin(session.role)) }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الحركة. أعد المحاولة." }, { status: 500 });
  }
}
