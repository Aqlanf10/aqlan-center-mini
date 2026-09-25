import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getService, recordAudit, updateService } from "@/lib/db";
import { SERVICE_AUDIT_FIELDS, auditChanges } from "@/lib/audit-diff";
import { parseAmount, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تعديل الأسعار للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الخدمة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patch: { name?: string; category?: string | null; priceMinor?: number; isActive?: boolean } = {};

  if (typeof source.name === "string") {
    const name = source.name.trim();
    if (!name || name.length > 120) {
      return NextResponse.json({ message: "اكتب اسم الخدمة." }, { status: 400 });
    }
    patch.name = name;
  }
  if (typeof source.category === "string") {
    patch.category = source.category.trim().slice(0, 60) || null;
  }
  if (source.price !== undefined) {
    // (TD-05) الأساس دستوري من الكود — دليل الأسعار بعملته الأساسية.
    const base = CLINIC_BASE_CURRENCY;
    const priceMinor = parseAmount(String(source.price), base);
    if (priceMinor === null) {
      return NextResponse.json({ message: "اكتب سعرًا صحيحًا." }, { status: 400 });
    }
    patch.priceMinor = priceMinor;
  }
  if (typeof source.isActive === "boolean") patch.isActive = source.isActive;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحدَّث." }, { status: 400 });
  }

  try {
    const before = await getService(id);
    const updated = await updateService(id, patch);
    if (!updated) return NextResponse.json({ message: "الخدمة غير موجودة." }, { status: 404 });
    // (P1-4) «من رفع سعر هذه الخدمة ومتى؟» — السعر قبل وبعد في سجل التدقيق.
    const changes = auditChanges(
      before as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
      SERVICE_AUDIT_FIELDS,
    );
    if (Object.keys(changes).length > 0) {
      await recordAudit({
        action: "service.update",
        entity: "service", entityId: id, entityLabel: updated.name,
        details: changes,
        actor: session.username, actorRole: session.role,
      });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
  }
}
