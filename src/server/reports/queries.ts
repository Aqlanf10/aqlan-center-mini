import { and, asc, count, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  appointments,
  charges,
  patientContacts,
  patients,
  payments,
  users,
  visits,
} from "@/db/schema";
import type { Currency } from "@/db/schema/enums";
import { fromMinorUnits, toMinorUnits } from "@/lib/money";
import {
  addDaysToIsoDate,
  getAppDayRangeUtc,
  getAppMonthRangeUtc,
  zonedTimeToUtc,
} from "@/lib/datetime";
import { getFollowUpCounts } from "@/server/follow-up/queries";

export type ReportPreset = "today" | "last7days" | "thisMonth" | "custom";

export type ReportRange = {
  preset: ReportPreset;
  startUtc: Date;
  endUtc: Date;
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve the report window from a preset or a custom from/to ISO date pair. */
export function resolveReportRange(input: {
  preset?: string;
  from?: string;
  to?: string;
  now?: Date;
}): ReportRange {
  const now = input.now ?? new Date();

  const fromIso =
    input.from && isoDatePattern.test(input.from) ? input.from : null;
  const toIso = input.to && isoDatePattern.test(input.to) ? input.to : null;

  const preset: ReportPreset =
    input.preset === "last7days" ||
    input.preset === "thisMonth" ||
    input.preset === "custom"
      ? (input.preset as ReportPreset)
      : "today";

  if (preset === "custom" && fromIso && toIso && fromIso <= toIso) {
    const parts = (iso: string) => iso.split("-").map(Number);
    const [fy, fm, fd] = parts(fromIso);
    const startUtc = zonedTimeToUtc({
      year: fy ?? 1970,
      month: fm ?? 1,
      day: fd ?? 1,
    });
    const [ny, nm, nd] = parts(addDaysToIsoDate(toIso, 1));
    const endUtc = zonedTimeToUtc({
      year: ny ?? 1970,
      month: nm ?? 1,
      day: nd ?? 1,
    });
    return { preset, startUtc, endUtc };
  }

  if (preset === "last7days") {
    const { startUtc: todayStart } = getAppDayRangeUtc(now);
    return {
      preset,
      startUtc: new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000),
      endUtc: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000),
    };
  }
  if (preset === "thisMonth") {
    return { preset, ...getAppMonthRangeUtc(now) };
  }
  return { preset: "today", ...getAppDayRangeUtc(now) };
}

export type PatientReportStats = {
  newPatients: number;
  activePatients: number;
};

export async function getPatientReportStats(
  range: ReportRange
): Promise<PatientReportStats> {
  const [newRows, activeRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(patients)
      .where(
        and(gte(patients.createdAt, range.startUtc), lt(patients.createdAt, range.endUtc))
      ),
    db.select({ value: count() }).from(patients).where(eq(patients.active, true)),
  ]);
  return {
    newPatients: Number(newRows[0]?.value ?? 0),
    activePatients: Number(activeRows[0]?.value ?? 0),
  };
}

export type AppointmentReportStats = {
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
};

export async function getAppointmentReportStats(
  range: ReportRange
): Promise<AppointmentReportStats> {
  const rows = await db
    .select({ status: appointments.status, value: count() })
    .from(appointments)
    .where(
      and(
        gte(appointments.appointmentDate, range.startUtc),
        lt(appointments.appointmentDate, range.endUtc)
      )
    )
    .groupBy(appointments.status);

  const byStatus = new Map(rows.map((r) => [r.status as string, Number(r.value)]));
  return {
    total: rows.reduce((sum, r) => sum + Number(r.value), 0),
    completed: byStatus.get("COMPLETED") ?? 0,
    cancelled: byStatus.get("CANCELLED") ?? 0,
    noShow: byStatus.get("NO_SHOW") ?? 0,
  };
}

export type ContactReportStats = {
  contactedInRange: number;
};

export async function getContactReportStats(
  range: ReportRange
): Promise<ContactReportStats> {
  const rows = await db
    .select({ value: count() })
    .from(patientContacts)
    .where(
      and(
        gte(patientContacts.contactedAt, range.startUtc),
        lt(patientContacts.contactedAt, range.endUtc)
      )
    );
  return { contactedInRange: Number(rows[0]?.value ?? 0) };
}

export type CurrencyTriple = Record<Currency, string>;

export type FinanceReportStats = {
  charges: CurrencyTriple;
  payments: CurrencyTriple;
};

export async function getFinanceReportStats(
  range: ReportRange
): Promise<FinanceReportStats> {
  const sumRows = async (table: typeof charges | typeof payments) =>
    db
      .select({ currency: table.currency, total: sql<string>`sum(${table.amount})` })
      .from(table)
      .where(
        and(gte(table.createdAt, range.startUtc), lt(table.createdAt, range.endUtc))
      )
      .groupBy(table.currency);

  const [chargeRows, paymentRows] = await Promise.all([
    sumRows(charges),
    sumRows(payments),
  ]);

  const fold = (rows: { currency: Currency; total: string | null }[]): CurrencyTriple => {
    const minor: Record<Currency, number> = { YER: 0, USD: 0, SAR: 0 };
    for (const row of rows) {
      if (row.currency in minor && row.total !== null) {
        const value = toMinorUnits(row.total);
        if (Number.isFinite(value)) minor[row.currency] += value;
      }
    }
    return {
      YER: fromMinorUnits(minor.YER),
      USD: fromMinorUnits(minor.USD),
      SAR: fromMinorUnits(minor.SAR),
    };
  };

  return { charges: fold(chargeRows), payments: fold(paymentRows) };
}

export type DoctorActivityRow = {
  doctorId: string;
  doctorName: string;
  appointmentsCount: number;
  completedVisitsCount: number;
};

export async function getDoctorActivity(
  range: ReportRange
): Promise<DoctorActivityRow[]> {
  const doctorList = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.role, "DOCTOR"))
    .orderBy(asc(users.name));

  const [appointmentRows, visitRows] = await Promise.all([
    db
      .select({ doctorId: appointments.doctorId, value: count() })
      .from(appointments)
      .where(
        and(
          gte(appointments.appointmentDate, range.startUtc),
          lt(appointments.appointmentDate, range.endUtc)
        )
      )
      .groupBy(appointments.doctorId),
    db
      .select({ doctorId: visits.doctorId, value: count() })
      .from(visits)
      .where(
        and(
          eq(visits.status, "COMPLETED"),
          gte(visits.visitDate, range.startUtc),
          lt(visits.visitDate, range.endUtc)
        )
      )
      .groupBy(visits.doctorId),
  ]);

  const appointmentsBy = new Map(
    appointmentRows.map((r) => [r.doctorId, Number(r.value)])
  );
  const visitsBy = new Map(visitRows.map((r) => [r.doctorId, Number(r.value)]));

  return doctorList.map((doctor) => ({
    doctorId: doctor.id,
    doctorName: doctor.name,
    appointmentsCount: appointmentsBy.get(doctor.id) ?? 0,
    completedVisitsCount: visitsBy.get(doctor.id) ?? 0,
  }));
}

export type OwnerReportData = {
  range: ReportRange;
  patients: PatientReportStats;
  appointments: AppointmentReportStats;
  followUp: Awaited<ReturnType<typeof getFollowUpCounts>>;
  contacts: ContactReportStats;
  finance: FinanceReportStats;
  doctorActivity: DoctorActivityRow[];
};

/** Load every report section in parallel (read-only). */
export async function getOwnerReport(range: ReportRange): Promise<OwnerReportData> {
  const [patientStats, appointmentStats, followUp, contacts, finance, doctorActivity] =
    await Promise.all([
      getPatientReportStats(range),
      getAppointmentReportStats(range),
      getFollowUpCounts(),
      getContactReportStats(range),
      getFinanceReportStats(range),
      getDoctorActivity(range),
    ]);
  return {
    range,
    patients: patientStats,
    appointments: appointmentStats,
    followUp,
    contacts,
    finance,
    doctorActivity,
  };
}
