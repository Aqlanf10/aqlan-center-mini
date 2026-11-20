import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { linkUserDoctor, updateUser } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { isAdmin, isRole } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { StaffAccountWriteError } from "@/lib/staff-account-mutation";
import type { DoctorPermissions, DoctorCommissionConfig } from "@/lib/doctor-permissions";
import { validateDoctorCommissionConfigInput } from "@/lib/doctor-permissions";

export const dynamic = "force-dynamic";

function staffWriteFailure(error: unknown) {
  if (error instanceof StaffAccountWriteError) {
    if (error.reason === "invalid-doctor-link") return NextResponse.json({ message: "الجهة ليست طبيبًا فاعلًا." }, { status: 404 });
    if (error.reason === "last-active-admin") return NextResponse.json({ message: "لا يمكن إيقاف آخر مدير أو تغيير دوره. عيّن مديرًا آخر أولًا." }, { status: 409 });
    if (error.reason === "owner-protection-unverified") return NextResponse.json({ message: "تعذّر التحقق من صلاحية تعديل الحساب." }, { status: 503 });
    return NextResponse.json({ message: "تعديل الحساب غير مسموح." }, { status: 403 });
  }
  return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة المستخدمين للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم المستخدم غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  /*
   * ربط حساب الطبيب بجهته (§٣٥/٣٧): به يعرف الخادم مرضى هذا الحساب فيحجب ما ليس
   * لهم. والفكّ (null) يعيده إلى السلوك القديم — يرى الكل — حتى يُربط من جديد.
   */
  if (source.action === "link_doctor") {
    const partyId = source.partyId;
    if ((partyId !== null && (typeof partyId !== "number" || !Number.isSafeInteger(partyId) || partyId <= 0))
      || Object.keys(source).some(key => key !== "action" && key !== "partyId")) {
      return NextResponse.json({ message: "ربط الحساب يحتاج رقم طبيب صالحًا أو فكًّا صريحًا." }, { status: 400 });
    }
    try {
      const updated = await linkUserDoctor(id, partyId, {
        actor: session.username, actorRole: session.role, reason: "ربط حساب الطبيب بجهته",
      }, { session });
      return updated ? NextResponse.json(updated) : NextResponse.json({ message: "المستخدم غير موجود." }, { status: 404 });
    } catch (error) { return staffWriteFailure(error); }
  }

  const patch: {
    displayName?: string; role?: string; isActive?: boolean; passwordHash?: string;
    specialty?: string; branch?: string;
    permissions?: DoctorPermissions; commissionConfig?: DoctorCommissionConfig;
    clearCommissionConfig?: boolean;
  } = {};

  if (typeof source.displayName === "string") {
    const displayName = source.displayName.trim();
    if (!displayName || displayName.length > 80) {
      return NextResponse.json({ message: "اكتب الاسم الظاهر." }, { status: 400 });
    }
    patch.displayName = displayName;
  }
  if (source.role !== undefined) {
    if (!isRole(source.role)) return NextResponse.json({ message: "دور غير معروف." }, { status: 400 });
    patch.role = source.role;
  }
  if (typeof source.isActive === "boolean") patch.isActive = source.isActive;
  if (typeof source.password === "string" && source.password) {
    if (source.password.length < 8) {
      return NextResponse.json({ message: "كلمة المرور يجب ألا تقل عن 8 أحرف." }, { status: 400 });
    }
    patch.passwordHash = await hashPassword(source.password);
  }

  /* التخصص والفرع والصلاحيات والعمولة (صلاحيات الوكيل المساعد). */
  if (typeof source.specialty === "string") patch.specialty = source.specialty.trim();
  if (typeof source.branch === "string") patch.branch = source.branch.trim();
  if (source.permissions && typeof source.permissions === "object") {
    patch.permissions = source.permissions as DoctorPermissions;
  }
  /* (P0-1) الإعداد المتقدّم يُتحقَّق منه صارمًا؛ و`null` يزيله فيعود الطبيب إلى
     نسبة جهته — والحالتان مستقبليتان من لحظة الحفظ ومدقَّقتان قبل/بعد. */
  if (source.commissionConfig === null) {
    patch.clearCommissionConfig = true;
  } else if (source.commissionConfig !== undefined) {
    const checked = validateDoctorCommissionConfigInput(source.commissionConfig);
    if (!checked.ok) return NextResponse.json({ message: checked.message }, { status: 400 });
    patch.commissionConfig = checked.value;
  }
  const commissionReason = typeof source.reason === "string" && source.reason.trim()
    ? source.reason.trim().slice(0, 300) : null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحدَّث." }, { status: 400 });
  }

  try {
    const updated = await updateUser(id, patch, {
      actor: session.username, actorRole: session.role, reason: commissionReason,
    }, { session });
    if (!updated) return NextResponse.json({ message: "المستخدم غير موجود." }, { status: 404 });

    return NextResponse.json(updated);
  } catch (error) { return staffWriteFailure(error); }
}
