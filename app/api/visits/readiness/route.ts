import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE, chairReadinessSettings, doctorOwnsPatient, findUserByUsername,
  listTodayVisitReadinessFacts, patientVisitReadinessFacts,
  type VisitReadinessFacts,
} from "@/lib/db";
import { deriveReadiness } from "@/lib/chair-readiness";
import { canAccessPatient } from "@/lib/patient-access";
import { isAdmin } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (CHAIR-1 Slice 1) جاهزية زيارات اليوم للكرسي — قراءةٌ فقط.
 *
 * - بلا معامل: زيارات اليوم كلها (شارة لوحة اليوم).
 * - `?patientId=`: زيارة هذا المريض التي تهمّ ملفه.
 *
 * القائمة مشتقة لا مخزَّنة (lib/chair-readiness.ts). والتفاصيل الطبية تُعرض لمن يملك الملف فقط
 * (عزل الطبيب) — والفحص هنا في الخادم لا في الشاشة.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const staffWide = isAdmin(session.role) || session.role === "reception";
  if (!staffWide && session.role !== "doctor") {
    return NextResponse.json({ message: "جاهزية الكرسي للطاقم السريري والاستقبال." }, { status: 403 });
  }

  const rawPatientId = new URL(request.url).searchParams.get("patientId");
  const patientId = rawPatientId === null ? null : Number(rawPatientId);
  if (patientId !== null && (!Number.isInteger(patientId) || patientId <= 0)) {
    return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  }
  if (patientId !== null && !(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }

  try {
    const doctor = session.role === "doctor" ? await findUserByUsername(session.username) : null;
    if (session.role === "doctor" && (!doctor || !doctor.isActive)) {
      return NextResponse.json({ message: "غير مصرّح لك." }, { status: 403 });
    }
    const seesAllPatients = staffWide || doctor?.permissions?.canViewAllPatients === true;
    const ownership = new Map<number, boolean>();
    const mayOpen = async (id: number | null): Promise<boolean> => {
      if (id === null || seesAllPatients) return true;
      if (!doctor?.partyId) return false;
      if (!ownership.has(id)) ownership.set(id, await doctorOwnsPatient(doctor.partyId, id).catch(() => false));
      return ownership.get(id) === true;
    };

    const settings = await chairReadinessSettings();
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const facts: VisitReadinessFacts[] = patientId !== null
      ? [await patientVisitReadinessFacts(patientId)].filter((row): row is VisitReadinessFacts => row !== null)
      : await listTodayVisitReadinessFacts();

    const visible = new Map<number, boolean>();
    for (const row of facts) visible.set(row.visitId, await mayOpen(row.patientId));
    const items = facts.map((row) => {
      const open = visible.get(row.visitId) === true;
      const checklist = open ? deriveReadiness(row, settings.reviewMonths, today) : null;
      return {
        visitId: row.visitId,
        patientId: row.patientId,
        status: row.status,
        chair: row.chair,
        arrivedAt: row.arrivedAt,
        seatedAt: row.seatedAt,
        signedAt: row.signedAt,
        cleared: row.clearedAt ? { at: row.clearedAt, by: row.clearedBy } : null,
        checklist: checklist?.items ?? null,
        attention: checklist?.attention ?? null,
        alerts: checklist?.alerts ?? null,
      };
    });

    return NextResponse.json({
      ...(patientId !== null ? { visit: items[0] ?? null } : { items }),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل جاهزية الكرسي." }, { status: 500 });
  }
}

