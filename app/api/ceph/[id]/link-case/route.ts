import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getCephStudy, linkCephStudyToCase } from "@/lib/db";
import { cephLinkAuthorizer } from "@/lib/ceph-link-authority";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * ربط دراسة سيفالو سابقة بحالة التقويم باختيار الطبيب الصريح.
 *
 * قرارٌ سريري لا ربطٌ إداري: يُجريه الطبيب أو المدير وحدهما، بتأكيدٍ صريح، وعلى دراسةٍ وحالةٍ بعينهما، مع
 * إعادة ما عاينه (المرحلة وتاريخ الأشعة وحالة الاعتماد) ليُرفض السياق القديم. لا يعدّل قياسًا ولا اعتمادًا ولا مالًا.
 */

const PHASES = ["pretreatment", "during", "posttreatment", "followup"];
const STATUSES = ["draft", "completed"];
const say = (message: string, status: number) => NextResponse.json({ message }, { status });

const calendarDate = (value: unknown): string | null | "invalid" => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "invalid";
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "invalid";
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return say("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  if (session.role !== "doctor" && session.role !== "admin") {
    return say("ربط الدراسة بالحالة قرار سريري — للطبيب والمدير فقط.", 403);
  }
  const { id: raw } = await context.params;
  const analysisId = Number(raw);
  if (!Number.isInteger(analysisId) || analysisId <= 0) return say("رقم التحليل غير صالح.", 400);

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error);
    return bounded ?? say("طلب غير صالح.", 400);
  }
  const source = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const expected = source.expected && typeof source.expected === "object" && !Array.isArray(source.expected)
    ? source.expected as Record<string, unknown> : null;
  const xrayDate = expected ? calendarDate(expected.xrayDate) : "invalid";
  if (source.confirm !== true) return say("أكّد الربط صراحةً بعد مراجعة الدراسة والحالة.", 400);
  if (!Number.isInteger(source.orthoCaseId) || Number(source.orthoCaseId) <= 0) return say("اختر حالة التقويم.", 400);
  if (!expected || typeof expected.phase !== "string" || !PHASES.includes(expected.phase)
    || typeof expected.status !== "string" || !STATUSES.includes(expected.status) || xrayDate === "invalid") {
    return say("بيانات المعاينة ناقصة أو غير صالحة — أعد تحميل الصفحة.", 400);
  }

  const study = await getCephStudy(analysisId);
  if (!study) return say("التحليل غير موجود.", 404);
  if (!(await canAccessPatient(session, study.analysis.patientId, "canUploadXrays"))) {
    return say("غير مصرّح لك بربط هذا التحليل.", 403);
  }

  try {
    const result = await linkCephStudyToCase({
      analysisId, orthoCaseId: Number(source.orthoCaseId),
      expected: { phase: expected.phase, xrayDate, status: expected.status },
      actor: session.username, actorRole: session.role,
      // يُعاد الفحص داخل معاملة الحفظ نفسها (انظر lib/ceph-link-authority.ts).
      authorize: cephLinkAuthorizer(session),
    });
    if (!result.ok) return say(result.message, result.status);
    return NextResponse.json({ ok: true, changed: result.changed });
  } catch {
    return say("تعذّر ربط الدراسة بالحالة. أعد المحاولة.", 500);
  }
}
