import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { authorizeVisit } from "@/lib/operational-access";
import { canSeeWalkout } from "@/lib/walkout-access";
import { canReadReceptionHandoff } from "@/lib/reception-handoff";
import { isFinishVersion, readVisitReceivable } from "@/lib/operational-checkout";
import { decideOperationalHandoff, readOperationalHandoff } from "@/lib/operational-checkout-db";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
type Context = { params: Promise<{ id: string }> };
async function access(context: Context) {
  const session = await requireSession();
  if (!session) return { response: reply({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401) };
  if (!canReadReceptionHandoff(session.role)) return { response: reply({ message: "متابعة الخروج للاستقبال والمدير فقط." }, 403) };
  const raw = (await context.params).id, visitId = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(visitId)) return { response: reply({ message: "رقم الزيارة غير صالح." }, 400) };
  const allowed = await authorizeVisit(session, visitId);
  if (!allowed.ok) return { response: reply({ message: allowed.message }, allowed.status) };
  if (allowed.patientId === null || !(await canSeeWalkout(session, allowed.patientId))) {
    return { response: reply({ message: "تحقّق من ملف المريض المرتبط بهذه الزيارة أولًا." }, 403) };
  }
  return { session, visitId, patientId: allowed.patientId };
}
export async function GET(_request: Request, context: Context) {
  try {
    const allowed = await access(context);
    if (allowed.response) return allowed.response;
    const result = await readOperationalHandoff(allowed.visitId, allowed.patientId);
    if (!result) return reply({ message: "تغيّرت الزيارة أو تم توثيقها. حدّث قائمة الخروج." }, 409);
    return reply({ ...result, owner: { username: allowed.session.username, role: allowed.session.role } });
  } catch { return reply({ message: "تعذّر التحقق من الزيارة. لا تعتمد على حالة التحصيل حتى إعادة القراءة." }, 500); }
}
export async function POST(request: Request, context: Context) {
  try {
    const allowed = await access(context);
    if (allowed.response) return allowed.response;
    const body = await readJsonBody<unknown>(request, JSON_BODY_LIMIT_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ message: "طلب غير صالح." }, 400);
    const source = body as Record<string, unknown>, receivable = readVisitReceivable(source.receivable);
    if (Object.keys(source).some(key => !["patientId", "finishVersion", "status", "reason", "receivable"].includes(key))
      || typeof source.patientId !== "number" || !Number.isSafeInteger(source.patientId) || source.patientId <= 0
      || !isFinishVersion(source.finishVersion) || (source.status !== "handled" && source.status !== "deferred")
      || typeof source.reason !== "string" || source.reason.trim().length < 3 || source.reason.trim().length > 300
      || receivable === undefined) return reply({ message: "حدّد حالة المتابعة وسببها بعد قراءة الزيارة (٣ إلى ٣٠٠ حرف)." }, 400);
    if (source.patientId !== allowed.patientId) return reply({ message: "تغيّر المريض المرتبط بالزيارة. حدّث القائمة." }, 409);
    const result = await decideOperationalHandoff({ visitId: allowed.visitId, patientId: source.patientId,
      finishVersion: source.finishVersion, status: source.status, reason: source.reason.trim(), receivable },
    { actor: allowed.session.username, actorRole: allowed.session.role });
    if (!result.ok) return reply({ message: "تغيّرت الزيارة أو فاتورتها. حدّث القائمة قبل إعادة القرار." },
      result.reason === "forbidden" ? 403 : result.reason === "invalid" ? 400 : result.reason === "not_found" ? 404 : 409);
    return reply(result);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) { bounded.headers.set("Cache-Control", headers["Cache-Control"]); return bounded; }
    return reply({ message: "تعذّر تأكيد حفظ القرار. أعد قراءة الزيارة للتحقّق قبل المحاولة." }, 500);
  }
}
