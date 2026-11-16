import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, recordPlanConsent, schedulePlanInstallments } from "@/lib/db";
import { canHandleMoney } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalPlanRefusal } from "@/lib/canonical-plan-writes";
import { commandCanonicalPlanConsent } from "@/lib/canonical-plan-items";
import type { VerifiedDurableSession } from "@/lib/staff-durable-session";

export const dynamic = "force-dynamic";

/**
 * موافقة المريض على الخطة — واللحظة التي تصير فيها المسوّدة اتفاقًا.
 *
 * ويجوز أن يُجدوَل التقسيط في الطلب نفسه، لأنه ما يحدث فعلًا على الكرسي: يوافق
 * المريض على البنود ويسأل «أقدر أقسّطها؟» في النَّفَس نفسه. وفصلُهما إلى شاشتين
 * يجعل نصف الخطط تُوافَق ولا تُجدوَل.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** M2 slice 94c (G4-8): consent and its optional schedule by clinical.plans.edit inside the
 * patient scope, one operation; the schedule is validated before anything is written. */
async function canonicalConsent(request: Request, context: { params: Promise<{ id: string }> }, handle: VerifiedDurableSession) {
  const planId = Number((await context.params).id);
  if (!Number.isInteger(planId) || planId <= 0) return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400, headers: NO_STORE });
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const count = Math.round(Number(source.count ?? 0));
  let schedule: { count: number; everyDays: number; firstDueDate: string } | null = null;
  if (Number.isFinite(count) && count >= 1) {
    if (count > 60) return NextResponse.json({ message: "عدد الأقساط بين 1 و60." }, { status: 400, headers: NO_STORE });
    const everyDays = Math.round(Number(source.everyDays ?? 30));
    if (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > 365) return NextResponse.json({ message: "المدة بين الأقساط بين 1 و365 يومًا." }, { status: 400, headers: NO_STORE });
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    schedule = { count, everyDays, firstDueDate: typeof source.firstDueDate === "string" && DATE_PATTERN.test(source.firstDueDate) ? source.firstDueDate : today };
  }
  try {
    const result = await commandCanonicalPlanConsent(handle, planId, typeof source.note === "string" ? source.note.slice(0, 300) : null, schedule);
    if (result.kind === "schedule_refused") return NextResponse.json({ message: result.message }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ totalMinor: result.totalMinor, installments: result.installments }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalPlanRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
    return canonicalPatientReadFailure(error, "تعذّر تسجيل الموافقة.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") return canonicalConsent(request, context, selected.handle);
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  const { id } = await context.params;
  const planId = Number(id);
  if (!Number.isInteger(planId) || planId <= 0) {
    return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  try {
    const consent = await recordPlanConsent({
      planId,
      actor: session.username,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
    });
    if (!consent.ok) return NextResponse.json({ message: consent.message }, { status: 409 });

    // التقسيط اختياري — والموافقة قائمة سواءٌ قُسّطت أم دُفعت نقدًا عند التنفيذ.
    const count = Math.round(Number(source.count ?? 0));
    if (!Number.isFinite(count) || count < 1) {
      return NextResponse.json({ totalMinor: consent.totalMinor, installments: 0 }, { status: 201 });
    }
    if (count > 60) {
      return NextResponse.json({ message: "عدد الأقساط بين 1 و60." }, { status: 400 });
    }

    const everyDays = Math.round(Number(source.everyDays ?? 30));
    if (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > 365) {
      return NextResponse.json({ message: "المدة بين الأقساط بين 1 و365 يومًا." }, { status: 400 });
    }
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const firstDueDate = typeof source.firstDueDate === "string" && DATE_PATTERN.test(source.firstDueDate)
      ? source.firstDueDate : today;

    const scheduled = await schedulePlanInstallments({ planId, count, everyDays, firstDueDate });
    if (!scheduled.ok) {
      // الموافقة سُجّلت فعلًا؛ فالجدولة وحدها هي التي تعذّرت — ويُقال ذلك صراحةً.
      return NextResponse.json(
        { message: `سُجّلت الموافقة، وتعذّرت الجدولة: ${scheduled.message}` }, { status: 409 },
      );
    }
    return NextResponse.json(
      { totalMinor: consent.totalMinor, installments: scheduled.count }, { status: 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الموافقة." }, { status: 500 });
  }
}
