import { NextResponse } from "next/server";
import { CASE_PARTICIPATION_MESSAGE, decideCaseParticipation, listCaseParticipationHistory } from "@/lib/commission-participation-db";
import { parseCaseParticipationRequest } from "@/lib/commission-participation-input";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";

export const dynamic = "force-dynamic";

/**
 * مشاركة الأطباء في الحالة (قرار المالك 2026-11-11، البند 3، الخيار 2، على مستوى الحالة) — للمدير وحده،
 * كالنسبة الخاصة بالحالة: قراءةً واعتمادًا وتعليقًا وإلغاءً. كل قرار صفٌّ جديد مسبَّب في سجلٍّ إلحاقيّ مع سطر
 * تدقيق في المعاملة نفسها، ولا يُعدَّل قرار سابق ولا مسير معتمد.
 */
const FORBIDDEN = "توزيع مشاركة الأطباء في الحالات للمدير وحده.";
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (!isAdmin(session.role)) return NextResponse.json({ message: FORBIDDEN }, { status: 403, headers: NO_STORE });
  const raw = new URL(request.url).searchParams.get("caseId");
  if (!raw || !/^[1-9]\d{0,8}$/.test(raw)) return NextResponse.json({ message: "رقم الحالة غير صالح." }, { status: 400, headers: NO_STORE });
  try {
    const history = await listCaseParticipationHistory(Number(raw));
    return NextResponse.json({ head: history.find(record => record.isHead) ?? null, history }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قرار مشاركة الأطباء." }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (!isAdmin(session.role)) return NextResponse.json({ message: FORBIDDEN }, { status: 403, headers: NO_STORE });
  let body: unknown = null;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
  }
  const parsed = parseCaseParticipationRequest(body);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400, headers: NO_STORE });
  try {
    const result = await decideCaseParticipation({ ...parsed.value, actor: { username: session.username, userId: session.userId ?? null, role: session.role } });
    if (!result.ok) {
      const status = result.reason === "case_not_found" ? 404 : result.reason === "stale_head" || result.reason === "nothing_to_void" ? 409 : 400;
      return NextResponse.json({ code: result.reason, message: CASE_PARTICIPATION_MESSAGE[result.reason] }, { status, headers: NO_STORE });
    }
    return NextResponse.json({ record: result.record }, { status: 201, headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ قرار مشاركة الأطباء." }, { status: 500, headers: NO_STORE });
  }
}
