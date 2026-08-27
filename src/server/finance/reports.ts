import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/lib/db";
import {
  cashAccounts,
  charges,
  commissions,
  expenseCategories,
  labs,
  patients,
  payments,
  suppliers,
  users,
  vouchers,
} from "@/db/schema";
import type { Currency } from "@/db/schema/enums";
import {
  getAppDayRangeUtc,
  getTodayIsoDate,
  zonedTimeToUtc,
} from "@/lib/datetime";
import { toMinorUnits } from "@/lib/money";
import { resolveReportRange, type ReportRange } from "@/server/reports/queries";
import { getLabBalances } from "@/server/labs/labs";
import { getSupplierBalances } from "@/server/suppliers/suppliers";
import { getWorkSummary } from "@/server/services/work-items";

/* ------------------------------------------------------------------ */
/* Voucher cash impact helpers                                         */
/* ------------------------------------------------------------------ */

/**
 * Signed cash impact in minor units:
 *   RECEIPT non-reversal: +amount   RECEIPT reversal: -amount
 *   PAYMENT non-reversal: -amount   PAYMENT reversal: +amount
 * Reversed originals keep their original sign — their counterpart reversal
 * entry cancels them out, so both rows stay in the register.
 */
export function voucherCashImpact(type: string, isReversal: boolean): 1 | -1 {
  const base = type === "RECEIPT" ? 1 : -1;
  return (isReversal ? -base : base) as 1 | -1;
}

/* ------------------------------------------------------------------ */
/* Daily closing (تقرير الإقفال اليومي)                               */
/* ------------------------------------------------------------------ */

export type DailyClosingRow = {
  cashAccountId: string;
  cashAccountName: string;
  currency: Currency;
  method: "CASH" | "TRANSFER" | "CARD" | "OTHER";
  receiptGrossMinor: number;
  receiptReversalMinor: number;
  paymentGrossMinor: number;
  paymentReversalMinor: number;
};

export type DailyClosing = {
  dateIso: string;
  startUtc: Date;
  endUtc: Date;
  rows: DailyClosingRow[];
  /** Opening balance per account+currency (all movements before the day). */
  opening: { cashAccountId: string; name: string; currency: Currency; minor: number }[];
  /** Closing balance per account+currency (opening + net of the day). */
  closing: { cashAccountId: string; name: string; currency: Currency; minor: number }[];
  /** Pre-treasury patient collections inside the day (transparency line). */
  legacyPaymentsMinor: { currency: Currency; minor: number }[];
};

/** Aggregate the day's voucher movements by (account, currency, method). */
async function getDayVoucherRows(startUtc: Date, endUtc: Date) {
  const rows = await db
    .select({
      cashAccountId: vouchers.cashAccountId,
      cashAccountName: cashAccounts.name,
      currency: vouchers.currency,
      method: vouchers.paymentMethod,
      type: vouchers.type,
      isReversal: sql<boolean>`${vouchers.reversalOfVoucherId} IS NOT NULL`,
      amount: vouchers.amount,
    })
    .from(vouchers)
    .innerJoin(cashAccounts, eq(vouchers.cashAccountId, cashAccounts.id))
    .where(and(gte(vouchers.voucherDate, startUtc), lt(vouchers.voucherDate, endUtc)));

  return rows;
}

export async function getDailyClosing(dateIso?: string): Promise<DailyClosing> {
  const { startUtc, endUtc } = dateIso
    ? dayRangeFromIso(dateIso)
    : getAppDayRangeUtc(new Date());

  const rows = await getDayVoucherRows(startUtc, endUtc);

  const grouped = new Map<string, DailyClosingRow>();
  for (const row of rows) {
    const key = `${row.cashAccountId}:${row.currency}:${row.method}`;
    const entry =
      grouped.get(key) ??
      ({
        cashAccountId: row.cashAccountId,
        cashAccountName: row.cashAccountName,
        currency: row.currency,
        method: row.method,
        receiptGrossMinor: 0,
        receiptReversalMinor: 0,
        paymentGrossMinor: 0,
        paymentReversalMinor: 0,
      } satisfies DailyClosingRow);

    const minor = toMinorUnits(row.amount);
    if (row.type === "RECEIPT") {
      if (row.isReversal) entry.receiptReversalMinor += minor;
      else entry.receiptGrossMinor += minor;
    } else {
      if (row.isReversal) entry.paymentReversalMinor += minor;
      else entry.paymentGrossMinor += minor;
    }
    grouped.set(key, entry);
  }

  // Opening balances: signed sum of all ACTIVE voucher movements before the day.
  const openingRows = await db
    .select({
      cashAccountId: vouchers.cashAccountId,
      name: cashAccounts.name,
      currency: vouchers.currency,
      minor: sql<string>`sum(
        CASE
          WHEN ${vouchers.type} = 'RECEIPT' AND ${vouchers.reversalOfVoucherId} IS NULL THEN ${vouchers.amount}
          WHEN ${vouchers.type} = 'RECEIPT' AND ${vouchers.reversalOfVoucherId} IS NOT NULL THEN -${vouchers.amount}
          WHEN ${vouchers.type} = 'PAYMENT' AND ${vouchers.reversalOfVoucherId} IS NULL THEN -${vouchers.amount}
          ELSE ${vouchers.amount}
        END
      )`,
    })
    .from(vouchers)
    .innerJoin(cashAccounts, eq(vouchers.cashAccountId, cashAccounts.id))
    .where(lt(vouchers.voucherDate, startUtc))
    .groupBy(vouchers.cashAccountId, cashAccounts.name, vouchers.currency);

  const opening = openingRows.map((row) => ({
    cashAccountId: row.cashAccountId,
    name: row.name,
    currency: row.currency,
    minor: Math.round(parseFloat(row.minor ?? "0") * 100),
  }));

  // Closing = opening + net of the day (per account+currency).
  const netByAccount = new Map<string, number>();
  for (const row of rows) {
    const impact = voucherCashImpact(row.type, row.isReversal);
    const key = `${row.cashAccountId}:${row.currency}`;
    netByAccount.set(
      key,
      (netByAccount.get(key) ?? 0) + impact * toMinorUnits(row.amount)
    );
  }

  const allAccounts = await db
    .select({ id: cashAccounts.id, name: cashAccounts.name, currency: cashAccounts.currency })
    .from(cashAccounts)
    .where(eq(cashAccounts.active, true))
    .orderBy(asc(cashAccounts.currency), asc(cashAccounts.name));

  const closing = allAccounts.map((account) => {
    const open = opening.find(
      (o) => o.cashAccountId === account.id
    );
    const net = netByAccount.get(`${account.id}:${account.currency}`) ?? 0;
    return {
      cashAccountId: account.id,
      name: account.name,
      currency: account.currency,
      minor: (open?.minor ?? 0) + net,
    };
  });

  // Ensure accounts with no history still appear in opening (0).
  const openingFull = allAccounts.map((account) => ({
    cashAccountId: account.id,
    name: account.name,
    currency: account.currency,
    minor: opening.find((o) => o.cashAccountId === account.id)?.minor ?? 0,
  }));

  // Legacy pre-treasury patient collections inside the day (payments with
  // no voucher link) — transparency only, never mixed into treasury totals.
  const legacy = await db
    .select({
      currency: payments.currency,
      total: sql<string>`sum(${payments.amount})`,
    })
    .from(payments)
    .where(
      and(
        gte(payments.createdAt, startUtc),
        lt(payments.createdAt, endUtc),
        sql`${payments.voucherId} IS NULL`,
        sql`${payments.amount} > 0`
      )
    )
    .groupBy(payments.currency);

  return {
    dateIso: dateIso ?? getTodayIsoDate(),
    startUtc,
    endUtc,
    rows: [...grouped.values()].sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) ||
        a.cashAccountName.localeCompare(b.cashAccountName) ||
        a.method.localeCompare(b.method)
    ),
    opening: openingFull,
    closing,
    legacyPaymentsMinor: legacy.map((row) => ({
      currency: row.currency,
      minor: Math.round(parseFloat(row.total ?? "0") * 100),
    })),
  };
}

function dayRangeFromIso(dateIso: string): { startUtc: Date; endUtc: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    return getAppDayRangeUtc(new Date());
  }
  const [y, m, d] = dateIso.split("-").map(Number);
  const startUtc = zonedTimeToUtc({ year: y ?? 1970, month: m ?? 1, day: d ?? 1 });
  const endUtc = zonedTimeToUtc({
    year: y ?? 1970,
    month: m ?? 1,
    day: (d ?? 1) + 1,
  });
  return { startUtc, endUtc };
}

/* ------------------------------------------------------------------ */
/* Period financial report                                             */
/* ------------------------------------------------------------------ */

export type PeriodFinancial = {
  range: ReportRange;
  /** Patient charges (billing) per currency. */
  chargesMinor: { currency: Currency; minor: number; count: number }[];
  /** Patient collections (payments) per currency. */
  collectionsMinor: { currency: Currency; minor: number; count: number }[];
  /** Treasury receipts (voucher-based) per currency. */
  treasuryReceiptsMinor: { currency: Currency; minor: number }[];
  /** Treasury payments (voucher-based) per currency. */
  treasuryPaymentsMinor: { currency: Currency; minor: number }[];
  /** Expenses by category per currency (PAYMENT vouchers with category). */
  expensesByCategory: {
    categoryId: string;
    nameAr: string;
    nameEn: string;
    currency: Currency;
    minor: number;
  }[];
  /** Doctor commissions outstanding per currency. */
  doctorDuesMinor: { doctorId: string; doctorName: string; currency: Currency; minor: number }[];
  /** Patient balances (outstanding) per currency. */
  patientBalancesMinor: { currency: Currency; minor: number }[];
  labBalances: Awaited<ReturnType<typeof getLabBalances>>;
  supplierBalances: Awaited<ReturnType<typeof getSupplierBalances>>;
};

export async function getPeriodFinancial(input: {
  preset?: string;
  from?: string;
  to?: string;
}): Promise<PeriodFinancial> {
  const range = resolveReportRange(input);

  const chargesRows = await db
    .select({
      currency: charges.currency,
      minor: sql<string>`sum(${charges.amount})`,
      count: sql<number>`count(*)::int`,
    })
    .from(charges)
    .where(and(gte(charges.createdAt, range.startUtc), lt(charges.createdAt, range.endUtc)))
    .groupBy(charges.currency);

  const collectionsRows = await db
    .select({
      currency: payments.currency,
      minor: sql<string>`sum(${payments.amount})`,
      count: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(
      and(gte(payments.createdAt, range.startUtc), lt(payments.createdAt, range.endUtc))
    )
    .groupBy(payments.currency);

  const voucherRows = await db
    .select({
      type: vouchers.type,
      currency: vouchers.currency,
      isReversal: sql<boolean>`${vouchers.reversalOfVoucherId} IS NOT NULL`,
      minor: sql<string>`sum(${vouchers.amount})`,
    })
    .from(vouchers)
    .where(
      and(
        gte(vouchers.voucherDate, range.startUtc),
        lt(vouchers.voucherDate, range.endUtc)
      )
    )
    .groupBy(vouchers.type, vouchers.currency, sql`${vouchers.reversalOfVoucherId} IS NOT NULL`);

  const treasuryReceiptsMinor: { currency: Currency; minor: number }[] = [];
  const treasuryPaymentsMinor: { currency: Currency; minor: number }[] = [];
  for (const row of voucherRows) {
    const minor = Math.round(parseFloat(row.minor ?? "0") * 100);
    const bucket = row.type === "RECEIPT" ? treasuryReceiptsMinor : treasuryPaymentsMinor;
    // Reversal entries subtract from their bucket (net effect per type).
    const value = row.isReversal ? -minor : minor;
    const existing = bucket.find((b) => b.currency === row.currency);
    if (existing) {
      existing.minor += value;
    } else {
      bucket.push({ currency: row.currency, minor: value });
    }
  }

  const expenseRows = await db
    .select({
      categoryId: expenseCategories.id,
      nameAr: expenseCategories.nameAr,
      nameEn: expenseCategories.nameEn,
      currency: vouchers.currency,
      minor: sql<string>`sum(CASE WHEN ${vouchers.reversalOfVoucherId} IS NULL THEN ${vouchers.amount} ELSE -${vouchers.amount} END)`,
    })
    .from(vouchers)
    .innerJoin(expenseCategories, eq(vouchers.expenseCategoryId, expenseCategories.id))
    .where(
      and(
        eq(vouchers.type, "PAYMENT"),
        gte(vouchers.voucherDate, range.startUtc),
        lt(vouchers.voucherDate, range.endUtc)
      )
    )
    .groupBy(expenseCategories.id, expenseCategories.nameAr, expenseCategories.nameEn, vouchers.currency);

  const dueRows = await db
    .select({
      doctorId: users.id,
      doctorName: users.name,
      currency: commissions.currency,
      minor: sql<string>`sum(${commissions.amount})`,
    })
    .from(commissions)
    .innerJoin(users, eq(commissions.doctorId, users.id))
    .where(
      and(
        sql`${commissions.status} IN ('PENDING', 'APPROVED')`,
        sql`${commissions.amount} IS NOT NULL`
      )
    )
    .groupBy(users.id, users.name, commissions.currency);

  // Patient balances per currency: per-patient charges minus payments
  // (FULL OUTER JOIN so overpaid credits are included as negatives).
  const patientBalanceRows = await db.execute<{ currency: Currency; minor: string }>(sql`
    SELECT COALESCE(c.currency, p.currency) AS currency,
           COALESCE(SUM(c.total - COALESCE(p.total, 0)), 0) AS minor
    FROM (
      SELECT patient_id, currency, SUM(amount) AS total
      FROM charges GROUP BY patient_id, currency
    ) c
    FULL OUTER JOIN (
      SELECT patient_id, currency, SUM(amount) AS total
      FROM payments GROUP BY patient_id, currency
    ) p ON c.patient_id = p.patient_id AND c.currency = p.currency
    GROUP BY COALESCE(c.currency, p.currency)
  `);
  const patientBalanceList = Array.isArray(patientBalanceRows)
    ? patientBalanceRows
    : (patientBalanceRows as unknown as { rows: { currency: Currency; minor: string }[] }).rows;

  const patientBalancesMinor = (patientBalanceList ?? []).map((row) => ({
    currency: row.currency,
    minor: Math.round(parseFloat(row.minor ?? "0") * 100),
  }));

  return {
    range,
    chargesMinor: chargesRows.map((r) => ({
      currency: r.currency,
      minor: Math.round(parseFloat(r.minor ?? "0") * 100),
      count: r.count,
    })),
    collectionsMinor: collectionsRows.map((r) => ({
      currency: r.currency,
      minor: Math.round(parseFloat(r.minor ?? "0") * 100),
      count: r.count,
    })),
    treasuryReceiptsMinor,
    treasuryPaymentsMinor,
    expensesByCategory: expenseRows.map((r) => ({
      categoryId: r.categoryId,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      currency: r.currency,
      minor: Math.round(parseFloat(r.minor ?? "0") * 100),
    })),
    doctorDuesMinor: dueRows.map((r) => ({
      doctorId: r.doctorId,
      doctorName: r.doctorName,
      currency: r.currency as Currency,
      minor: Math.round(parseFloat(r.minor ?? "0") * 100),
    })),
    patientBalancesMinor,
    labBalances: await getLabBalances(),
    supplierBalances: await getSupplierBalances(),
  };
}

/* ------------------------------------------------------------------ */
/* Voucher registers                                                   */
/* ------------------------------------------------------------------ */

export type VoucherRow = {
  id: string;
  type: "RECEIPT" | "PAYMENT";
  voucherNumber: string;
  partyType: string;
  patientName: string | null;
  doctorName: string | null;
  labName: string | null;
  supplierName: string | null;
  otherPartyName: string | null;
  amount: string;
  currency: Currency;
  cashAccountName: string;
  paymentMethod: string;
  voucherDate: Date;
  status: string;
  reversalOfVoucherId: string | null;
  reversalReason: string | null;
  description: string | null;
  createdByName: string | null;
};

export async function listVouchers(filter?: {
  type?: "RECEIPT" | "PAYMENT";
  currency?: Currency;
  cashAccountId?: string;
  paymentMethod?: string;
  startUtc?: Date;
  endUtc?: Date;
  limit?: number;
  offset?: number;
}): Promise<{ rows: VoucherRow[]; total: number }> {
  const conditions = [];
  if (filter?.type) conditions.push(eq(vouchers.type, filter.type));
  if (filter?.currency) conditions.push(eq(vouchers.currency, filter.currency));
  if (filter?.cashAccountId) conditions.push(eq(vouchers.cashAccountId, filter.cashAccountId));
  if (filter?.paymentMethod) conditions.push(eq(vouchers.paymentMethod, filter.paymentMethod as "CASH"));
  if (filter?.startUtc) conditions.push(gte(vouchers.voucherDate, filter.startUtc));
  if (filter?.endUtc) conditions.push(lt(vouchers.voucherDate, filter.endUtc));
  const where = conditions.length ? and(...conditions) : undefined;

  // Party (doctor/lab/supplier) and creator are DIFFERENT people joined from
  // different columns — never collapse them into one users join, otherwise
  // the creator's name leaks into the beneficiary field.
  const doctorUser = alias(users, "voucher_doctor_user");
  const creatorUser = alias(users, "voucher_creator_user");

  const rows = await db
    .select({
      id: vouchers.id,
      type: vouchers.type,
      voucherNumber: vouchers.voucherNumber,
      partyType: vouchers.partyType,
      patientName: patients.fullName,
      doctorName: doctorUser.name,
      labName: labs.name,
      supplierName: suppliers.name,
      otherPartyName: vouchers.otherPartyName,
      amount: vouchers.amount,
      currency: vouchers.currency,
      cashAccountName: cashAccounts.name,
      paymentMethod: vouchers.paymentMethod,
      voucherDate: vouchers.voucherDate,
      status: vouchers.status,
      reversalOfVoucherId: vouchers.reversalOfVoucherId,
      reversalReason: vouchers.reversalReason,
      description: vouchers.description,
      createdByName: creatorUser.name,
    })
    .from(vouchers)
    .leftJoin(patients, eq(vouchers.patientId, patients.id))
    .leftJoin(doctorUser, eq(vouchers.doctorId, doctorUser.id))
    .leftJoin(labs, eq(vouchers.labId, labs.id))
    .leftJoin(suppliers, eq(vouchers.supplierId, suppliers.id))
    .innerJoin(cashAccounts, eq(vouchers.cashAccountId, cashAccounts.id))
    .leftJoin(creatorUser, eq(vouchers.createdBy, creatorUser.id))
    .where(where)
    .orderBy(desc(vouchers.voucherDate), desc(vouchers.voucherNumber))
    .limit(filter?.limit ?? 100)
    .offset(filter?.offset ?? 0);

  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(vouchers)
    .where(where);
  const total = countRows[0]?.n ?? 0;

  return { rows: rows as VoucherRow[], total };
}

/** Single voucher with every display field (print pages). */
export async function getVoucherById(id: string) {
  const doctor = alias(users, "doctor_user");
  const creator = alias(users, "creator_user");
  const [row] = await db
    .select({
      id: vouchers.id,
      type: vouchers.type,
      voucherNumber: vouchers.voucherNumber,
      partyType: vouchers.partyType,
      patientId: vouchers.patientId,
      patientName: patients.fullName,
      patientFileNumber: patients.fileNumber,
      doctorId: vouchers.doctorId,
      doctorName: doctor.name,
      otherPartyName: vouchers.otherPartyName,
      expenseCategoryAr: expenseCategories.nameAr,
      expenseCategoryEn: expenseCategories.nameEn,
      amount: vouchers.amount,
      currency: vouchers.currency,
      cashAccountName: cashAccounts.name,
      paymentMethod: vouchers.paymentMethod,
      voucherDate: vouchers.voucherDate,
      description: vouchers.description,
      reference: vouchers.reference,
      status: vouchers.status,
      reversalOfVoucherId: vouchers.reversalOfVoucherId,
      reversalReason: vouchers.reversalReason,
      createdByName: creator.name,
    })
    .from(vouchers)
    .leftJoin(patients, eq(vouchers.patientId, patients.id))
    .leftJoin(doctor, eq(vouchers.doctorId, doctor.id))
    .leftJoin(expenseCategories, eq(vouchers.expenseCategoryId, expenseCategories.id))
    .innerJoin(cashAccounts, eq(vouchers.cashAccountId, cashAccounts.id))
    .leftJoin(creator, eq(vouchers.createdBy, creator.id))
    .where(eq(vouchers.id, id))
    .limit(1);

  return row ?? null;
}

/** Current cash account balances (treasury overview page). */
export async function getCashAccountBalances() {
  const rows = await db
    .select({
      id: cashAccounts.id,
      name: cashAccounts.name,
      currency: cashAccounts.currency,
      type: cashAccounts.type,
      active: cashAccounts.active,
      minor: sql<string | null>`(
        SELECT sum(
          CASE
            WHEN v.type = 'RECEIPT' AND v.reversal_of_voucher_id IS NULL THEN v.amount
            WHEN v.type = 'RECEIPT' AND v.reversal_of_voucher_id IS NOT NULL THEN -v.amount
            WHEN v.type = 'PAYMENT' AND v.reversal_of_voucher_id IS NULL THEN -v.amount
            ELSE v.amount
          END
        )
        FROM vouchers v
        WHERE v.cash_account_id = ${cashAccounts.id}
      )`,
    })
    .from(cashAccounts)
    .orderBy(asc(cashAccounts.currency), asc(cashAccounts.name));

  return rows.map((row) => ({
    ...row,
    balanceMinor: Math.round(parseFloat(row.minor ?? "0") * 100),
  }));
}

/** Re-export for the daily work report page. */
export { getWorkSummary, resolveReportRange };
