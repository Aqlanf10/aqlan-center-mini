import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE,
  createIntakeForm,
  getPatient,
  getSettings,
  listAppointmentsByDate,
  listTodayVisits,
  recordAudit,
  updatePatient,
  addVisit,
  arriveAppointment,
} from "@/lib/db";
import {
  buildCheckinVisitNote,
  calculateQueueEstimate,
  serializeCheckinAlerts,
  validateCheckinInput,
} from "@/lib/checkin";
import { clinicDateString } from "@/lib/schedule";
import { maskName, type PrivacyMode, averageWaitMinutes } from "@/lib/waiting-room";
import { waitingRows } from "@/lib/flow";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * API تسجيل الحضور وتأكيد الوصول الذاتي للمريض.
 *
 * GET:
 * 1. استعلام بالـ visitId للمتابعة الحية لتذكرة المريض على هاتفه (هل نودي عليه؟ أي كرسي؟).
 * 2. استعلام برقم الهاتف للتعرف على المريض وإرجاع إحصائيات الانتظار الحالية.
 *
 * POST:
 * استقبال استمارة الفحص الطبي وتسجيل الوصول وإصدار تذكرة الدور الفورية.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const visitIdParam = searchParams.get("visitId");
    const phoneParam = searchParams.get("phone");
    const session = (visitIdParam || phoneParam) ? await requirePortalSession() : null;
    if ((visitIdParam || phoneParam) && !session) {
      return NextResponse.json({ message: "سجّل الدخول إلى بوابة المريض أولًا." }, { status: 401 });
    }

    const now = new Date();
    const [visits, settings] = await Promise.all([
      listTodayVisits(),
      getSettings(),
    ]);

    const privacy = (settings["display.privacy_mode"] === "first_only"
      ? "first_only"
      : "first_initial") as PrivacyMode;

    const waitingList = waitingRows(visits, now);
    const avgWait = averageWaitMinutes(visits);

    // متابعة تذكرة مريض محدد
    if (visitIdParam) {
      const visitId = Number(visitIdParam);
      const visit = visits.find((v) => v.id === visitId && v.patientId === session?.patientId);
      if (!visit) {
        return NextResponse.json({ message: "لم يتم العثور على التذكرة." }, { status: 404 });
      }

      const waitingIndex = waitingList.findIndex((v) => v.visit.id === visit.id);
      const waitingAhead = waitingIndex >= 0 ? waitingIndex : 0;
      const estimate = calculateQueueEstimate(waitingAhead, avgWait);

      return NextResponse.json({
        ok: true,
        visitId: visit.id,
        patientName: maskName(visit.patientName, privacy),
        status: visit.status,
        chair: visit.chair,
        calledAt: visit.calledAt,
        waitingAhead,
        positionText: estimate.positionText,
        estimatedWaitMinutes: estimate.estimatedWaitMinutes,
      });
    }

    // استعلام برقم الجوال للترحيب بالمريض المسجل
    if (phoneParam) {
      const matched = await getPatient(session!.patientId);

      return NextResponse.json({
        ok: true,
        exists: Boolean(matched),
        patient: matched
          ? {
              id: matched.id,
              fullName: matched.fullName,
              maskedName: maskName(matched.fullName, privacy),
              patientNumber: matched.patientNumber,
              hasMedicalAlert: Boolean(matched.medicalAlert),
            }
          : null,
        stats: {
          waitingCount: waitingList.length,
          avgWaitMinutes: avgWait,
        },
      });
    }

    // معلومات عامة عن قائمة الانتظار
    return NextResponse.json({
      ok: true,
      stats: {
        waitingCount: waitingList.length,
        avgWaitMinutes: avgWait,
      },
    });
  } catch (error) {
    console.error("Checkin GET error:", error);
    return NextResponse.json({ message: "تعذّر جلب بيانات الانتظار." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى بوابة المريض أولًا. للمريض الجديد يرجى مراجعة الاستقبال أو طلب موعد." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const validation = validateCheckinInput(body);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message }, { status: 400 });
  }
  const input = validation.value;

  try {
    const now = new Date();
    const [settings, todayVisits] = await Promise.all([
      getSettings(),
      listTodayVisits(),
    ]);

    const privacy = (settings["display.privacy_mode"] === "first_only"
      ? "first_only"
      : "first_initial") as PrivacyMode;

    // 1. البحث عن المريض بالهاتف أو إنشاؤه
    const patient = await getPatient(session.patientId);
    if (!patient) return NextResponse.json({ message: "ملف المريض غير موجود." }, { status: 404 });

    const newAlert = serializeCheckinAlerts(input, patient?.medicalAlert);

    if (patient) {
      // تحديث التنبيه الطبي إن وجد أي تحديث
      if (newAlert && newAlert !== patient.medicalAlert) {
        await updatePatient(patient.id, { medicalAlert: newAlert });
        patient.medicalAlert = newAlert;
      }
    }

    // 2. حفظ الاستمارة الصحية في جدول الاستمارات الرقمية
    const intakeNoteParts = [
      input.complaintNote ? `الشكوى: ${input.complaintNote}` : null,
      input.habits?.smoking ? "مدخن" : null,
      input.habits?.khat ? "مستهلك قات" : null,
    ].filter(Boolean);

    await createIntakeForm(patient.id, {
      conditions: input.conditions,
      allergies: input.allergies ?? null,
      medications: input.medications ?? null,
      emergencyName: input.emergencyName ?? null,
      emergencyPhone: input.emergencyPhone ?? null,
      note: intakeNoteParts.join(" | ") || null,
    });

    // 3. التحقق هل المريض لديه زيارة قائمة اليوم
    const activeVisit = todayVisits.find(
      (v) =>
        v.patientId === patient.id &&
        (v.status === "waiting" || v.status === "called" || v.status === "in_chair"),
    );

    let finalVisit = activeVisit;

    if (!finalVisit) {
      // هل للمريض موعد محجوز اليوم؟
      const todayStr = clinicDateString(now, CLINIC_TIME_ZONE);
      const appointments = await listAppointmentsByDate(todayStr);
      const bookedAppt = appointments.find(
        (a) => a.patientId === patient.id && a.status === "booked",
      );

      if (bookedAppt) {
        await arriveAppointment(bookedAppt.id);
        const refreshedVisits = await listTodayVisits();
        finalVisit = refreshedVisits.find((v) => v.appointmentId === bookedAppt.id);
      }

      // إذا لم يكن له موعد أو لم تُنشأ الزيارة عبر arriveAppointment:
      if (!finalVisit) {
        const visitNote = buildCheckinVisitNote(input);
        finalVisit = await addVisit({
          patientName: patient.fullName,
          patientPhone: patient.phone,
          note: visitNote,
          patientId: patient.id,
        });
      }
    }

    // 4. تدقيق وسجل النظام
    await recordAudit({
      action: "portal.intake",
      entity: "patient",
      entityId: patient.id,
      details: {
        complaint: input.complaintId,
        hasConditions: input.conditions.length > 0,
        visitId: finalVisit?.id,
      },
      actor: `تسجيل الحضور الذاتي: ${patient.fullName}`,
    });

    // 5. حساب إحصائيات الدور
    const currentVisits = await listTodayVisits();
    const waitingList = waitingRows(currentVisits, now);
    const waitingIndex = finalVisit ? waitingList.findIndex((v) => v.visit.id === finalVisit.id) : -1;
    const waitingAhead = waitingIndex >= 0 ? waitingIndex : 0;
    const avgWait = averageWaitMinutes(currentVisits);
    const estimate = calculateQueueEstimate(waitingAhead, avgWait);

    return NextResponse.json(
      {
        ok: true,
        visitId: finalVisit?.id,
        patientId: patient.id,
        patientNumber: patient.patientNumber,
        fullName: patient.fullName,
        maskedName: maskName(patient.fullName, privacy),
        queuePosition: waitingAhead + 1,
        waitingAhead,
        positionText: estimate.positionText,
        estimatedWaitMinutes: estimate.estimatedWaitMinutes,
        status: finalVisit?.status ?? "waiting",
        chair: finalVisit?.chair ?? null,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Checkin POST error:", error);
    return NextResponse.json({ message: "تعذّر إتمام التسجيل الذاتي." }, { status: 500 });
  }
}
