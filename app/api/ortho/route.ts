import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE, createOrthoCase, listOrthoCases, listPatientOrthoCases,
} from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * حالات التقويم.
 *
 * مفتوحة لكل من يدخل البرنامج — الطبيب والاستقبال معًا. فالطبيب يقرأ السلك ويسجّل
 * الشدّة، والاستقبال تعرف متى الموعد القادم ومن تأخّر. ولا مال هنا يستدعي حجبها
 * عن الطبيب: المال في خطة الأقساط لا في الحالة.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const APPLIANCES = ["fixed_metal", "fixed_ceramic", "aligners", "removable", "functional"];
const ARCHES = ["upper", "lower", "both"];
const SLOTS = ["018", "022"];

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  if (!(await requireSession())) return denied();
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));

  try {
    const cases = Number.isInteger(patientId) && patientId > 0
      ? await listPatientOrthoCases(patientId, today)
      : await listOrthoCases(today);
    return NextResponse.json({ cases, today });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل حالات التقويم." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
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
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر فتح الحالة. تأكد من المريض." }, { status: 500 });
  }
}
