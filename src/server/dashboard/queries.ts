import { and, count, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { appointments, charges, patients, payments, visits } from "@/db/schema";
import type { Currency } from "@/db/schema/enums";
import { fromMinorUnits, toMinorUnits } from "@/lib/money";
import { getAppDayRangeUtc, getAppMonthRangeUtc } from "@/lib/datetime";

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

/** Patients registered since the start of the current clinic month. */
export async function getNewPatientsThisMonth(): Promise<number> {
  const { startUtc, endUtc } = getAppMonthRangeUtc();
  const rows = await db
    .select({ value: count() })
    .from(patients)
    .where(
      and(gte(patients.createdAt, startUtc), lt(patients.createdAt, endUtc))
    );
  return Number(rows[0]?.value ?? 0);
}

export type CurrencyTotals = Record<Currency, string>;

export type TodayFinance = {
  charges: CurrencyTotals;
  payments: CurrencyTotals;
};

/**
 * Charges and payments created today, per currency — never mixed.
 * Amounts are summed in minor units (integer-safe) then formatted.
 */
export async function getTodayFinanceByCurrency(): Promise<TodayFinance> {
  const { startUtc, endUtc } = getAppDayRangeUtc();

  const [chargeRows, paymentRows] = await Promise.all([
    db
      .select({
        currency: charges.currency,
        total: sql<string>`sum(${charges.amount})`,
      })
      .from(charges)
      .where(and(gte(charges.createdAt, startUtc), lt(charges.createdAt, endUtc)))
      .groupBy(charges.currency),
    db
      .select({
        currency: payments.currency,
        total: sql<string>`sum(${payments.amount})`,
      })
      .from(payments)
      .where(
        and(gte(payments.createdAt, startUtc), lt(payments.createdAt, endUtc))
      )
      .groupBy(payments.currency),
  ]);

  const sumByCurrency = (rows: { currency: Currency; total: string | null }[]) => {
    const minor: Record<Currency, number> = { YER: 0, USD: 0, SAR: 0 };
    for (const row of rows) {
      if (row.currency in minor && row.total !== null) {
        const value = toMinorUnits(row.total);
        if (Number.isFinite(value)) {
          minor[row.currency] += value;
        }
      }
    }
    return {
      YER: fromMinorUnits(minor.YER),
      USD: fromMinorUnits(minor.USD),
      SAR: fromMinorUnits(minor.SAR),
    } satisfies CurrencyTotals;
  };

  return {
    charges: sumByCurrency(chargeRows),
    payments: sumByCurrency(paymentRows),
  };
}

