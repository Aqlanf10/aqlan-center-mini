import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, closeOrthoCase, findUserByUsername, getOrthoCase, linkOrthoCasePlan, recordAdjustment,
  setOrthoPhase, setRetainer,
} from "@/lib/db";
import { PHASE_LABEL, RETAINER_LABEL } from "@/lib/ortho";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure, NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalOrthoCaseId, readCanonicalOrthoCase } from "@/lib/canonical-ortho-reads";

import { checkOrthoSessionDraft } from "@/lib/ortho-baseline";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const forbidden = (msg = "غير مصرّح لك بالوصول لهذه الحالة.") =>
  NextResponse.json({ message: msg }, { status: 403 });

/** تسجيل شدّة. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const caseId = await idFrom(context);
  if (!caseId) return NextResponse.json({ message: "رقم الحالة غير صالح." }, { status: 400 });

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const found = await getOrthoCase(caseId, today);
  if (!found) return NextResponse.json({ message: "الحالة غير موجودة." }, { status: 404 });
  if (!(await canAccessPatient(session, found.patientId))) {
    return forbidden("غير مصرّح لك بتسجيل شدّة لهذه الحالة.");
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const doneOn = typeof source.doneOn === "string" && DATE_PATTERN.test(source.doneOn)
    ? source.doneOn : today;
  const checked = checkOrthoSessionDraft({ ...source, caseId });
  if (!checked.ok || !checked.value) {
    return NextResponse.json({ message: checked.ok ? "بيانات جلسة التقويم غير صالحة." : checked.message }, { status: 400 });
  }

  try {
    const result = await recordAdjustment({
      visitId: Number.isInteger(Number(source.visitId)) && Number(source.visitId) > 0
        ? Number(source.visitId) : null,
      ...checked.value,
      doneOn,
      recordedBy: session.username,
      actorRole: session.role,
    });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    // (CASE-1) شدّةٌ لهذه الزيارة موجودة سلفًا (نقرة مزدوجة/إعادة محاولة): تُعاد هي ولا يُدرج صفٌّ ثانٍ.
    // (VISIT-FLOW-1) visitId: زيارة اليوم التي رُبطت بها الشدّة (أو null) — لتقول الشاشة ذلك.
    return result.created
      ? NextResponse.json({ id: result.id, visitId: result.visitId, attachedToToday: result.attachedToToday }, { status: 201 })
      : NextResponse.json({ id: result.id, existing: true, visitId: result.visitId, attachedToToday: result.attachedToToday }, { status: 200 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الشدّة." }, { status: 500 });
  }
}

/** تغيير المرحلة، أو تسجيل المثبّت، أو إغلاق الحالة. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const caseId = await idFrom(context);
  if (!caseId) return NextResponse.json({ message: "رقم الحالة غير صالح." }, { status: 400 });

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const found = await getOrthoCase(caseId, today);
  if (!found) return NextResponse.json({ message: "الحالة غير موجودة." }, { status: 404 });
  if (!(await canAccessPatient(session, found.patientId))) {
    return forbidden("غير مصرّح لك بتعديل هذه الحالة.");
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  try {
    /* (P1-B) ربط الحالة باتفاقها المالي أو فكّه — يغيّر مصدر فوترة الشدّات القادمة، فلمن يملك الخطط. */
    if ("planId" in source) {
      if (!["admin", "doctor", "reception"].includes(session.role)) {
        return forbidden("ربط حالة التقويم بالاتفاق للإدارة والطبيب والاستقبال.");
      }
      if (session.role === "doctor") {
        const user = await findUserByUsername(session.username).catch(() => null);
        if (user?.permissions && user.permissions.canEditPlans === false) {
          return forbidden("غير مصرّح لك بتعديل خطط العلاج.");
        }
      }
      const raw = source.planId;
      const planId = raw === null ? null : Number(raw);
      if (planId !== null && !(Number.isInteger(planId) && planId > 0)) {
        return NextResponse.json({ message: "الخطة المختارة غير صالحة." }, { status: 400 });
      }
      const linked = await linkOrthoCasePlan({ caseId, planId, actor: session.username, actorRole: session.role });
      if (!linked.ok) return NextResponse.json({ message: linked.message }, { status: linked.status });
      return NextResponse.json(linked);
    }

    if (typeof source.phase === "string") {
      if (!Object.prototype.hasOwnProperty.call(PHASE_LABEL, source.phase)) {
        return NextResponse.json({ message: "مرحلة غير معروفة." }, { status: 400 });
      }
      const changed = await setOrthoPhase(caseId, source.phase as keyof typeof PHASE_LABEL);
      if (!changed) return NextResponse.json({ message: "الحالة مغلقة أو غير موجودة." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (typeof source.retainer === "string") {
      if (!Object.prototype.hasOwnProperty.call(RETAINER_LABEL, source.retainer)) {
        return NextResponse.json({ message: "نوع مثبّت غير معروف." }, { status: 400 });
      }
      const explicitOn = typeof source.retainerOn === "string" && DATE_PATTERN.test(source.retainerOn)
        ? source.retainerOn : null;
      const saved = await setRetainer({
        id: caseId,
        retainer: source.retainer as keyof typeof RETAINER_LABEL,
        deliveredOn: source.retainer === "none" ? null : explicitOn ?? today,
        preserveExistingDeliveryDate: explicitOn === null,
      });
      if (!saved) return NextResponse.json({ message: "الحالة مغلقة أو غير موجودة." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (source.status === "completed" || source.status === "discontinued") {
      const closed = await closeOrthoCase({
        id: caseId,
        status: source.status,
        actor: session.username,
        note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      });
      if (!closed.ok) return NextResponse.json({ message: closed.message }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء." }, { status: 500 });
  }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const caseId = canonicalOrthoCaseId((await context.params).id, new URL(_request.url).searchParams);
      return NextResponse.json(await readCanonicalOrthoCase(selected.handle, caseId), { headers: NO_STORE });
    } catch (error) { return canonicalPatientReadFailure(error, "تعذّر تحميل تفاصيل التقويم."); }
  }
  const session = await requireSession();
  if (!session) return denied();
  const caseId = await idFrom(context);
  if (!caseId) return NextResponse.json({ message: "رقم الحالة غير صالح." }, { status: 400 });
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const found = await getOrthoCase(caseId, today);
  if (!found) return NextResponse.json({ message: "الحالة غير موجودة." }, { status: 404 });
  if (!(await canAccessPatient(session, found.patientId))) {
    return forbidden("غير مصرّح لك بالاطلاع على هذه الحالة.");
  }
  const photosVisible = await canAccessPatient(session, found.patientId, "canViewXrays");
  return NextResponse.json({
    ...found,
    photosVisible,
    adjustments: found.adjustments.map((entry) => ({ ...entry, photos: photosVisible ? entry.photos : [] })),
  });
}
