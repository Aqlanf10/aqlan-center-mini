import { readOrthoCreateDuration } from "@/lib/ortho-create-duration";
import { isDocumentAcquisitionDate } from "@/lib/document-acquisition-date";
import { isClinicalId, parseClinicalId } from "@/lib/patient-navigation";
import { OrthoCreateAuthorityError } from "@/lib/ortho-create-authority";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, createOrthoCase, listOrthoCases, listPatientOrthoCases,
} from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { canChangeOrthoPlanLink } from "@/lib/ortho-plan-link-access";

export const dynamic = "force-dynamic";

/**
 * حالات التقويم.
 *
 * الطبيب يقرأ الحالات ضمن نطاق مرضاه، والاستقبال تتابع المواعيد. صور الشدّات
 * تتبع صلاحية مستندات المريض نفسها، ولا تمنع قراءة بقية السجل السريري.
 */

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
  const patientId = filters.length === 0 ? null : parseClinicalId(filters[0]);
  if (filters.length > 1 || (filters.length === 1 && patientId === null)) {
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
  // The direct handler enforces the same CLINIC boundary as the HTTP registry.
  if (!["admin", "reception", "doctor"].includes(session.role)) {
    return NextResponse.json({ message: "غير مصرّح لك بفتح حالة تقويم." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  // Identity admission is HTTP-only; keep trusted internal writer semantics.
  const readId = (value: unknown) => typeof value === "string"
    ? parseClinicalId(value) : isClinicalId(value) ? value : null;
  const patientId = readId(source.patientId);
  if (patientId === null) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }
  // Omission/null/blank means deliberately unlinked. Other supplied values must
  // identify a plan exactly, never silently discard requested linkage.
  const noPlan = source.planId == null || (typeof source.planId === "string" && source.planId.trim() === "");
  const planId = noPlan ? null : readId(source.planId);
  if (!noPlan && planId === null) {
    return NextResponse.json({ message: "معرّف خطة العلاج غير صالح." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بفتح حالة تقويم لهذا المريض." }, { status: 403 });
  }

  // Defaults apply only to omitted fields. Explicit malformed clinical choices
  // must not silently become a different appliance, arch scope or bracket slot.
  if (
    (source.appliance !== undefined && (typeof source.appliance !== "string" || !APPLIANCES.includes(source.appliance))) ||
    (source.arches !== undefined && (typeof source.arches !== "string" || !ARCHES.includes(source.arches))) ||
    (source.slot !== undefined && (typeof source.slot !== "string" || !SLOTS.includes(source.slot)))
  ) {
    return NextResponse.json({ message: "اختر نوع الجهاز والفكين ومقاس الحاصرة من القيم المتاحة." }, { status: 400 });
  }
  const appliance = source.appliance === undefined ? "fixed_metal" : source.appliance;
  const arches = source.arches === undefined ? "both" : source.arches;
  const slot = source.slot === undefined ? "022" : source.slot;

  const plannedMonths = readOrthoCreateDuration(source.plannedMonths);
  if (plannedMonths === null) {
    return NextResponse.json({ message: "المدة المتوقعة بين شهر و120 شهرًا." }, { status: 400 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  // The optional native date input may be cleared. Only absence/blank uses
  // clinic today; supplied dates must be exact Gregorian calendar dates.
  const noStartDate = source.startDate == null || (typeof source.startDate === "string" && source.startDate.trim() === "");
  if (!noStartDate && !isDocumentAcquisitionDate(source.startDate)) {
    return NextResponse.json({ message: "أدخل تاريخ بداية ميلاديًا صحيحًا." }, { status: 400 });
  }
  const startDate = noStartDate ? today : source.startDate as string;
  if (planId !== null && !(await canChangeOrthoPlanLink(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بربط حالة التقويم بخطة العلاج." }, { status: 403 });
  }

  // Keep the existing raw UTF-16 limits without truncating authored content.
  // Null/omission and the writer's intentional trim/blank semantics stay intact.
  // PostgreSQL cannot store NUL; lone surrogates would be silently replaced
  // during UTF-8 encoding. Valid Unicode (including paired surrogates) is kept.
  for (const [field, limit] of [["bracketSystem", 80], ["note", 300]] as const) {
    const value = source[field];
    if (value != null && (typeof value !== "string" || value.length > limit
      || value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value))) {
      return NextResponse.json({ message: field === "bracketSystem"
        ? "نظام الحاصرات يجب أن يكون نصًا صالحًا لا يتجاوز 80 حرفًا."
        : "الملاحظة يجب أن تكون نصًا صالحًا لا يتجاوز 300 حرفًا." }, { status: 400 });
    }
  }

  try {
    const created = await createOrthoCase({
      patientId,
      appliance: appliance as never,
      arches: arches as never,
      slot: slot as never,
      bracketSystem: typeof source.bracketSystem === "string" ? source.bracketSystem : null,
      startDate,
      plannedMonths,
      planId,
      note: typeof source.note === "string" ? source.note : null,
      createdBy: session.username,
    }, { patientId, session });
    if (!created.ok) return NextResponse.json({ message: created.message }, { status: 409 });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (error) {
    if (error instanceof OrthoCreateAuthorityError) {
      return NextResponse.json({ message: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ message: "تعذّر فتح الحالة. تأكد من المريض." }, { status: 500 });
  }
}
