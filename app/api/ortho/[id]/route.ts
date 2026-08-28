import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE, closeOrthoCase, getOrthoCase, recordAdjustment,
  setOrthoPhase, setRetainer,
} from "@/lib/db";
import { isElasticClass, PHASE_LABEL, RETAINER_LABEL } from "@/lib/ortho";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** تسجيل شدّة. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const caseId = await idFrom(context);
  if (!caseId) return NextResponse.json({ message: "رقم الحالة غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const doneOn = typeof source.doneOn === "string" && DATE_PATTERN.test(source.doneOn)
    ? source.doneOn : today;
  const phase = typeof source.phase === "string" && source.phase in PHASE_LABEL
    ? (source.phase as keyof typeof PHASE_LABEL) : null;
  const elastics = isElasticClass(source.elastics) ? source.elastics : "none";
  const nextWeeks = Math.round(Number(source.nextWeeks ?? 4));
  if (!Number.isFinite(nextWeeks) || nextWeeks < 1 || nextWeeks > 52) {
    return NextResponse.json({ message: "المدة حتى الشدّة القادمة بين أسبوع و52 أسبوعًا." }, { status: 400 });
  }

  const text = (value: unknown, limit: number) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;

  try {
    const result = await recordAdjustment({
      caseId,
      visitId: Number.isInteger(Number(source.visitId)) && Number(source.visitId) > 0
        ? Number(source.visitId) : null,
      doneOn, phase,
      upperWire: text(source.upperWire, 40),
      lowerWire: text(source.lowerWire, 40),
      elastics,
      elasticNote: text(source.elasticNote, 120),
      done: text(source.done, 400),
      nextWeeks,
      note: text(source.note, 300),
      recordedBy: session.username,
    });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    return NextResponse.json({ id: result.id }, { status: 201 });
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

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);

  try {
    if (typeof source.phase === "string") {
      if (!(source.phase in PHASE_LABEL)) {
        return NextResponse.json({ message: "مرحلة غير معروفة." }, { status: 400 });
      }
      const changed = await setOrthoPhase(caseId, source.phase as keyof typeof PHASE_LABEL);
      if (!changed) return NextResponse.json({ message: "الحالة مغلقة أو غير موجودة." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (typeof source.retainer === "string") {
      if (!(source.retainer in RETAINER_LABEL)) {
        return NextResponse.json({ message: "نوع مثبّت غير معروف." }, { status: 400 });
      }
      const on = typeof source.retainerOn === "string" && DATE_PATTERN.test(source.retainerOn)
        ? source.retainerOn : today;
      const saved = await setRetainer({
        id: caseId,
        retainer: source.retainer as keyof typeof RETAINER_LABEL,
        deliveredOn: source.retainer === "none" ? null : on,
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
  if (!(await requireSession())) return denied();
  const caseId = await idFrom(context);
  if (!caseId) return NextResponse.json({ message: "رقم الحالة غير صالح." }, { status: 400 });
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const found = await getOrthoCase(caseId, today);
  if (!found) return NextResponse.json({ message: "الحالة غير موجودة." }, { status: 404 });
  return NextResponse.json(found);
}
