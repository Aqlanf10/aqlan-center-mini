import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { charges, payments, users } from "@/db/schema";
import { computeBalances, type CurrencyBalances } from "@/lib/money";

export type FinanceEntry = {
  id: string;
  amount: string;
  currency: string;
  description: string | null;
  createdAt: Date;
  byName: string;
};

export type PatientFinance = {
  balances: CurrencyBalances;
  charges: FinanceEntry[];
  payments: FinanceEntry[];
};

/** Charges + payments + per-currency balances for one patient. */
export async function getPatientFinance(
  patientId: string
): Promise<PatientFinance> {
  const [chargeRows, paymentRows] = await Promise.all([
    db
      .select({
        id: charges.id,
        amount: charges.amount,
        currency: charges.currency,
        description: charges.description,
        createdAt: charges.createdAt,
        byName: users.name,
      })
      .from(charges)
      .innerJoin(users, eq(charges.createdBy, users.id))
      .where(eq(charges.patientId, patientId))
      .orderBy(desc(charges.createdAt))
      .limit(50),
    db
      .select({
        id: payments.id,
        amount: payments.amount,
        currency: payments.currency,
        description: payments.description,
        createdAt: payments.createdAt,
        byName: users.name,
      })
      .from(payments)
      .innerJoin(users, eq(payments.createdBy, users.id))
      .where(eq(payments.patientId, patientId))
      .orderBy(desc(payments.createdAt))
      .limit(50),
  ]);

  return {
    balances: computeBalances(chargeRows, paymentRows),
    charges: chargeRows,
    payments: paymentRows,
  };
}
