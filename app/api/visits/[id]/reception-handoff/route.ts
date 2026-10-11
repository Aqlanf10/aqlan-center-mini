import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { authorizeVisit } from "@/lib/operational-access";
import { canSeeWalkout } from "@/lib/walkout-access";
import { canReadReceptionHandoff } from "@/lib/reception-handoff";
import { completeReceptionHandoff, isHandoffSignature } from "@/lib/reception-handoff-db";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

/** An explicit, reasoned front-desk decision, never a payment or debt clearance. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return reply({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  if (!canReadReceptionHandoff(session.role)) return reply({ message: "إنهاء متابعة الاستقبال للاستقبال والمدير فقط." }, 403);
  const rawId = (await context.params).id;
  const visitId = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(visitId)) return reply({ message: "رقم الزيارة غير صالح." }, 400);
  try {
    const allowed = await authorizeVisit(session, visitId);
    if (!allowed.ok) return reply({ message: allowed.message }, allowed.status);
    if (!(await canSeeWalkout(session, allowed.patientId))) return reply({ message: "لا تملك صلاحية متابعة هذه الزيارة." }, 403);
    const body = await readJsonBody<unknown>(request, JSON_BODY_LIMIT_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ message: "طلب غير صالح." }, 400);
    const source = body as Record<string, unknown>;
    if (Object.keys(source).some(key => !["patientId", "signedAt", "reason"].includes(key))
      || typeof source.patientId !== "number" || !Number.isSafeInteger(source.patientId) || source.patientId <= 0
      || !isHandoffSignature(source.signedAt) || typeof source.reason !== "string"
      || source.reason.trim().length < 3 || source.reason.trim().length > 300) {
      return reply({ message: "حدّد المريض والتوقيع وسبب إنهاء المتابعة (من ٣ إلى ٣٠٠ حرف)." }, 400);
    }
    if (source.patientId !== allowed.patientId) return reply({ message: "تغيّر المريض المرتبط بالزيارة. حدّث الصفحة." }, 409);
    const result = await completeReceptionHandoff({ visitId, patientId: source.patientId,
      signedAt: source.signedAt, reason: source.reason.trim() }, { actor: session.username, actorRole: session.role });
    if (!result.ok) {
      const status = result.reason === "forbidden" ? 403 : result.reason === "not_found" ? 404 : result.reason === "invalid" ? 400 : 409;
      return reply({ message: status === 409 ? "تغيّرت الزيارة أو توقيعها. حدّث الصفحة قبل إنهاء المتابعة." : "تعذّر إنهاء متابعة الزيارة." }, status);
    }
    return reply(result);
  } catch (error) {
    const bodyError = bodyErrorResponse(error);
    if (bodyError) {
      bodyError.headers.set("Cache-Control", headers["Cache-Control"]);
      return bodyError;
    }
    return reply({ message: "تعذّر حفظ إنهاء المتابعة. حدّث القائمة للتحقّق ثم أعد المحاولة." }, 500);
  }
}
