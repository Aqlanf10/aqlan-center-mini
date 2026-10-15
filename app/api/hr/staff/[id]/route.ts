import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  canManageStaff, cleanDate, cleanJobTitle, cleanOptionalText, getStaffDetail,
  isHrContractKind, isHrDepartment, isHrWorkStatus, setStaffUserLink, updateStaff,
  validatePayTermsInput, type UpdateStaffPatch,
} from "@/lib/hr";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إدارة ملفات الطاقم وشروط الأجر للمدير وحده." }, { status: 403 });

/** تفاصيل ملف موظف مع سجل تغييراته وربطه — للمدير وحده (فيها شروط الأجر). */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  }
  try {
    const detail = await getStaffDetail(id);
    if (!detail) return NextResponse.json({ message: "ملف الموظف غير موجود." }, { status: 404 });
    return NextResponse.json(detail);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الملف." }, { status: 500 });
  }
}

/** تعديل ملف موظف أو ربط/فكّ ربط حسابه — كل فعلٍ يسجَّل بفاعله وسببه. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  // فعل الربط مستقل: link_user يربط بحسابٍ موجود، unlink_user يفكّ — لا إنشاء حساب.
  if (source.action === "link_user" || source.action === "unlink_user") {
    const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "";
    if (!reason) {
      return NextResponse.json({ message: "اكتب سبب الربط أو الفكّ — يُسجَّل في سجل الملف." }, { status: 400 });
    }
    if (source.action === "unlink_user") {
      const result = await setStaffUserLink(id, null, reason, session);
      if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
      return NextResponse.json(result.staff);
    }
    const userId = Number(source.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ message: "اختر حساب الدخول الموجود المطلوب ربطه." }, { status: 400 });
    }
    const result = await setStaffUserLink(id, userId, reason, session);
    if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
    return NextResponse.json(result.staff);
  }

  const patch: UpdateStaffPatch = {};
  if (source.fullName !== undefined) {
    const fullName = typeof source.fullName === "string" ? source.fullName.trim() : "";
    if (fullName.length < 2 || fullName.length > 120) {
      return NextResponse.json({ message: "الاسم من حرفين إلى 120." }, { status: 400 });
    }
    patch.fullName = fullName;
  }
  if (source.jobTitle !== undefined) {
    const jobTitle = cleanJobTitle(source.jobTitle);
    if (jobTitle === null) {
      return NextResponse.json({ message: "المسمى الوظيفي نصٌّ حتى 80 حرفًا." }, { status: 400 });
    }
    patch.jobTitle = jobTitle;
  }
  if (source.department !== undefined) {
    if (!isHrDepartment(source.department)) {
      return NextResponse.json({ message: "اختر قسم الموظف." }, { status: 400 });
    }
    patch.department = source.department;
  }
  if (source.workStatus !== undefined) {
    if (!isHrWorkStatus(source.workStatus)) {
      return NextResponse.json({ message: "حالة العمل: على رأس العمل أو موقوف أو منتهٍ." }, { status: 400 });
    }
    patch.workStatus = source.workStatus;
  }
  if (source.hireDate !== undefined) {
    const hireDate = cleanDate(source.hireDate);
    if (hireDate === undefined) return NextResponse.json({ message: "تاريخ الالتحاق بصيغة YYYY-MM-DD." }, { status: 400 });
    patch.hireDate = hireDate;
  }
  if (source.endDate !== undefined) {
    const endDate = cleanDate(source.endDate);
    if (endDate === undefined) return NextResponse.json({ message: "تاريخ الانتهاء بصيغة YYYY-MM-DD." }, { status: 400 });
    patch.endDate = endDate;
  }
  if (source.contractKind !== undefined) {
    if (!isHrContractKind(source.contractKind)) {
      return NextResponse.json({ message: "نوع التعاقد: نسبة أو راتب أو راتب ونسبة." }, { status: 400 });
    }
    patch.contractKind = source.contractKind;
  }
  const payValidation = validatePayTermsInput(source);
  if (typeof payValidation === "string") {
    return NextResponse.json({ message: payValidation }, { status: 400 });
  }
  if (payValidation !== null) {
    patch.payTerms = payValidation;
  }
  if (source.phone !== undefined) {
    const phone = cleanOptionalText(source.phone, 40);
    if (phone === undefined) return NextResponse.json({ message: "الهاتف نصٌّ حتى 40 حرفًا." }, { status: 400 });
    patch.phone = phone;
  }
  if (source.note !== undefined) {
    const note = cleanOptionalText(source.note, 2000);
    if (note === undefined) return NextResponse.json({ message: "الملاحظة نصٌّ حتى 2000 حرف." }, { status: 400 });
    patch.note = note;
  }
  if (typeof source.reason === "string" && source.reason.trim()) {
    patch.reason = source.reason.trim().slice(0, 300);
  }
  // حماية من الحفظ فوق نسخةٍ أحدث: يرسلها العميل كما رآها عند الفتح.
  if (typeof source.expectedUpdatedAt === "string" && source.expectedUpdatedAt) {
    patch.expectedUpdatedAt = source.expectedUpdatedAt;
  }

  try {
    const result = await updateStaff(id, patch, session);
    if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
    return NextResponse.json(result.staff);
  } catch {
    return NextResponse.json({ message: "تعذّر تعديل الملف — راجع القيم (مثل تعاقد نسبةٍ مع مبلغ راتب)." }, { status: 500 });
  }
}
