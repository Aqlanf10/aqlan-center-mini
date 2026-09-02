import { NextResponse } from "next/server";
import {
  createLabService,
  listLabServices,
  recordAudit,
  seedLabServicesCatalog,
} from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import type { LabServiceCategory, LabToothScope } from "@/lib/lab";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  const { searchParams } = new URL(request.url);
  const includeInactive = searchParams.get("all") === "1" || searchParams.get("includeInactive") === "true";

  try {
    const services = await listLabServices(includeInactive);
    return NextResponse.json({ services });
  } catch (error) {
    console.error("Failed to list lab services:", error);
    return NextResponse.json({ message: "تعذّر تحميل دليل خدمات المختبر." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة دليل خدمات المختبر للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  // معالجة طلب البذر / إعادة تعيين الدليل الافتراضي
  if (source.action === "seed_defaults") {
    try {
      const result = await seedLabServicesCatalog();
      await recordAudit({
        actor: session.username,
        actorRole: session.role,
        action: "lab_services.seed",
        entityLabel: `تحديث وبذر دليل خدمات المختبر القياسي (${result.count} خدمة)`,
        details: { count: result.count },
      });
      const services = await listLabServices(true);
      return NextResponse.json({
        message: `تم تحديث وبذر دليل خدمات المختبر بنجاح (${result.count} خدمة).`,
        services,
      });
    } catch (error) {
      console.error("Failed to seed lab services:", error);
      return NextResponse.json({ message: "تعذّر بذر خدمات المختبر." }, { status: 500 });
    }
  }

  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 150) {
    return NextResponse.json(
      { message: "يرجى كتابة اسم خدمة المختبر (أقل من 150 حرف)." },
      { status: 400 },
    );
  }

  const code = typeof source.code === "string" && source.code.trim()
    ? source.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30)
    : null;

  const validCategories: LabServiceCategory[] = ["prostho", "ortho", "implant", "restorative", "appliance", "other"];
  const category = (typeof source.category === "string" && validCategories.includes(source.category as LabServiceCategory))
    ? (source.category as LabServiceCategory)
    : "prostho";

  const validScopes: LabToothScope[] = ["single_tooth", "multi_teeth_bridge", "full_arch", "general"];
  const toothScope = (typeof source.toothScope === "string" && validScopes.includes(source.toothScope as LabToothScope))
    ? (source.toothScope as LabToothScope)
    : "single_tooth";

  const requiresShade = source.requiresShade !== false;

  const rawDays = Number(source.defaultDays);
  const defaultDays = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 60 ? rawDays : 7;

  const description = typeof source.description === "string" && source.description.trim()
    ? source.description.trim().slice(0, 500)
    : null;

  const rawSort = Number(source.sortOrder);
  const sortOrder = Number.isInteger(rawSort) ? rawSort : 100;

  const isActive = source.isActive !== false;

  try {
    const created = await createLabService({
      name,
      code,
      category,
      toothScope,
      requiresShade,
      defaultDays,
      description,
      sortOrder,
      isActive,
    });

    await recordAudit({
      actor: session.username,
      actorRole: session.role,
      action: "lab_service.create",
      entity: "lab_service",
      entityId: String(created.id),
      entityLabel: created.name,
      details: {
        id: created.id,
        name: created.name,
        code: created.code,
        category: created.category,
        toothScope: created.toothScope,
      },
    });

    return NextResponse.json({ service: created }, { status: 201 });
  } catch (error: any) {
    console.error("Failed to create lab service:", error);
    if (error?.code === "23505" || error?.message?.includes("unique")) {
      return NextResponse.json(
        { message: `رمز الخدمة (الكود: ${code}) مستخدم مسبقًا، يرجى اختيار رمز فريد.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ message: "تعذّر حفظ خدمة المختبر." }, { status: 500 });
  }
}
