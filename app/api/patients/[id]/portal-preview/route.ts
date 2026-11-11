import { NextResponse } from "next/server";
import { getPatient, recordAudit } from "@/lib/db";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_ADMIN_PREVIEW_DURATION_MS,
  createPortalAdminPreviewToken,
} from "@/lib/portal";
import { getPortalStaffAccess } from "@/lib/portal-security";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { requireSessionStrict } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * «عرض بوابة المريض» باسم الموظف وصلاحياته (قراءة فقط):
 * - محصور بالمالك وبالإدارة المخوّلة بصلاحية `can_preview_portal` المستقلة.
 * - يُلزم بتسجيل سبب واضح، ويسجّل الموظف والوقت والسبب في `audit_log`.
 * - يصدر كوكي معاينة إدارية منفصلًا (`aqlan_portal_preview`) صالحًا لـ 30 دقيقة، لا يسمح بأي كتابة باسم المريض.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const staffSession = await requireSessionStrict();
  if (!staffSession) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  const access = await getPortalStaffAccess(staffSession.userId);
  if (!access || !access.isActive || access.role !== "admin" || !access.canPreviewPortal) {
    return NextResponse.json(
      { message: "«عرض بوابة المريض» متاح فقط للمالك أو للإدارة المخوّلة بصلاحية مستقلة." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  const patientId = Number(id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const rawReason = typeof (body as Record<string, unknown>)?.reason === "string"
    ? ((body as Record<string, unknown>).reason as string).trim()
    : "";
  if (rawReason.length < 5 || rawReason.length > 300) {
    return NextResponse.json(
      { message: "أدخل سببًا واضحًا لعرض بوابة المريض (من 5 إلى 300 حرف)." },
      { status: 400 },
    );
  }

  const patient = await getPatient(patientId);
  if (!patient) {
    return NextResponse.json({ message: "ملف المريض غير موجود." }, { status: 404 });
  }

  const startedAt = Date.now();
  const expiresAt = startedAt + PORTAL_ADMIN_PREVIEW_DURATION_MS;
  const token = createPortalAdminPreviewToken({
    patientId: patient.id,
    staffUserId: access.userId,
    staffUsername: access.username,
    staffDisplayName: access.displayName,
    staffRole: access.role,
    reason: rawReason,
    startedAt,
    expiresAt,
  });

  await recordAudit({
    action: "portal.admin_preview.start",
    entity: "patient",
    entityId: patient.id,
    entityLabel: patient.fullName,
    details: {
      mode: "admin_read_only_preview",
      staffUserId: access.userId,
      staffUsername: access.username,
      staffDisplayName: access.displayName,
      isOwner: access.isOwner,
      patientNumber: patient.patientNumber,
      reason: rawReason,
      startedAtIso: new Date(startedAt).toISOString(),
      expiresAtIso: new Date(expiresAt).toISOString(),
    },
    actor: access.username,
    actorRole: access.role,
  });

  const response = NextResponse.json({
    ok: true,
    redirectUrl: "/portal",
    expiresAt: new Date(expiresAt).toISOString(),
  });
  response.cookies.set(PORTAL_ADMIN_PREVIEW_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(PORTAL_ADMIN_PREVIEW_DURATION_MS / 1000),
  });
  return response;
}
