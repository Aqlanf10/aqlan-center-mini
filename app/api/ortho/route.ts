import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, createOrthoCase, listOrthoCases, listPatientOrthoCases, recordAudit,
} from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * حالات التقويم.
 *
 * الطبيب يقرأ الحالات ضمن نطاق مرضاه، والاستقبال تتابع المواعيد. صور الشدّات
 * تتبع صلاحية مستندات المريض نفسها، ولا تمنع قراءة بقية السجل السريري.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACCESS_BATCH_SIZE = 8;

const APPLIANCES = ["fixed_metal", "fixed_ceramic", "aligners", "removable", "functional"];
const ARCHES = ["upper", "lower", "both"];
const SLOTS = ["018", "022"];

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const filters = new URL(request.url).searchParams.getAll("patientId");
  const patientId = filters.length === 0 ? null : Number(filters[0]);
  if (filters.length > 1 || (patientId !== null
    && (!/^[1-9]\d*$/.test(filters[0]) || !Number.isSafeInteger(patientId)))) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }

  try {
    const patientAccess = new Map<number, boolean>();
    const photoAccess = new Map<number, boolean>();
    if (patientId !== null) {
      if (!(await canAccessPatient(session, patientId))) {
        return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على حالات هذا المريض." }, { status: 403 });
      }
      patientAccess.set(patientId, true);
    }
    const cases = patientId !== null
      ? await listPatientOrthoCases(patientId, today)
      : await listOrthoCases(today);
    // Cache per patient within this request only; bound concurrent permission reads.
    const patientIds = [...new Set(cases.map((row) => row.patientId))];
    for (let offset = 0; offset < patientIds.length; offset += ACCESS_BATCH_SIZE) {
      await Promise.all(patientIds.slice(offset, offset + ACCESS_BATCH_SIZE).map(async (id) => {
        const allowed = patientAccess.get(id) ?? await canAccessPatient(session, id);
        patientAccess.set(id, allowed);
        if (allowed) photoAccess.set(id, await canAccessPatient(session, id, "canViewXrays"));
      }));
    }
    const visibleCases = cases.filter((row) => patientAccess.get(row.patientId) === true).map((row) => ({
      ...row,
      photosVisible: photoAccess.get(row.patientId) === true,
      adjustments: row.adjustments.map((entry) => ({
        ...entry,
        photos: photoAccess.get(row.patientId) === true ? entry.photos : [],
      })),
    }));
    return NextResponse.json({ cases: visibleCases, today });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل حالات التقويم." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بفتح حالة تقويم لهذا المريض." }, { status: 403 });
  }

  const appliance = typeof source.appliance === "string" && APPLIANCES.includes(source.appliance)
    ? source.appliance : "fixed_metal";
  const arches = typeof source.arches === "string" && ARCHES.includes(source.arches)
    ? source.arches : "both";
  const slot = typeof source.slot === "string" && SLOTS.includes(source.slot) ? source.slot : "022";

  const plannedMonths = Math.round(Number(source.plannedMonths ?? 18));
  if (!Number.isFinite(plannedMonths) || plannedMonths < 1 || plannedMonths > 120) {
    return NextResponse.json({ message: "المدة المتوقعة بين شهر و120 شهرًا." }, { status: 400 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const startDate = typeof source.startDate === "string" && DATE_PATTERN.test(source.startDate)
    ? source.startDate : today;
  const rawPlan = Number(source.planId);
  const planId = Number.isInteger(rawPlan) && rawPlan > 0 ? rawPlan : null;

  try {
    const created = await createOrthoCase({
      patientId,
      appliance: appliance as never,
      arches: arches as never,
      slot: slot as never,
      bracketSystem: typeof source.bracketSystem === "string" ? source.bracketSystem.slice(0, 80) : null,
      startDate,
      plannedMonths,
      planId,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      createdBy: session.username,
    });
    if (!created.ok) return NextResponse.json({ message: created.message }, { status: 409 });
    // (TD-06) فتح حالة تقويم — من فتحها، ولأي مريض، وبأي جهاز.
    await recordAudit({
      action: "ortho.case_create", entity: "ortho_case", entityId: created.id,
      details: { المريض: patientId, الجهاز: appliance, الفكان: arches, الخطة: planId ?? null, البداية: startDate },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر فتح الحالة. تأكد من المريض." }, { status: 500 });
  }
}
