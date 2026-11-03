import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  createLabService,
  listLabServices,
  recordAudit,
  seedLabServicesCatalog,
} from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import type { LabServiceCategory, LabToothScope } from "@/lib/lab";

import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalLabDirectoryRefusal, readCanonicalLabServices } from "@/lib/canonical-lab-directory";
export const dynamic = "force-dynamic";

const SESSION_ENDED = "انتهت الجلسة. سجّل الدخول من جديد.";
/** M2 slice 70a: the canonical branch of a lab-directory request — never the legacy session. */
async function canonicalDirectory(run: (handle: import("@/lib/staff-durable-session").VerifiedDurableSession) => Promise<unknown>, fallback: string, status = 200): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: SESSION_ENDED }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  try {
    return NextResponse.json(await run(selected.handle), { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalLabDirectoryRefusal) return NextResponse.json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status, headers: NO_STORE });
    return canonicalPatientReadFailure(error, fallback);
  }
}

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  {
    const params = new URL(request.url).searchParams;
    const includeInactive = params.get("all") === "1" || params.get("includeInactive") === "true";
    const canonical = await canonicalDirectory(handle => readCanonicalLabServices(handle, { includeInactive }), "تعذّر تحميل دليل خدمات المختبر.");
    if (canonical) return canonical;
  }
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
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
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
