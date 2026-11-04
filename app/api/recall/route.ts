import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  listLapsedPatients,
  listMissedAppointments,
  listOpenPastAppointments,
  markAppointmentFollowedUp,
  markPatientRecalled,
  recordAudit,
} from "@/lib/db";
import { LAPSE_OPTIONS } from "@/lib/recall";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure, canonicalPatientWriteFailure } from "@/lib/canonical-patient-http";
import { CanonicalRecallRefusal, commandCanonicalRecallContact, readCanonicalRecall, recallWeeks } from "@/lib/canonical-recall";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  // M2 slice 24: a canonical envelope reads the lists inside its patient scope in one
  // owning snapshot; it never falls back to the legacy session.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      return NextResponse.json(await readCanonicalRecall(selected.handle, recallWeeks(new URL(request.url).searchParams.get("weeks"))), { headers: NO_STORE });
    } catch (error) {
      return canonicalPatientReadFailure(error, "تعذّر تحميل قائمة المتابعة.");
    }
  }
  if (!(await requireSession())) return denied();
  const requested = Number(new URL(request.url).searchParams.get("weeks") ?? 6);
  // المدة من قائمة مغلقة لا من الطلب مباشرة: رقمٌ ضخم يجعل الاستعلام يمسح الجدول كله.
  const weeks = (LAPSE_OPTIONS as readonly number[]).includes(requested) ? requested : 6;

  try {
    /* المعلّقة أوّلًا في الشاشة لأنها أوّل المسار: موعدٌ يُغلق بـ«لم يحضر» يصير
       متغيّبًا فيُتصل به. وتُحمَّل معهما في طلبٍ واحد — شاشةُ متابعةٍ تحتاج ثلاثة
       طلبات لتكتمل تُقرأ ناقصةً في أثناء التحميل. */
    const [openPast, missed, lapsed] = await Promise.all([
      listOpenPastAppointments(),
      listMissedAppointments(),
      listLapsedPatients(weeks),
    ]);
    return NextResponse.json({ openPast, missed, lapsed, weeks });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قائمة المتابعة." }, { status: 500 });
  }
}

/** يسجّل أن المتابعة تمّت — يُستدعى بعد فتح واتساب أو بعد المكالمة، لا قبلهما. */
export async function POST(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    let canonicalBody: unknown;
    try { canonicalBody = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
      return NextResponse.json({ code: "invalid_recall", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    const source = (canonicalBody ?? {}) as Record<string, unknown>;
    try {
      return NextResponse.json(await commandCanonicalRecallContact(selected.handle, source.kind, source.id), { headers: NO_STORE });
    } catch (error) {
      if (error instanceof CanonicalRecallRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalPatientWriteFailure(error, "تعذّر تسجيل المتابعة. أعد المحاولة.");
    }
  }
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "admin" && session.role !== "reception") {
    return NextResponse.json({ message: "تسجيل المتابعة للاستقبال والإدارة." }, { status: 403 });
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const kind = typeof source.kind === "string" ? source.kind : "";
  const id = Number(source.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم غير صالح." }, { status: 400 });
  }

  try {
    const done = kind === "missed"
      ? await markAppointmentFollowedUp(id)
      : kind === "lapsed"
        ? await markPatientRecalled(id)
        : null;
    if (done === null) return NextResponse.json({ message: "نوع غير معروف." }, { status: 400 });
    if (!done) return NextResponse.json({ message: "السجل غير موجود أو تغيّرت حالته." }, { status: 409 });
    // (TD-06) من تابع المريض ومتى — كما تُسجَّل متابعة عروض العلاج.
    await recordAudit({
      action: "recall.contact", entity: kind === "missed" ? "appointment" : "patient", entityId: id,
      details: { النوع: kind === "missed" ? "موعد فائت" : "انقطاع" },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل المتابعة. أعد المحاولة." }, { status: 500 });
  }
}
