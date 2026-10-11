import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { addTaskLink, canUseTasks, isTaskLinkKind, removeTaskLink } from "@/lib/hr";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * ربط المهمة بسجلٍّ موجود (مريض/أمر مختبر/بند مخزون): الوصول إلى السجل يُفحص
 * هنا على الخادم بصلاحيات سجلّه الأصلي — الربط لا يمنح وصولًا ولا يفتح سجلًا.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
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
  if (!isTaskLinkKind(source.linkKind)) {
    return NextResponse.json({ message: "نوع الرابط: مريض أو أمر مختبر أو بند مخزون." }, { status: 400 });
  }
  const linkId = Number(source.linkId);
  if (!Number.isInteger(linkId) || linkId <= 0) {
    return NextResponse.json({ message: "معرّف السجل المربوط غير صالح." }, { status: 400 });
  }

  try {
    const result = await addTaskLink(id, source.linkKind, linkId, session);
    if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
    return NextResponse.json(result.value, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء الرابط." }, { status: 500 });
  }
}

/** فكّ رابطٍ بعينه عن المهمة. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
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
  const url = new URL(request.url);
  const linkId = Number(url.searchParams.get("linkId"));
  if (!Number.isInteger(linkId) || linkId <= 0) {
    return NextResponse.json({ message: "معرّف الرابط غير صالح." }, { status: 400 });
  }
  try {
    const result = await removeTaskLink(id, linkId, session);
    if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر فكّ الرابط." }, { status: 500 });
  }
}
