import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE, chairReadinessSettings, doctorOwnsPatient, findUserByUsername,
  listTodayVisitReadinessFacts, patientDuesByCurrency, patientVisitReadinessFacts,
  type VisitReadinessFacts,
} from "@/lib/db";
import { balanceLines, chairStepper, deriveReadiness, type BalanceLine } from "@/lib/chair-readiness";
import { canAccessPatient } from "@/lib/patient-access";
import { isAdmin } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (CHAIR-1 Slices 1–2) جاهزية زيارات اليوم للكرسي — قراءةٌ فقط.
 *
 * - بلا معامل: زيارات اليوم كلها (شارة لوحة اليوم).
 * - `?patientId=`: زيارة هذا المريض التي تهمّ قمرة ملفه، ومعها مراحل الرحلة.
 *
 * القائمة مشتقة لا مخزَّنة (lib/chair-readiness.ts). والتفاصيل الطبية تُعرض لمن يملك الملف فقط
 * (عزل الطبيب)، والرصيد لمن يلمس المال (الاستقبال والمدير) وللطبيب بصلاحية «مدفوعات مرضاي»
 * وحدها — والفحص هنا في الخادم لا في الشاشة. الرصيد معلومة: لا يمنع نداءً ولا علاجًا.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const staffWide = isAdmin(session.role) || session.role === "reception";
  /* (P0-F) المساعد السريري يرى جاهزية زيارات اليوم بلا مال. */
  const assistant = session.role === "assistant";
  if (!staffWide && session.role !== "doctor" && !assistant) {
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
    const seesAllPatients = staffWide || assistant || doctor?.permissions?.canViewAllPatients === true;
    const doctorSeesMoney = doctor?.permissions?.canViewPatientPayments === true;
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
    const moneyFor = (row: VisitReadinessFacts) =>
      row.patientId !== null && visible.get(row.visitId) === true && (staffWide || doctorSeesMoney);
    const dues = await patientDuesByCurrency(
      facts.filter(moneyFor).map((row) => row.patientId as number),
    );

    const items = facts.map((row) => {
      const open = visible.get(row.visitId) === true;
      const checklist = open ? deriveReadiness(row, settings.reviewMonths, today) : null;
      const balances: BalanceLine[] | null = moneyFor(row)
        ? balanceLines(dues.get(row.patientId as number) ?? [], settings.balanceThresholds)
        : null;
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
        balances,
        ...(patientId !== null ? { stepper: stepperFor(row, balances) } : {}),
      };
    });

    return NextResponse.json({
      requireClearance: settings.requireClearance,
      ...(patientId !== null ? { visit: items[0] ?? null } : { items }),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل جاهزية الكرسي." }, { status: 500 });
  }
}

/**
 * مراحل الرحلة للقمرة. «دفع» حقيقةٌ مالية: تُعرض لمن يرى الرصيد وحده، وتُقرأ من المستحق بعملة فاتورة
 * الزيارة (FIFO الكانوني) أو من التأجيل الصريح.
 */
function stepperFor(row: VisitReadinessFacts, balances: BalanceLine[] | null) {
  const due = balances === null || row.invoiceCurrency === null
    ? null
    : balances.find((line) => line.currency === row.invoiceCurrency)?.dueMinor ?? 0;
  const stepper = chairStepper({
    status: row.status,
    clearedAt: row.clearedAt,
    seatedAt: row.seatedAt,
    signedAt: row.signedAt,
    invoiceNetMinor: row.invoiceNetMinor,
    dueInInvoiceCurrencyMinor: due,
    deferred: row.deferred,
  });
  if (balances !== null) return stepper;
  const steps = stepper.steps.filter((step) => step.key !== "paid");
  return { steps, current: steps.find((step) => !step.done)?.key ?? null };
}
