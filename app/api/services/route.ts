import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createService, findUserByUsername, listServices, recordAudit } from "@/lib/db";
import { SERVICE_AUDIT_FIELDS, auditSnapshot } from "@/lib/audit-diff";
import { parseAmount, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  /* صلاحيات الوكيل المساعد: لائحة الأسعار من «المالية المخفية» — الطبيب يراها
     بتصريح المدير فقط (بعض المراكز تُبعد أسعارها عن أطبائها المتعاونين). */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!user?.permissions?.canViewServicePrices) {
      return NextResponse.json(
        { message: "لائحة أسعار الخدمات مخفية بحسب إعدادات الصلاحيات." },
        { status: 403 },
      );
    }
  } else if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const includeInactive = new URL(request.url).searchParams.get("all") === "1";
  try {
    return NextResponse.json(await listServices(includeInactive));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قائمة الأسعار." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  // قائمة الأسعار تحكم كل فاتورة بعدها، فتحريرها للمدير وحده.
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تعديل الأسعار للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ message: "اكتب اسم الخدمة." }, { status: 400 });
  }
  // (TD-05) الأساس دستوري من الكود — دليل الأسعار بعملته الأساسية.
  const base = CLINIC_BASE_CURRENCY;
  const priceMinor = parseAmount(String(source.price ?? ""), base);
  if (priceMinor === null) {
    return NextResponse.json({ message: "اكتب سعرًا صحيحًا." }, { status: 400 });
  }
  const category = typeof source.category === "string" && source.category.trim()
    ? source.category.trim().slice(0, 60) : null;

  try {
    const service = await createService({ name, category, priceMinor });
    // (P1-4) قائمة الأسعار تحكم كل فاتورة: إضافة خدمةٍ بسعرها تُدقَّق.
    await recordAudit({
      action: "service.create",
      entity: "service", entityId: service.id, entityLabel: service.name,
      details: auditSnapshot(service as unknown as Record<string, unknown>, SERVICE_AUDIT_FIELDS),
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(service, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الخدمة." }, { status: 500 });
  }
}
