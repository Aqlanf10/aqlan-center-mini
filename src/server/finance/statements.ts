import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  charges,
  commissions,
  labCases,
  labs,
  patients,
  payments,
  purchaseInvoices,
  suppliers,
  users,
  vouchers,
} from "@/db/schema";
import type { Currency } from "@/db/schema/enums";
import { getWorkSummary } from "@/server/services/work-items";

/* ------------------------------------------------------------------ */
/* Patient statement                                                   */
/* ------------------------------------------------------------------ */

export type PatientStatementLine = {
  kind: "charge" | "payment";
  id: string;
  date: Date;
  amount: string;
  currency: Currency;
  description: string | null;
  voucherNumber: string | null;
};

export async function getPatientStatement(patientId: string) {
  const [patient] = await db
    .select({
      id: patients.id,
      fullName: patients.fullName,
      fileNumber: patients.fileNumber,
      mobile: patients.mobile,
    })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  if (!patient) {
    return null;
  }

  const chargeRows = await db
    .select({
      id: charges.id,
      createdAt: charges.createdAt,
      amount: charges.amount,
      currency: charges.currency,
      description: charges.description,
    })
    .from(charges)
    .where(eq(charges.patientId, patientId));

  const paymentRows = await db
    .select({
      id: payments.id,
      createdAt: payments.createdAt,
      amount: payments.amount,
      currency: payments.currency,
      description: payments.description,
      voucherNumber: vouchers.voucherNumber,
    })
    .from(payments)
    .leftJoin(vouchers, eq(payments.voucherId, vouchers.id))
    .where(eq(payments.patientId, patientId));

  const lines: PatientStatementLine[] = [
    ...chargeRows.map((row) => ({
      kind: "charge" as const,
      id: row.id,
      date: row.createdAt,
      amount: row.amount,
      currency: row.currency,
      description: row.description,
      voucherNumber: null,
    })),
    ...paymentRows.map((row) => ({
      kind: "payment" as const,
      id: row.id,
      date: row.createdAt,
      amount: row.amount,
      currency: row.currency,
      description: row.description,
      voucherNumber: row.voucherNumber ?? null,
    })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  // Balance per currency (charges − payments, never mixed).
  const balances = new Map<Currency, number>();
  for (const line of lines) {
    const minor = Math.round(parseFloat(line.amount) * 100);
    const current = balances.get(line.currency) ?? 0;
    balances.set(
      line.currency,
      line.kind === "charge" ? current + minor : current - minor
    );
  }

  return { patient, lines, balances };
}

/* ------------------------------------------------------------------ */
/* Doctor statement (own work + commissions + commission payments)     */
/* ------------------------------------------------------------------ */

export async function getDoctorStatement(doctorId: string) {
  const [doctor] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, doctorId))
    .limit(1);
  if (!doctor) {
    return null;
  }

  // Commission rows with their payment voucher links.
  const commissionRows = await db
    .select({
      id: commissions.id,
      createdAt: commissions.createdAt,
      basis: commissions.basis,
      baseAmount: commissions.baseAmount,
      amount: commissions.amount,
      currency: commissions.currency,
      status: commissions.status,
      paidVoucherNumber: vouchers.voucherNumber,
    })
    .from(commissions)
    .leftJoin(vouchers, eq(commissions.paidVoucherId, vouchers.id))
    .where(eq(commissions.doctorId, doctorId))
    .orderBy(desc(commissions.createdAt))
    .limit(200);

  // All-time completed work summary for this doctor.
  const workSummary = await getWorkSummary(
    new Date(Date.UTC(2000, 0, 1)),
    new Date(Date.UTC(2100, 0, 1)),
    { doctorId }
  );

  return { doctor, commissionRows, workSummary };
}

/* ------------------------------------------------------------------ */
/* Lab statement                                                       */
/* ------------------------------------------------------------------ */

export async function getLabStatement(labId: string) {
  const [lab] = await db
    .select()
    .from(labs)
    .where(eq(labs.id, labId))
    .limit(1);
  if (!lab) {
    return null;
  }

  const caseRows = await db
    .select({
      id: labCases.id,
      caseNumber: labCases.caseNumber,
      patientName: patients.fullName,
      workType: labCases.workType,
      cost: labCases.cost,
      invoiceAmount: labCases.invoiceAmount,
      currency: labCases.currency,
      status: labCases.status,
      invoiced: labCases.invoiced,
      invoicedAt: labCases.invoicedAt,
      sentAt: labCases.sentAt,
      expectedDeliveryAt: labCases.expectedDeliveryAt,
    })
    .from(labCases)
    .innerJoin(patients, eq(labCases.patientId, patients.id))
    .where(eq(labCases.labId, labId))
    .orderBy(desc(labCases.createdAt))
    .limit(200);

  const paymentRows = await db
    .select({
      id: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      amount: vouchers.amount,
      currency: vouchers.currency,
      voucherDate: vouchers.voucherDate,
      status: vouchers.status,
      reversalOfVoucherId: vouchers.reversalOfVoucherId,
      description: vouchers.description,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.partyType, "LAB"),
        eq(vouchers.type, "PAYMENT"),
        eq(vouchers.labId, labId)
      )
    )
    .orderBy(desc(vouchers.voucherDate));

  // Balance per currency: invoiced non-cancelled cases − net payments.
  const balances = new Map<Currency, number>();
  for (const row of caseRows) {
    if (!row.invoiced || row.status === "CANCELLED") continue;
    const minor = Math.round(parseFloat(row.invoiceAmount ?? row.cost) * 100);
    balances.set(row.currency, (balances.get(row.currency) ?? 0) + minor);
  }
  for (const payment of paymentRows) {
    const minor = Math.round(parseFloat(payment.amount) * 100);
    const sign = payment.reversalOfVoucherId ? -1 : 1;
    balances.set(
      payment.currency,
      (balances.get(payment.currency) ?? 0) - sign * minor
    );
  }

  return { lab, caseRows, paymentRows, balances };
}

/* ------------------------------------------------------------------ */
/* Supplier statement                                                  */
/* ------------------------------------------------------------------ */

export async function getSupplierStatement(supplierId: string) {
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.id, supplierId))
    .limit(1);
  if (!supplier) {
    return null;
  }

  const invoiceRows = await db
    .select({
      id: purchaseInvoices.id,
      invoiceNumber: purchaseInvoices.invoiceNumber,
      supplierRef: purchaseInvoices.supplierRef,
      invoiceDate: purchaseInvoices.invoiceDate,
      currency: purchaseInvoices.currency,
      totalAmount: purchaseInvoices.totalAmount,
      status: purchaseInvoices.status,
    })
    .from(purchaseInvoices)
    .where(eq(purchaseInvoices.supplierId, supplierId))
    .orderBy(desc(purchaseInvoices.invoiceDate))
    .limit(200);

  const paymentRows = await db
    .select({
      id: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      amount: vouchers.amount,
      currency: vouchers.currency,
      voucherDate: vouchers.voucherDate,
      status: vouchers.status,
      reversalOfVoucherId: vouchers.reversalOfVoucherId,
      description: vouchers.description,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.partyType, "SUPPLIER"),
        eq(vouchers.type, "PAYMENT"),
        eq(vouchers.supplierId, supplierId)
      )
    )
    .orderBy(desc(vouchers.voucherDate));

  const balances = new Map<Currency, number>();
  for (const row of invoiceRows) {
    if (row.status !== "ACTIVE") continue;
    const minor = Math.round(parseFloat(row.totalAmount) * 100);
    balances.set(row.currency, (balances.get(row.currency) ?? 0) + minor);
  }
  for (const payment of paymentRows) {
    const minor = Math.round(parseFloat(payment.amount) * 100);
    const sign = payment.reversalOfVoucherId ? -1 : 1;
    balances.set(
      payment.currency,
      (balances.get(payment.currency) ?? 0) - sign * minor
    );
  }

  return { supplier, invoiceRows, paymentRows, balances };
}
