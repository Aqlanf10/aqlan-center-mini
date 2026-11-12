import { commandOrthoPlanLink, OrthoPlanLinkRefusal } from "@/lib/ortho-plan-link-command";
import { OrthoCloseAuthorityError } from "@/lib/ortho-close-authority";
import { adjustmentEnumAdmissionError } from "@/lib/ortho-adjustment-enum-input";
import { isAdjustmentVisitInput, ADJUSTMENT_VISIT_INPUT_ERROR } from "@/lib/ortho-adjustment-visit-input";
import { isAdjustmentDate, ADJUSTMENT_DATE_ERROR } from "@/lib/ortho-adjustment-date";
import { parseAdjustmentInterval, ADJUSTMENT_INTERVAL_ERROR } from "@/lib/ortho-adjustment-interval";
import { adjustmentTextAdmissionError } from "@/lib/ortho-adjustment-text-input";
import { OrthoRetainerAuthorityError } from '@/lib/ortho-retainer-authority';
import { OrthoPhaseAuthorityError } from '@/lib/ortho-phase-authority';
import { CanonicalOrthoPlanLinkRefusal, commandCanonicalOrthoPlanLink } from "@/lib/canonical-ortho-plan-link-command";
import { CanonicalOrthoLifecycleRefusal, commandCanonicalOrthoLifecycle } from "@/lib/canonical-ortho-lifecycle-command";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, closeOrthoCase, getOrthoCase, recordAdjustment,
  setOrthoPhase, setRetainer,
} from "@/lib/db";
import { isElasticClass, PHASE_LABEL, PHASE_ORDER, RETAINER_LABEL } from "@/lib/ortho";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { canChangeOrthoPlanLink } from "@/lib/ortho-plan-link-access";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";

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

  const text = (value: unknown, limit: number) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;

  const requestKey = request.headers.get("Idempotency-Key");
  if (!requestKey || !IDEMPOTENCY_KEY_PATTERN.test(requestKey)) {
    return NextResponse.json({ code: "ADJUSTMENT_REQUEST_KEY_REQUIRED",
      message: "أعد فتح نموذج الشدّة للحصول على مفتاح حفظ آمن قبل التسجيل." }, { status: 400 });
  }

  try {
    const result = await recordAdjustment({
      visitId: Number.isInteger(Number(source.visitId)) && Number(source.visitId) > 0
        ? Number(source.visitId) : null,
      ...checked.value,
      doneOn,
      recordedBy: session.username,
      actorRole: session.role,
      request: { key: requestKey, patientId: found.patientId, session, newTextAdmissionError: adjustmentTextAdmissionError(source),
        newEnumAdmissionError: adjustmentEnumAdmissionError(source),
        newVisitAdmissionError: isAdjustmentVisitInput(source.visitId) ? null : ADJUSTMENT_VISIT_INPUT_ERROR,
        omittedDateForReplay: source.doneOn == null,
        newDateAdmissionError: source.doneOn == null || isAdjustmentDate(source.doneOn) ? null : ADJUSTMENT_DATE_ERROR,
        newIntervalAdmissionError: source.nextWeeks == null || parseAdjustmentInterval(source.nextWeeks) !== null ? null : ADJUSTMENT_INTERVAL_ERROR },
    });
    if (!result.ok) return NextResponse.json({ message: result.message, ...(result.code ? { code: result.code } : {}) }, { status: result.status ?? 409 });
    // (CASE-1) شدّةٌ لهذه الزيارة موجودة سلفًا (نقرة مزدوجة/إعادة محاولة): تُعاد هي ولا يُدرج صفٌّ ثانٍ.
    // (VISIT-FLOW-1) visitId: زيارة اليوم التي رُبطت بها الشدّة (أو null) — لتقول الشاشة ذلك.
    const receipt = { id: result.id, patientId: found.patientId, caseId, requestKey,
      visitId: result.visitId, attachedToToday: result.attachedToToday };
    return result.created
      ? NextResponse.json(receipt, { status: 201 })
      : NextResponse.json({ ...receipt, existing: true, ...(result.replayed ? { replayed: true } : {}) }, { status: 200 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الشدّة." }, { status: 500 });
  }
}

/** تغيير المرحلة، أو تسجيل المثبّت، أو إغلاق الحالة. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const body: unknown = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      if ([...new URL(request.url).searchParams.keys()].length) throw new CanonicalOrthoLifecycleRefusal("invalid_ortho_lifecycle", 400, "تحديث الحالة لا يقبل مرشحات إضافية.");
      const command = body && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, "planId") ? commandCanonicalOrthoPlanLink : commandCanonicalOrthoLifecycle;
      return NextResponse.json(await command(selected.handle, (await context.params).id, body), { headers: NO_STORE });
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) { bounded.headers.set("Cache-Control", "private, no-store"); return bounded; }
      if (error instanceof CanonicalOrthoLifecycleRefusal || error instanceof CanonicalOrthoPlanLinkRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalPatientReadFailure(error, "تعذّر تأكيد تحديث حالة التقويم. تحقق من السجل قبل أي طلب جديد.");
    }
  }
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
      if (!(await canChangeOrthoPlanLink(session, found.patientId))) {
        return forbidden("غير مصرّح لك بربط حالة التقويم بخطة العلاج أو فكّ ارتباطها.");
      }
      return NextResponse.json(await commandOrthoPlanLink(session, caseId, body), { headers: { "Cache-Control": "no-store" } });
    }

    if (typeof source.phase === "string") {
      if (!PHASE_ORDER.includes(source.phase as keyof typeof PHASE_LABEL)) {
        return NextResponse.json({ message: "مرحلة غير معروفة." }, { status: 400 });
      }
      const changed = await setOrthoPhase(caseId, source.phase as keyof typeof PHASE_LABEL, { patientId: found.patientId, session });
      if (!changed) return NextResponse.json({ message: "الحالة مغلقة أو غير موجودة." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (typeof source.retainer === "string") {
      if (!Object.prototype.hasOwnProperty.call(RETAINER_LABEL, source.retainer)) {
        return NextResponse.json({ message: "نوع مثبّت غير معروف." }, { status: 400 });
      }
      const hasDate = Object.prototype.hasOwnProperty.call(source, "retainerOn");
      const rawDate = source.retainerOn;
      if (hasDate && rawDate !== null && (
        typeof rawDate !== "string" || !DATE_PATTERN.test(rawDate)
        || rawDate.startsWith("0000-") || !Number.isFinite(Date.parse(rawDate))
        || new Date(rawDate).toISOString().slice(0, 10) !== rawDate
      )) {
        return NextResponse.json({ message: "تاريخ تسليم المثبّت غير صالح." }, { status: 400 });
      }
      // An omitted date is unknown, never evidence of delivery today.
      const explicitOn = typeof rawDate === "string" ? rawDate : null;
      const saved = await setRetainer({
        id: caseId,
        retainer: source.retainer as keyof typeof RETAINER_LABEL,
        deliveredOn: source.retainer === "none" ? null : explicitOn,
        preserveExistingDeliveryDate: !hasDate,
      }, { patientId: found.patientId, session });
      if (!saved) return NextResponse.json({ message: "الحالة مغلقة أو غير موجودة." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (source.status === "completed" || source.status === "discontinued") {
      const closed = await closeOrthoCase({
        id: caseId,
        status: source.status,
        actor: session.username,
        note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      }, { patientId: found.patientId, session });
      if (!closed.ok) return NextResponse.json({ message: closed.message }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch (error) {
    if (error instanceof OrthoPlanLinkRefusal) return NextResponse.json({ message: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    if (error instanceof OrthoCloseAuthorityError || error instanceof OrthoPhaseAuthorityError || error instanceof OrthoRetainerAuthorityError) return NextResponse.json({ message: error.message, code: error.code }, { status: error.status });
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
