import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";

/**
 * (CASE-MODEL-1) حارس مسارات الحالات التخصصية وقائمة المشاكل وترتيب بنود الخطة.
 *
 * القراءة لكل من يملك الوصول إلى ملف المريض (الفحص المركزي نفسه). والكتابة سريرية: الطبيب
 * والمدير — الاستقبال يطّلع ويحجز ولا يكتب مشكلةً أو حالةً باسم طبيب. والكاشير والمحاسب
 * خارج هذه المسارات أصلًا (قائمة السماح عند الباب).
 */
type Session = NonNullable<Awaited<ReturnType<typeof requireSession>>>;

export type CaseGuard =
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse };

export const json = (message: string, status: number) => NextResponse.json({ message }, { status });

export function idOf(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * `plan`: ما يمسّ بنود الخطة يحترم صلاحيات الطبيب على الخطط نفسها التي تحرسها `/api/plans`:
 * «view» للقراءة و«edit» للتعديل — فلا يصير هذا المسار بابًا خلفيًّا حول صلاحيةٍ مُطفأة.
 */
export async function guardPatient(patientId: number, write: boolean, plan?: "view" | "edit"): Promise<CaseGuard> {
  const session = await requireSession();
  if (!session) return { ok: false, response: json("انتهت الجلسة. سجّل الدخول من جديد.", 401) };
  if (write && session.role !== "doctor" && session.role !== "admin") {
    return { ok: false, response: json("الحالات التخصصية وقائمة المشاكل يكتبها الطبيب — الاستقبال يطّلع عليها فقط.", 403) };
  }
  if (!(await canAccessPatient(session, patientId).catch(() => false))) {
    return { ok: false, response: json("غير مصرّح لك بملف هذا المريض.", 403) };
  }
  if (plan && !(await canAccessPatient(session, patientId, plan === "edit" ? "canEditPlans" : "canViewPlans").catch(() => false))) {
    return { ok: false, response: json(plan === "edit" ? "تعديل خطط العلاج غير مفعّل لحسابك." : "عرض خطط العلاج غير مفعّل لحسابك.", 403) };
  }
  return { ok: true, session };
}

/** هل يرى صاحب الجلسة بنود الخطة؟ — للقراءة المجمَّعة: تُحجب البنود وحدها ولا تسقط الصفحة. */
export async function canViewPlanItems(session: Session, patientId: number): Promise<boolean> {
  return canAccessPatient(session, patientId, "canViewPlans").catch(() => false);
}

export async function readBody(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
    return { ok: true, body: body && typeof body === "object" ? body : {} };
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    return { ok: false, response: bounded ?? json("طلب غير صالح.", 400) };
  }
}
