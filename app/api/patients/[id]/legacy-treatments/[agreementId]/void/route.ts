import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getLegacyVoidPreview, voidLegacyTreatment } from "@/lib/legacy-treatment-db";
import { LEGACY_TREATMENT_MESSAGE, LEGACY_TREATMENT_STATUS, type LegacyVoidRefusal } from "@/lib/legacy-treatment";
import { isLegacyVoidMode, parseLegacyVoidRequest } from "@/lib/legacy-treatment-void";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; agreementId: string }> };
const headers = { "Cache-Control": "private, no-store" };
const refused = (reason: LegacyVoidRefusal) => NextResponse.json(
  { reason, message: LEGACY_TREATMENT_MESSAGE[reason] }, { status: LEGACY_TREATMENT_STATUS[reason], headers });
const idsFrom = (params: { id: string; agreementId: string }) => {
  if (!/^\d+$/.test(params.id) || !/^\d+$/.test(params.agreementId)) return null;
  const patientId = Number(params.id), agreementId = Number(params.agreementId);
  return [patientId, agreementId].every((id) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647)
    ? { patientId, agreementId } : null;
};

/** Read-only financial preview; no role expansion and no guessed agreement-to-receipt allocation. */
export async function GET(request: Request, context: Context) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers });
  if (!isAdmin(session.role)) return refused("void_forbidden");
  const ids = idsFrom(await context.params);
  if (!ids) return refused("bad_void_request");
  const modes = new URL(request.url).searchParams.getAll("mode");
  const mode = modes[0] ?? "ordinary";
  if (modes.length > 1 || !isLegacyVoidMode(mode)) return refused("bad_void_request");
  try {
    const result = await getLegacyVoidPreview({ ...ids, mode, actor: session.username, actorRole: session.role });
    if (!result.ok) return refused(result.reason);
    return NextResponse.json({ preview: result.preview }, { headers });
  } catch {
    return NextResponse.json({ message: "تعذّر عرض أثر إبطال الاتفاق. أعد المحاولة." }, { status: 500, headers });
  }
}

/** Both modes retain existing isAdmin authority; only explicit manager_authorized can use the reviewed exception. */
export async function POST(request: Request, context: Context) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers });
  if (!isAdmin(session.role)) return refused("void_forbidden");
  const ids = idsFrom(await context.params);
  if (!ids) return refused("bad_void_request");
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return refused("bad_void_request");
  }
  const parsed = parseLegacyVoidRequest(body);
  if (!parsed.ok) return refused(parsed.reason);
  try {
    const result = await voidLegacyTreatment({ ...ids, ...parsed.value, actor: session.username, actorRole: session.role });
    if (!result.ok) return refused(result.reason);
    return NextResponse.json({ agreement: result.agreement }, { headers });
  } catch {
    return NextResponse.json({ message: "تعذّر إبطال الاتفاق التاريخي. أعد المحاولة." }, { status: 500, headers });
  }
}
