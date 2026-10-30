import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { visitMaterialMovements, visitPatientOf } from "@/lib/db";
import { listVisitMaterialReturns, returnVisitMaterial } from "@/lib/inventory-visit-returns";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P4 + INV-02) المواد المصروفة والمرتجعة على الزيارة من inventory_movements.
 * التلقائية (ربط الخدمة بالمادة عند التوقيع) واليدوية (يسجلها الطبيب عبر حركة الصرف القائمة
 * `POST /api/inventory/[id]/movements` بـ visitId)، وردّ الفائض أو التالف عبر `POST` هنا
 * بحركة عكسية موثّقة (`kind='in', is_return=true`) — لا جدول موادٍ ثانٍ.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const visitId = Number((await context.params).id);
  if (!Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }
  try {
    const visit = await visitPatientOf(visitId);
    if (!visit) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    }
    /* كقراءة الزيارة نفسها: زيارة مريضٍ ليس من مرضى الطبيب لا تُفتح، والزيارة الحرّة مفتوحة. */
    if (visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))) {
      return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على مواد هذه الزيارة." }, { status: 403 });
    }
    const [lines, returns] = await Promise.all([
      visitMaterialMovements(visitId),
      listVisitMaterialReturns(visitId),
    ]);
    return NextResponse.json({ patientId: visit.patientId, lines, returns });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل مواد الزيارة." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (session.role !== "admin" && session.role !== "reception" && session.role !== "doctor") {
    return NextResponse.json({ message: "ردّ مواد الزيارة للطبيب أو الإدارة أو الاستقبال." }, { status: 403 });
  }
  const visitId = Number((await context.params).id);
  if (!Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const itemId = Number(source.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0 || itemId > 2_147_483_647) {
    return NextResponse.json({ message: "رقم المادة غير صالح." }, { status: 400 });
  }
  const qty = Number(source.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) {
    return NextResponse.json({ message: "اكتب كمية صالحة أكبر من صفر." }, { status: 400 });
  }
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 200) : null;

  try {
    const visit = await visitPatientOf(visitId);
    if (!visit) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    }
    if (visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))) {
      return NextResponse.json({ message: "غير مصرّح لك بتعديل مواد هذه الزيارة." }, { status: 403 });
    }
    const result = await returnVisitMaterial({
      visitId,
      itemId,
      qty,
      reason,
      createdBy: session.username,
    });
    if (!result.ok) {
      return NextResponse.json({ message: result.message }, { status: result.status });
    }
    return NextResponse.json({ ok: true, balance: result.balance, movementId: result.movement.id }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل ردّ المادة للمخزن." }, { status: 500 });
  }
}
