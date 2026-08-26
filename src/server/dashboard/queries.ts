import { and, count, eq, gte, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import { appointments, visits } from "@/db/schema";
import { getAppDayRangeUtc } from "@/lib/datetime";

export type DashboardMetrics = {
  todayAppointments: number;
  waiting: number;
  inTreatment: number;
  completedToday: number;
  noShowsToday: number;
};

/** Today's operational metrics — one grouped query, clinic-timezone scoped. */
export async function getTodayMetrics(): Promise<DashboardMetrics> {
  const { startUtc, endUtc } = getAppDayRangeUtc();

  const statusCounts = await db
    .select({
      status: appointments.status,
      value: count(),
    })
    .from(appointments)
    .where(
      and(
        gte(appointments.appointmentDate, startUtc),
        lt(appointments.appointmentDate, endUtc)
      )
    )
    .groupBy(appointments.status);

  const byStatus = new Map<string, number>(
    statusCounts.map((row) => [row.status as string, Number(row.value)])
  );

  const sum = (...statuses: string[]) =>
    statuses.reduce((total, status) => total + (byStatus.get(status) ?? 0), 0);

  return {
    todayAppointments: [...byStatus.values()].reduce((a, b) => a + b, 0),
    waiting: sum("ARRIVED"),
    inTreatment: sum("IN_TREATMENT"),
    completedToday: sum("COMPLETED"),
    noShowsToday: sum("NO_SHOW"),
  };
}

/** Completed visits today (visit table, not appointment status). */
export async function getCompletedVisitsToday(): Promise<number> {
  const { startUtc, endUtc } = getAppDayRangeUtc();
  const rows = await db
    .select({ value: count() })
    .from(visits)
    .where(
      and(
        eq(visits.status, "COMPLETED"),
        gte(visits.visitDate, startUtc),
        lt(visits.visitDate, endUtc)
      )
    );
  return Number(rows[0]?.value ?? 0);
}

