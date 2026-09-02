import { NextResponse } from "next/server";
import {
  deleteLabService,
  getLabService,
  recordAudit,
  updateLabService,
} from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import type { LabServiceCategory, LabToothScope } from "@/lib/lab";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف الخدمة غير صالح." }, { status: 400 });
  }

  try {
    const service = await getLabService(id);
    if (!service) {
      return NextResponse.json({ message: "خدمة المختبر غير موجودة." }, { status: 404 });
    }
    return NextResponse.json({ service });
  } catch (error) {
    console.error("Failed to get lab service:", error);
    return NextResponse.json({ message: "تعذّر جلب بيانات الخدمة." }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تعديل دليل خدمات المختبر للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف الخدمة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const input: Parameters<typeof updateLabService>[1] = {};

  if (typeof source.name === "string") {
    const trimmed = source.name.trim();
    if (!trimmed || trimmed.length > 150) {
      return NextResponse.json({ message: "يرجى كتابة اسم صحيح للخدمة." }, { status: 400 });
    }
    input.name = trimmed;
  }

  if (source.code !== undefined) {
    if (source.code === null || source.code === "") {
      input.code = null;
    } else if (typeof source.code === "string") {
      input.code = source.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30);
    }
  }

  if (typeof source.category === "string") {
    const validCategories: LabServiceCategory[] = ["prostho", "ortho", "implant", "restorative", "appliance", "other"];
    if (validCategories.includes(source.category as LabServiceCategory)) {
      input.category = source.category as LabServiceCategory;
    }
  }

  if (typeof source.toothScope === "string") {
    const validScopes: LabToothScope[] = ["single_tooth", "multi_teeth_bridge", "full_arch", "general"];
    if (validScopes.includes(source.toothScope as LabToothScope)) {
      input.toothScope = source.toothScope as LabToothScope;
    }
  }

  if (source.requiresShade !== undefined) {
    input.requiresShade = Boolean(source.requiresShade);
  }

  if (source.defaultDays !== undefined) {
    const days = Number(source.defaultDays);
    if (Number.isInteger(days) && days >= 1 && days <= 60) {
      input.defaultDays = days;
    }
  }

  if (source.description !== undefined) {
    input.description = typeof source.description === "string" && source.description.trim()
      ? source.description.trim().slice(0, 500)
      : null;
  }

  if (source.sortOrder !== undefined) {
    const sort = Number(source.sortOrder);
    if (Number.isInteger(sort)) {
      input.sortOrder = sort;
    }
  }

  if (source.isActive !== undefined) {
    input.isActive = Boolean(source.isActive);
  }

  try {
    const updated = await updateLabService(id, input);
    if (!updated) {
      return NextResponse.json({ message: "خدمة المختبر غير موجودة." }, { status: 404 });
    }

    await recordAudit({
      actor: session.username,
      actorRole: session.role,
      action: "lab_service.update",
      entity: "lab_service",
      entityId: String(id),
      entityLabel: updated.name,
      details: {
        id,
        name: updated.name,
        isActive: updated.isActive,
        category: updated.category,
        toothScope: updated.toothScope,
      },
    });

    return NextResponse.json({ service: updated });
  } catch (error: any) {
    console.error("Failed to update lab service:", error);
    if (error?.code === "23505" || error?.message?.includes("unique")) {
      return NextResponse.json(
        { message: `رمز الخدمة مستخدم مسبقًا لخدمة أخرى.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ message: "تعذّر حفظ تعديلات الخدمة." }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف أو تعطيل خدمات المختبر للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف الخدمة غير صالح." }, { status: 400 });
  }

  try {
    const service = await getLabService(id);
    if (!service) {
      return NextResponse.json({ message: "خدمة المختبر غير موجودة." }, { status: 404 });
    }

    const result = await deleteLabService(id);

    await recordAudit({
      actor: session.username,
      actorRole: session.role,
      action: result.deactivated ? "lab_service.deactivate" : "lab_service.delete",
      entity: "lab_service",
      entityId: String(id),
      entityLabel: service.name,
      details: {
        id,
        name: service.name,
        deactivated: result.deactivated,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to delete lab service:", error);
    return NextResponse.json({ message: "تعذّر حذف خدمة المختبر." }, { status: 500 });
  }
}
