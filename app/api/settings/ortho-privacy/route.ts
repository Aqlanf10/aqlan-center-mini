import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { listUsers } from "@/lib/db";
import { requireSession } from "@/lib/session";
import {
  canSessionManageOrthoPrivacy,
  NO_STORE_HEADERS,
  orthoForbiddenResponse,
  saveOrthoPrivacyPolicy,
} from "@/lib/ortho-privacy-server";
import {
  ORTHO_FIELD_LABELS,
  ORTHO_FIELDS,
  ORTHO_PERMISSION_META,
  ORTHO_PERMISSIONS,
  ORTHO_SECTION_LABELS,
  ORTHO_SECTIONS,
} from "@/lib/ortho-privacy";

export const dynamic = "force-dynamic";

const unauthorized = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });

export async function GET() {
  const session = await requireSession();
  if (!session) return unauthorized();

  try {
    const check = await canSessionManageOrthoPrivacy(session);
    if (!check.allowed) {
      return orthoForbiddenResponse("عرض وإدارة خصوصية وحدة التقويم محصوران بالمالك أو المدير المفوض.");
    }
    const staffRows = await listUsers();
    const staff = staffRows.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      isActive: u.isActive,
      branch: u.branch ?? null,
      partyId: u.partyId ?? null,
    }));

    return NextResponse.json(
      {
        policy: check.policy,
        actor: {
          userId: check.actor?.userId ?? session.userId,
          isOwner: check.isOwner,
          isDelegatedManager: check.isDelegatedManager,
        },
        staff,
        catalogue: {
          permissions: ORTHO_PERMISSIONS,
          permissionMeta: ORTHO_PERMISSION_META,
          sections: ORTHO_SECTIONS,
          sectionLabels: ORTHO_SECTION_LABELS,
          fields: ORTHO_FIELDS,
          fieldLabels: ORTHO_FIELD_LABELS,
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سياسة خصوصية وحدة التقويم." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function PUT(request: Request) {
  const session = await requireSession();
  if (!session) return unauthorized();

  let body: unknown;
  try {
    body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const expectedRevision = typeof source.expectedRevision === "number" ? source.expectedRevision : -1;
  const reason = typeof source.reason === "string" ? source.reason : "";

  const saved = await saveOrthoPrivacyPolicy({
    session,
    rawPolicy: source.policy,
    expectedRevision,
    reason,
  });

  if (!saved.ok) {
    return NextResponse.json({ message: saved.message }, { status: saved.status, headers: NO_STORE_HEADERS });
  }

  return NextResponse.json({ ok: true, policy: saved.policy }, { headers: NO_STORE_HEADERS });
}
