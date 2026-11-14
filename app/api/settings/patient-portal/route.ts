import { NextResponse } from "next/server";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  getPortalMigrationReadinessSummary,
  getPortalPolicyConfigurationSummary,
  getPortalStaffAccess,
  listPortalStaffGrants,
  updatePortalStaffGrant,
} from "@/lib/portal-security";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { requireSessionStrict } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSessionStrict();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
  }
  const access = await getPortalStaffAccess(session.userId);
  if (!access || !access.isActive || access.role !== "admin") {
    return NextResponse.json({ message: "هذه الصفحة مخصّصة للإدارة فقط." }, { status: 403 });
  }

  const [grants, readiness] = await Promise.all([
    listPortalStaffGrants(),
    getPortalMigrationReadinessSummary(),
  ]);

  return NextResponse.json({
    me: access,
    grants,
    readiness,
    policyConfig: getPortalPolicyConfigurationSummary(),
  });
}

export async function POST(request: Request) {
  const session = await requireSessionStrict();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ message: "هذه الصفحة مخصّصة للإدارة فقط." }, { status: 403 });
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
  if ("isOwner" in payload && payload.isOwner !== undefined) {
    return NextResponse.json(
      {
        message:
          "هوية مالك العيادة مصدرها النظام القانوني المعتمد حصريًا ولا تُمنح أو تُعدَّل من جدول صلاحيات البوابة.",
      },
      { status: 403 },
    );
  }

  const targetUserId = Number(payload.userId);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return NextResponse.json({ message: "معرّف الموظف غير صالح." }, { status: 400 });
  }

  const result = await updatePortalStaffGrant({
    actorSession: session,
    targetUserId,
    canManagePortal: Boolean(payload.canManagePortal),
    canPreviewPortal: Boolean(payload.canPreviewPortal),
    note: typeof payload.note === "string" ? payload.note : null,
  });

  if (!result.ok) {
    return NextResponse.json({ message: result.message }, { status: result.status });
  }

  const grants = await listPortalStaffGrants();
  return NextResponse.json({ ok: true, grants });
}
