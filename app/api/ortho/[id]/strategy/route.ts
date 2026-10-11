import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getOrthoCase } from "@/lib/db";
import { guardPatient } from "@/lib/case-route";
import { requireSession } from "@/lib/session";
import { clinicDateString } from "@/lib/schedule";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { appendOrthoTreatmentStrategy, getOrthoTreatmentStrategy } from "@/lib/ortho-treatment-strategy-store";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const jsonError = (message: string, status: number, code?: string) =>
  NextResponse.json({ message, ...(code ? { code } : {}) }, { status });
const idOf = (raw: string | null): number | null => {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
};

async function scope(context: Context, write: boolean) {
  // Authenticate and reject non-clinical writers before disclosing case existence.
  // Keep the canonical patient guard and transaction-time authority checks below.
  const session = await requireSession();
  if (!session) return { ok: false as const, response: jsonError("انتهت الجلسة. سجّل الدخول من جديد.", 401) };
  if (write && session.role !== "doctor" && session.role !== "admin") {
    return { ok: false as const, response: jsonError("الحالات التخصصية وقائمة المشاكل يكتبها الطبيب — الاستقبال يطّلع عليها فقط.", 403) };
  }
  const orthoCaseId = idOf((await context.params).id);
  if (!orthoCaseId) return { ok: false as const, response: jsonError("رقم الحالة غير صالح.", 400) };
  const found = await getOrthoCase(orthoCaseId, clinicDateString(new Date(), CLINIC_TIME_ZONE));
  if (!found) return { ok: false as const, response: jsonError("الحالة غير موجودة.", 404) };
  const guard = await guardPatient(found.patientId, write);
  if (!guard.ok) return guard;
  return { ok: true as const, session: guard.session, patientId: found.patientId, orthoCaseId };
}

/** Authorized history/current or one exact saved revision. Never creates its bridge. */
export async function GET(request: Request, context: Context) {
  try {
    const owner = await scope(context, false);
    if (!owner.ok) return owner.response;
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== "revisionId") || params.getAll("revisionId").length > 1) {
      return jsonError("طلب المراجعة غير صالح.", 400);
    }
    const revisionId = params.has("revisionId") ? idOf(params.get("revisionId")) : undefined;
    if (revisionId === null) return jsonError("رقم المراجعة غير صالح.", 400);
    const result = await getOrthoTreatmentStrategy({ session: owner.session, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, revisionId });
    if (!result.ok) return jsonError(result.message, result.status, result.code);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return jsonError("تعذّر قراءة خطة الحالة. لم يُعتبر السجل فارغًا.", 500, "strategy_read_failed");
  }
}

/** One explicit append-only documentation command; no treatment or financial side effects. */
export async function POST(request: Request, context: Context) {
  try {
    const owner = await scope(context, true);
    if (!owner.ok) return owner.response;
    let command: unknown;
    try { command = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); }
    catch (error) { return bodyErrorResponse(error) ?? jsonError("طلب غير صالح.", 400); }
    const result = await appendOrthoTreatmentStrategy({ session: owner.session, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, command });
    if (!result.ok) return jsonError(result.message, result.status, result.code);
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    // An interrupted response is not proof of a failed commit. The client must keep
    // the same commandId/payload for reconciliation, rather than make a new command.
    return jsonError("تعذّر تأكيد حفظ المراجعة. تحقّق من السجل قبل إنشاء طلب جديد.", 500, "strategy_result_unknown");
  }
}
