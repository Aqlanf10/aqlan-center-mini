import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canUseTasks, getTaskForSession, isTaskPriority, updateTask, type UpdateTaskPatch } from "@/lib/hr";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** تفاصيل المهمة: غير المرئي 404 لا 403 — لا إفشاء بوجود ملفٍ خاص. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canUseTasks(session.role)) {
    return NextResponse.json({ message: "المهام خارج صلاحيات دورك." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم المهمة غير صالح." }, { status: 400 });
  }
  try {
    const detail = await getTaskForSession(session, id);
    if (!detail) return NextResponse.json({ message: "المهمة غير موجودة أو غير مرئية لك." }, { status: 404 });
    return NextResponse.json(detail);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المهمة." }, { status: 500 });
  }
}

/** تحديث مهمة: الحالة للمسؤول والإدارة، والبيانات للإدارة والصاحب، والتحويل فعلٌ صريح. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canUseTasks(session.role)) {
    return NextResponse.json({ message: "المهام خارج صلاحيات دورك." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم المهمة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patch: UpdateTaskPatch = {};
  if (source.title !== undefined) {
    const title = typeof source.title === "string" ? source.title.trim() : "";
    if (!title || title.length > 200) {
      return NextResponse.json({ message: "العنوان نصٌّ من 1 إلى 200 حرف." }, { status: 400 });
    }
    patch.title = title;
  }
  if (source.description !== undefined) {
    if (typeof source.description !== "string" || source.description.length > 4000) {
      return NextResponse.json({ message: "الوصف نصٌّ حتى 4000 حرف." }, { status: 400 });
    }
    patch.description = source.description.trim();
  }
  if (source.priority !== undefined) {
    if (!isTaskPriority(source.priority)) {
      return NextResponse.json({ message: "الأولوية: منخفضة أو عادية أو عالية أو عاجلة." }, { status: 400 });
    }
    patch.priority = source.priority;
  }
  if (source.dueAt !== undefined) {
    if (source.dueAt === null || source.dueAt === "") {
      patch.dueAt = null;
    } else {
      const parsed = new Date(String(source.dueAt));
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ message: "موعد الاستحقاق تاريخٌ صالح." }, { status: 400 });
      }
      patch.dueAt = parsed.toISOString();
    }
  }
  // تاريخ التخطيط: يومٌ مستقل عن الاستحقاق — حالة «مخطّطة» وحدها لا تعوّضه.
  if (source.plannedFor !== undefined) {
    if (source.plannedFor === null || source.plannedFor === "") {
      patch.plannedFor = null;
    } else if (typeof source.plannedFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source.plannedFor)) {
      patch.plannedFor = source.plannedFor;
    } else {
      return NextResponse.json({ message: "تاريخ التخطيط بصيغة YYYY-MM-DD." }, { status: 400 });
    }
  }
  if (source.status !== undefined) {
    if (typeof source.status !== "string" || !["planned", "in_progress", "blocked", "completed", "cancelled"].includes(source.status)) {
      return NextResponse.json({ message: "الحالة: مخططة أو جارية أو متعطلة أو مكتملة أو ملغاة." }, { status: 400 });
    }
    patch.status = source.status as UpdateTaskPatch["status"];
  }
  if (source.assigneeStaffId !== undefined) {
    if (source.assigneeStaffId === null) {
      patch.assigneeStaffId = null;
    } else {
      const parsed = Number(source.assigneeStaffId);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return NextResponse.json({ message: "المسؤول موظفٌ من ملفات الطاقم." }, { status: 400 });
      }
      patch.assigneeStaffId = parsed;
    }
  }
  if (source.convertToShared === true) patch.convertToShared = true;
  // حماية من الحفظ فوق نسخةٍ أحدث أو تكرار الطلب: يرسلها العميل كما رآها.
  if (typeof source.expectedUpdatedAt === "string" && source.expectedUpdatedAt) {
    patch.expectedUpdatedAt = source.expectedUpdatedAt;
  }

  try {
    const result = await updateTask(id, patch, session);
    if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
    return NextResponse.json(result.value);
  } catch {
    return NextResponse.json({ message: "تعذّر تحديث المهمة." }, { status: 500 });
  }
}
