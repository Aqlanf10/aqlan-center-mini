import { and, asc, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { labCases, labs, patients, services, users, vouchers } from "@/db/schema";
import type { Currency } from "@/db/schema/enums";
import { getZonedParts } from "@/lib/datetime";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import type { Actor, TxClient } from "@/server/finance/vouchers";

/** Draw the next lab case number LC-YYYY-NNNNNN (atomic sequence). */
async function nextCaseNumber(tx: TxClient, when: Date): Promise<string> {
  const year = getZonedParts(when).year;
  const result = await tx.execute<{ value: string | number }>(
    sql`SELECT nextval('lab_case_number_seq') AS value`
  );
  const rows = Array.isArray(result)
    ? result
    : (result as unknown as { rows: { value: string | number }[] }).rows;
  const value = Number(rows?.[0]?.value ?? 0);
  return `LC-${year}-${String(value).padStart(6, "0")}`;
}

export type LabResult =
  | { ok: true; id: string }
  | { ok: false; code: "notFound" | "duplicate" | "inUse" | "failed" };

/* ------------------------------------------------------------------ */
/* Labs directory                                                      */
/* ------------------------------------------------------------------ */

export function listLabs(includeArchived = false) {
  return db
    .select()
    .from(labs)
    .where(includeArchived ? undefined : eq(labs.active, true))
    .orderBy(asc(labs.name));
}

export async function createLab(
  actor: Actor,
  input: { name: string; phone?: string | null; address?: string | null; notes?: string | null }
): Promise<LabResult> {
  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(labs)
        .values({ ...input, active: true })
        .returning({ id: labs.id });
      if (!created) return null;
      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.LAB_CREATED,
          entityType: "lab",
          entityId: created.id,
        },
        tx
      );
      return created.id;
    });
    return id ? { ok: true, id } : { ok: false, code: "failed" };
  } catch {
    return { ok: false, code: "failed" };
  }
}

export async function updateLab(
  actor: Actor,
  labId: string,
  input: { name: string; phone?: string | null; address?: string | null; notes?: string | null }
): Promise<LabResult> {
  const [existing] = await db
    .select({ id: labs.id })
    .from(labs)
    .where(eq(labs.id, labId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  // Update + audit in ONE transaction (movement without audit impossible).
  await db.transaction(async (tx) => {
    await tx
      .update(labs)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(labs.id, labId));
    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.LAB_UPDATED,
        entityType: "lab",
        entityId: labId,
      },
      tx
    );
  });

  return { ok: true, id: labId };
}

export async function setLabActive(
  actor: Actor,
  labId: string,
  active: boolean
): Promise<LabResult> {
  const [existing] = await db
    .select({ id: labs.id })
    .from(labs)
    .where(eq(labs.id, labId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  // Status change + audit in ONE transaction.
  await db.transaction(async (tx) => {
    await tx.update(labs).set({ active, updatedAt: new Date() }).where(eq(labs.id, labId));
    await recordAudit(
      {
        userId: actor.id,
        action: active ? AUDIT_ACTIONS.LAB_REACTIVATED : AUDIT_ACTIONS.LAB_ARCHIVED,
        entityType: "lab",
        entityId: labId,
      },
      tx
    );
  });

  return { ok: true, id: labId };
}

/* ------------------------------------------------------------------ */
/* Lab cases                                                           */
/* ------------------------------------------------------------------ */


export type LabCaseInput = {
  labId: string;
  patientId: string;
  visitId?: string | null;
  doctorId: string;
  serviceId?: string | null;
  workType: string;
  cost: string;
  currency: Currency;
  status: "ORDERED" | "SENT" | "RECEIVED" | "DELIVERED" | "CANCELLED";
  sentAt?: Date | null;
  expectedDeliveryAt?: Date | null;
  notes?: string | null;
};

export async function createLabCase(
  actor: Actor,
  input: LabCaseInput
): Promise<LabResult> {
  try {
    const id = await db.transaction(async (tx) => {
      const caseNumber = await nextCaseNumber(tx, new Date());
      const [created] = await tx
        .insert(labCases)
        .values({
          caseNumber,
          labId: input.labId,
          patientId: input.patientId,
          visitId: input.visitId ?? null,
          doctorId: input.doctorId,
          serviceId: input.serviceId ?? null,
          workType: input.workType,
          cost: input.cost,
          currency: input.currency,
          status: input.status,
          sentAt: input.sentAt ?? new Date(),
          expectedDeliveryAt: input.expectedDeliveryAt ?? null,
          notes: input.notes ?? null,
          createdBy: actor.id,
        })
        .returning({ id: labCases.id });
      if (!created) return null;

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.LAB_CASE_CREATED,
          entityType: "lab_case",
          entityId: created.id,
          metadata: { caseNumber, labId: input.labId, currency: input.currency },
        },
        tx
      );
      return created.id;
    });
    return id ? { ok: true, id } : { ok: false, code: "failed" };
  } catch {
    return { ok: false, code: "failed" };
  }
}

export async function updateLabCase(
  actor: Actor,
  caseId: string,
  input: Omit<LabCaseInput, "patientId">
): Promise<LabResult> {
  const [existing] = await db
    .select({ id: labCases.id, invoiced: labCases.invoiced })
    .from(labCases)
    .where(eq(labCases.id, caseId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }
  if (existing.invoiced) {
    // Once invoiced, only the delivery status may still change.
    await db.transaction(async (tx) => {
      await tx
        .update(labCases)
        .set({ status: input.status, notes: input.notes ?? null, updatedAt: new Date() })
        .where(eq(labCases.id, caseId));
      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.LAB_CASE_UPDATED,
          entityType: "lab_case",
          entityId: caseId,
          metadata: { invoiced: true, status: input.status },
        },
        tx
      );
    });
    return { ok: true, id: caseId };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(labCases)
      .set({
        labId: input.labId,
        visitId: input.visitId ?? null,
        doctorId: input.doctorId,
        serviceId: input.serviceId ?? null,
        workType: input.workType,
        cost: input.cost,
        currency: input.currency,
        status: input.status,
        sentAt: input.sentAt ?? null,
        expectedDeliveryAt: input.expectedDeliveryAt ?? null,
        notes: input.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(labCases.id, caseId));

    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.LAB_CASE_UPDATED,
        entityType: "lab_case",
        entityId: caseId,
        metadata: { currency: input.currency },
      },
      tx
    );
  });

  return { ok: true, id: caseId };
}

/**
 * Record the lab invoice for a case: the cost becomes an official payable.
 * Once invoiced the case cost is locked (adjustments go through payments).
 */
export async function invoiceLabCase(
  actor: Actor,
  caseId: string,
  input: { invoiceNumber?: string | null; invoiceAmount?: string | null }
): Promise<LabResult> {
  const [existing] = await db
    .select({ id: labCases.id, invoiced: labCases.invoiced, cost: labCases.cost })
    .from(labCases)
    .where(eq(labCases.id, caseId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }
  if (existing.invoiced) {
    return { ok: false, code: "duplicate" };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(labCases)
      .set({
        invoiced: true,
        invoiceNumber: input.invoiceNumber ?? null,
        invoiceAmount: input.invoiceAmount ?? existing.cost,
        invoicedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(labCases.id, caseId));
    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.LAB_CASE_INVOICED,
        entityType: "lab_case",
        entityId: caseId,
        metadata: { invoiceNumber: input.invoiceNumber ?? undefined },
      },
      tx
    );
  });

  return { ok: true, id: caseId };
}

/* ------------------------------------------------------------------ */
/* Queries & balances                                                  */
/* ------------------------------------------------------------------ */

export type LabCaseRow = {
  id: string;
  caseNumber: string;
  labId: string;
  labName: string;
  patientId: string;
  patientFileNumber: string;
  patientName: string;
  visitId: string | null;
  doctorId: string;
  doctorName: string;
  serviceId: string | null;
  serviceNameAr: string | null;
  workType: string;
  cost: string;
  currency: Currency;
  status: string;
  sentAt: Date | null;
  expectedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  invoiced: boolean;
  invoiceNumber: string | null;
  invoiceAmount: string | null;
  notes: string | null;
  createdAt: Date;
};

export async function listLabCases(filter?: {
  labId?: string;
  status?: string;
  patientId?: string;
  limit?: number;
}): Promise<LabCaseRow[]> {
  const conditions = [];
  if (filter?.labId) conditions.push(eq(labCases.labId, filter.labId));
  if (filter?.status) {
    conditions.push(eq(labCases.status, filter.status as "ORDERED"));
  }
  if (filter?.patientId) conditions.push(eq(labCases.patientId, filter.patientId));

  const rows = await db
    .select({
      id: labCases.id,
      caseNumber: labCases.caseNumber,
      labId: labCases.labId,
      labName: labs.name,
      patientId: labCases.patientId,
      patientFileNumber: patients.fileNumber,
      patientName: patients.fullName,
      visitId: labCases.visitId,
      doctorId: labCases.doctorId,
      doctorName: users.name,
      serviceId: labCases.serviceId,
      serviceNameAr: services.nameAr,
      workType: labCases.workType,
      cost: labCases.cost,
      currency: labCases.currency,
      status: labCases.status,
      sentAt: labCases.sentAt,
      expectedDeliveryAt: labCases.expectedDeliveryAt,
      deliveredAt: labCases.deliveredAt,
      invoiced: labCases.invoiced,
      invoiceNumber: labCases.invoiceNumber,
      invoiceAmount: labCases.invoiceAmount,
      notes: labCases.notes,
      createdAt: labCases.createdAt,
    })
    .from(labCases)
    .innerJoin(labs, eq(labCases.labId, labs.id))
    .innerJoin(patients, eq(labCases.patientId, patients.id))
    .innerJoin(users, eq(labCases.doctorId, users.id))
    .leftJoin(services, eq(labCases.serviceId, services.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(labCases.createdAt))
    .limit(filter?.limit ?? 200);

  return rows as LabCaseRow[];
}

export type LabBalanceRow = {
  labId: string;
  labName: string;
  currency: Currency;
  invoicedMinor: number;
  paidMinor: number;
  balanceMinor: number;
  openCases: number;
  overdueCases: number;
};

/**
 * Lab balances derived from real movements (never stored):
 *   balance = Σ invoiced case amounts − Σ payment vouchers to the lab,
 * per currency. Open/overdue cases come from status + expected delivery.
 *
 * SINGLE SOURCE OF TRUTH for lab balances: the finance screen, period
 * report and the lab statement MUST call this (or getLabBalance below) —
 * never a page-local recomputation.
 */
export async function getLabBalances(): Promise<LabBalanceRow[]> {
  const invoiced = await db
    .select({
      labId: labCases.labId,
      labName: labs.name,
      currency: labCases.currency,
      total: sql<string>`sum(${labCases.invoiceAmount})`,
      openCases: sql<number>`count(*) FILTER (WHERE ${labCases.status} IN ('ORDERED','SENT','RECEIVED'))::int`,
      overdueCases: sql<number>`count(*) FILTER (WHERE ${labCases.status} IN ('ORDERED','SENT','RECEIVED') AND ${labCases.expectedDeliveryAt} < now())::int`,
    })
    .from(labCases)
    .innerJoin(labs, eq(labCases.labId, labs.id))
    .where(and(eq(labCases.invoiced, true), sql`${labCases.status} <> 'CANCELLED'`))
    .groupBy(labCases.labId, labs.name, labCases.currency);

  const paid = await db
    .select({
      labId: vouchers.labId,
      currency: vouchers.currency,
      paid: sql<string>`sum(CASE WHEN ${vouchers.reversalOfVoucherId} IS NULL THEN ${vouchers.amount} ELSE -${vouchers.amount} END)`,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.partyType, "LAB"),
        eq(vouchers.type, "PAYMENT")
      )
    )
    .groupBy(vouchers.labId, vouchers.currency);

  const paidMap = new Map<string, number>();
  for (const row of paid) {
    if (!row.labId) continue;
    paidMap.set(
      `${row.labId}:${row.currency}`,
      Math.round(parseFloat(row.paid ?? "0") * 100)
    );
  }

  return invoiced.map((row) => {
    const invoicedMinor = Math.round(parseFloat(row.total ?? "0") * 100);
    const paidMinor = paidMap.get(`${row.labId}:${row.currency}`) ?? 0;
    return {
      labId: row.labId,
      labName: row.labName,
      currency: row.currency,
      invoicedMinor,
      paidMinor,
      balanceMinor: invoicedMinor - paidMinor,
      openCases: row.openCases,
      overdueCases: row.overdueCases,
    };
  });
}

/**
 * One lab's balance per currency, derived through the SAME domain query as
 * the finance screen and reports (getLabBalances). This is the only
 * sanctioned way for a single-lab view (statement) to obtain its balance.
 */
export async function getLabBalance(labId: string): Promise<Map<Currency, number>> {
  const rows = await getLabBalances();
  const balances = new Map<Currency, number>();
  for (const row of rows) {
    if (row.labId === labId) {
      balances.set(row.currency, row.balanceMinor);
    }
  }
  return balances;
}

/** Payments made to a lab (statement lines). */
export async function getLabPayments(labId: string, currency?: Currency) {
  const conditions = [
    eq(vouchers.partyType, "LAB"),
    eq(vouchers.type, "PAYMENT"),
    eq(vouchers.labId, labId),
  ];
  if (currency) conditions.push(eq(vouchers.currency, currency));

  return db
    .select({
      id: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      amount: vouchers.amount,
      currency: vouchers.currency,
      voucherDate: vouchers.voucherDate,
      status: vouchers.status,
      reversalOfVoucherId: vouchers.reversalOfVoucherId,
      labCaseId: vouchers.labCaseId,
      description: vouchers.description,
    })
    .from(vouchers)
    .where(and(...conditions))
    .orderBy(desc(vouchers.voucherDate));
}
