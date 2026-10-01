import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getSettings, listPendingProposals, recordProposalContact } from "@/lib/db";
import { followUpDaysFrom, proposalTiming, sortProposals } from "@/lib/consultation-followup";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canViewMoney } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const ALLOWED = new Set(["admin", "reception"]);

/** (P1-E) عروض العلاج المعلّقة للمتابعة — للإدارة والاستقبال. */
export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!ALLOWED.has(session.role)) {
    return NextResponse.json({ message: "متابعة عروض العلاج للإدارة والاستقبال." }, { status: 403 });
  }
  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const followUpDays = followUpDaysFrom((await getSettings())["followup.proposal_days"]);
    const rows = await listPendingProposals({ includeMoney: canViewMoney(session.role) });
    const proposals = sortProposals(rows.map((row) => ({
      ...row,
      timing: proposalTiming({ createdOn: row.createdOn, lastContactOn: row.lastContactOn, today, followUpDays }),
    })));
    return NextResponse.json({ proposals, followUpDays, today }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل عروض العلاج المعلّقة." }, { status: 500 });
  }
}

/** (P1-E) تسجيل تواصلٍ مع المريض بشأن عرضه — بملاحظة اختيارية تُدقَّق. */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!ALLOWED.has(session.role)) {
    return NextResponse.json({ message: "متابعة عروض العلاج للإدارة والاستقبال." }, { status: 403 });
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const planId = Number(source.planId);
  if (!Number.isInteger(planId) || planId <= 0) {
    return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });
  }
  const note = typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
  try {
    const saved = await recordProposalContact({ planId, note, actor: session.username, actorRole: session.role });
    if (!saved.ok) return NextResponse.json({ message: saved.message }, { status: saved.status });
    return NextResponse.json(saved);
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل التواصل." }, { status: 500 });
  }
}
