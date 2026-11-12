import { NextResponse } from "next/server";
import { getPatient } from "@/lib/db";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canAccessPatient } from "@/lib/patient-access";
import {
  getPatientPortalAccountSummary,
  getPortalStaffAccess,
  issuePortalActivation,
  issuePortalPasswordReset,
  setPortalAccountStatusByStaff,
  type PortalDeliveryChannel,
} from "@/lib/portal-security";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { consumeSecurityLimit } from "@/lib/security-rate-limit";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function resolvePublicBaseOrigin(request: Request): string {
  const configured = process.env.PUBLIC_APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return parsed.origin;
      }
    } catch {
      // fallback to request URL origin
    }
  }
  return new URL(request.url).origin;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "reception" && session.role !== "doctor") {
    return NextResponse.json(
      { message: "إدارة بوابة المريض مخصّصة للإدارة والاستقبال والأطباء." },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  const patientId = Number(id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على هذا المريض." }, { status: 403 });
  }

  const patient = await getPatient(patientId);
  if (!patient) {
    return NextResponse.json({ message: "ملف المريض غير موجود." }, { status: 404 });
  }

  const [account, access] = await Promise.all([
    getPatientPortalAccountSummary(patientId),
    getPortalStaffAccess(session.userId),
  ]);

  return NextResponse.json({
    account,
    permissions: {
      isOwner: Boolean(access?.isOwner),
      canManagePortal: Boolean(access?.canManagePortal),
      canPreviewPortal: Boolean(access?.canPreviewPortal),
    },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "reception" && session.role !== "doctor") {
    return NextResponse.json(
      { message: "إدارة بوابة المريض مخصّصة للإدارة والاستقبال والأطباء المخوّلين." },
      { status: 403 },
    );
  }
  const staffAccess = await getPortalStaffAccess(session.userId);
  if (!staffAccess || !staffAccess.isActive) {
    return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
  }
  if (!staffAccess.canManagePortal) {
    return NextResponse.json(
      { message: "غير مصرّح لك بإدارة حسابات بوابة المرضى." },
      { status: 403 },
    );
  }
  const { id } = await context.params;
  const patientId = Number(id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400 });
  }

  const staffLimit = await consumeSecurityLimit({
    scope: "portal-staff-manage",
    identifier: `${session.userId}:${patientId}`,
    maximum: 10,
    windowMinutes: 15,
    headers: request.headers,
  });
  if (!staffLimit.allowed) {
    return NextResponse.json(
      { message: "عمليات متقاربة جدًا على بوابة هذا المريض. انتظر قليلًا ثم أعد المحاولة." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, staffLimit.retryAfterSeconds)) } },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "";
  const baseOrigin = resolvePublicBaseOrigin(request);

  try {
    if (action === "activate") {
      const channel = (payload.deliveryChannel as PortalDeliveryChannel) ?? "whatsapp";
      const result = await issuePortalActivation({
        actorSession: session,
        patientId,
        loginName: typeof payload.loginName === "string" ? payload.loginName : "",
        deliveryChannel: channel,
        verificationNote: typeof payload.verificationNote === "string" ? payload.verificationNote : null,
        baseOrigin,
      });
      const account = result.ok ? await getPatientPortalAccountSummary(patientId) : undefined;
      return NextResponse.json({ ...result, ...(account ? { account } : {}) }, { status: result.status });
    }

    if (action === "send_reset") {
      const channel = payload.deliveryChannel === "sms" ? "sms" : "whatsapp";
      const result = await issuePortalPasswordReset({
        actorSession: session,
        patientId,
        deliveryChannel: channel,
        verifiedPhone: typeof payload.verifiedPhone === "string" ? payload.verifiedPhone : null,
        verificationNote: typeof payload.verificationNote === "string" ? payload.verificationNote : null,
        baseOrigin,
      });
      const account = result.ok ? await getPatientPortalAccountSummary(patientId) : undefined;
      return NextResponse.json({ ...result, ...(account ? { account } : {}) }, { status: result.status });
    }

    if (action === "in_person_reset") {
      const postChannel: PortalDeliveryChannel =
        payload.deliveryChannel === "whatsapp" || payload.deliveryChannel === "sms"
          ? payload.deliveryChannel
          : "in_person";
      const result = await issuePortalPasswordReset({
        actorSession: session,
        patientId,
        deliveryChannel: postChannel,
        inPersonVerified: true,
        updatedPhone: typeof payload.updatedPhone === "string" ? payload.updatedPhone : null,
        verificationNote: typeof payload.verificationNote === "string" ? payload.verificationNote : null,
        baseOrigin,
      });
      const account = result.ok ? await getPatientPortalAccountSummary(patientId) : undefined;
      return NextResponse.json({ ...result, ...(account ? { account } : {}) }, { status: result.status });
    }

    if (action === "disable" || action === "enable" || action === "revoke_sessions") {
      const result = await setPortalAccountStatusByStaff({
        actorSession: session,
        patientId,
        action,
        reason: typeof payload.reason === "string" ? payload.reason : null,
      });
      if (!result.ok) {
        return NextResponse.json({ message: result.message }, { status: result.status });
      }
      const account = await getPatientPortalAccountSummary(patientId);
      return NextResponse.json({ ok: true, message: result.message, account });
    }

    return NextResponse.json({ message: "نوع العملية غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ العملية على حساب البوابة." }, { status: 500 });
  }
}
