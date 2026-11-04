import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createProviderBlock, listProviderBlocks } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalWaitingFailure } from "@/lib/canonical-patient-http";
import { CanonicalProviderBlockRefusal, commandCanonicalProviderBlockCreate, readCanonicalProviderBlocks } from "@/lib/canonical-provider-blocks";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_DENIED = () => NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
function canonicalFailure(error: unknown, fallback: string) {
  if (error instanceof CanonicalProviderBlockRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  return canonicalWaitingFailure(error, fallback);
}

/**
 * حجب الطبيب — ساعاتٌ لا يُحجز فيها عنده، بسببٍ مكتوب.
 *
 * قبل هذا كان غياب الطبيب يُدار بالذاكرة: تعرف الاستقبال أنه في المستشفى صباح
 * الخميس، فإذا غابت هي حُجز له. والحجب يجعل المعرفة في النظام لا في رأس أحد،
 * ومحرّك السعة يقرؤه فيمنع الحجز قبل أن يُوعَد المريض لا بعده.
 */
export async function GET(request: Request) {
  /* M2 slice 25: a canonical envelope reads inside its appointment scope in one owning
     snapshot; it never falls back to the legacy session. */
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return CANONICAL_DENIED();
  if (selected.kind === "canonical") {
    const params = new URL(request.url).searchParams;
    try {
      return NextResponse.json(await readCanonicalProviderBlocks(selected.handle, params.get("providerId"), params.get("date")), { headers: NO_STORE });
    } catch (error) {
      return canonicalFailure(error, "تعذّر تحميل الحجب.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const providerId = Number(params.get("providerId"));
  const date = params.get("date") ?? "";
  if (!Number.isInteger(providerId) || providerId <= 0) {
    return NextResponse.json({ message: "حدّد الطبيب." }, { status: 400 });
  }
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }
  try {
    return NextResponse.json({ blocks: await listProviderBlocks(providerId, date) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الحجب." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  /* M2 slice 25: appointments.schedule.manage inside the appointment scope, under the
     booking engine's day locks; never the legacy session. */
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return CANONICAL_DENIED();
  if (selected.kind === "canonical") {
    let canonicalBody: unknown;
    try { canonicalBody = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
      return bodyErrorResponse(error) ?? NextResponse.json({ code: "invalid_provider_block", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    if (!canonicalBody || typeof canonicalBody !== "object" || Array.isArray(canonicalBody)) {
      return NextResponse.json({ code: "invalid_provider_block", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    try {
      return NextResponse.json(await commandCanonicalProviderBlockCreate(selected.handle, canonicalBody as Record<string, unknown>), { status: 201, headers: NO_STORE });
    } catch (error) {
      return canonicalFailure(error, "تعذّر حفظ الحجب. أعد المحاولة.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  /* حجبُ طبيبٍ يُغلق ساعاتٍ على مرضى — قرارُ إدارةٍ لا قرارُ من يجلس على الاستقبال. */
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حجب أوقات الأطباء للمدير وحده." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const providerId = Number(body.providerId);
  const startsAt = typeof body.startsAt === "string" ? body.startsAt : "";
  const endsAt = typeof body.endsAt === "string" ? body.endsAt : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!Number.isInteger(providerId) || providerId <= 0) {
    return NextResponse.json({ message: "حدّد الطبيب." }, { status: 400 });
  }
  if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) {
    return NextResponse.json({ message: "وقت الحجب غير صالح." }, { status: 400 });
  }
  /* السبب مطلوبٌ لا مستحبّ: حجبٌ بلا سبب لا يُراجَع ولا يُلغى بثقة. */
  if (!reason) {
    return NextResponse.json({ message: "اكتب سبب الحجب." }, { status: 400 });
  }

  try {
    const result = await createProviderBlock({
      providerId, startsAt, endsAt, reason,
      actor: session.username, actorRole: session.role,
    });
    return result.ok
      ? NextResponse.json({ id: result.id }, { status: 201 })
      : NextResponse.json({ message: result.message }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الحجب. أعد المحاولة." }, { status: 500 });
  }
}
