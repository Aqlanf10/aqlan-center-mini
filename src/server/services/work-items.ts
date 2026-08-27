import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { services, users, visitWorkItems, visits, patients } from "@/db/schema";
import type { Currency } from "@/db/schema/enums";
import { toMinorUnits, fromMinorUnits } from "@/lib/money";
import { getAppDayRangeUtc } from "@/lib/datetime";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import type { Actor } from "@/server/finance/vouchers";
import { generateCommissionsForCompletedVisit } from "@/server/commissions/engine";

export type WorkItemResult =
  | { ok: true; id: string }
  | { ok: false; code: "notFound" | "visitLocked" | "serviceInactive" | "failed" };

export type WorkItemInput = {
  serviceId: string;
  doctorId: string;
  quantity: string;
  unitPrice: string;
  discount?: string | null;
  currency: Currency;
  notes?: string | null;
};

/**
 * Compute a work item total in integer minor units (never float math):
 * total = round(quantity × unitPrice − discount).
 */
export function computeWorkItemTotal(input: {
  quantity: string;
  unitPrice: string;
  discount?: string | null;
}): string {
  const qty = Math.round(parseFloat(input.quantity) * 100);
  const price = toMinorUnits(input.unitPrice);
  const discount = input.discount
    ? toMinorUnits(input.discount)
    : 0;
  const total = Math.round((qty * price) / 100) - discount;
  return fromMinorUnits(Math.max(total, 0));
}

/** Work items are only editable while the visit is a DRAFT. */
async function requireEditableVisit(
  visitId: string
): Promise<{ id: string; status: string } | null> {
  const [visit] = await db
    .select({ id: visits.id, status: visits.status })
    .from(visits)
    .where(eq(visits.id, visitId))
    .limit(1);
  return visit ?? null;
}

export async function addWorkItem(
  actor: Actor,
  visitId: string,
  input: WorkItemInput
): Promise<WorkItemResult> {
  const visit = await requireEditableVisit(visitId);
  if (!visit) {
    return { ok: false, code: "notFound" };
  }
  if (visit.status !== "DRAFT") {
    return { ok: false, code: "visitLocked" };
  }

  const [service] = await db
    .select({ id: services.id, active: services.active, currency: services.currency })
    .from(services)
    .where(eq(services.id, input.serviceId))
    .limit(1);
  if (!service || !service.active) {
    return { ok: false, code: "serviceInactive" };
  }

  const total = computeWorkItemTotal(input);

  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(visitWorkItems)
        .values({
          visitId,
          serviceId: input.serviceId,
          doctorId: input.doctorId,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          discount: input.discount ?? "0",
          total,
          currency: input.currency,
          notes: input.notes ?? null,
          status: "ACTIVE",
          createdBy: actor.id,
        })
        .returning({ id: visitWorkItems.id });
      if (!created) return null;

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.WORK_ITEM_CREATED,
          entityType: "work_item",
          entityId: created.id,
          metadata: { visitId, serviceId: input.serviceId, total },
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

export async function updateWorkItem(
  actor: Actor,
  workItemId: string,
  input: WorkItemInput
): Promise<WorkItemResult> {
  const [item] = await db
    .select({ id: visitWorkItems.id, visitId: visitWorkItems.visitId })
    .from(visitWorkItems)
    .where(eq(visitWorkItems.id, workItemId))
    .limit(1);
  if (!item) {
    return { ok: false, code: "notFound" };
  }
  const visit = await requireEditableVisit(item.visitId);
  if (!visit) {
    return { ok: false, code: "notFound" };
  }
  if (visit.status !== "DRAFT") {
    return { ok: false, code: "visitLocked" };
  }

  const total = computeWorkItemTotal(input);

  await db
    .update(visitWorkItems)
    .set({
      serviceId: input.serviceId,
      doctorId: input.doctorId,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      discount: input.discount ?? "0",
      total,
      currency: input.currency,
      notes: input.notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(visitWorkItems.id, workItemId));

  await recordAudit({
    userId: actor.id,
    action: AUDIT_ACTIONS.WORK_ITEM_UPDATED,
    entityType: "work_item",
    entityId: workItemId,
    metadata: { visitId: item.visitId, total },
  });

  return { ok: true, id: workItemId };
}

/** Cancel (not delete) a work item — draft visits only. */
export async function cancelWorkItem(
  actor: Actor,
  workItemId: string
): Promise<WorkItemResult> {
  const [item] = await db
    .select({ id: visitWorkItems.id, visitId: visitWorkItems.visitId })
    .from(visitWorkItems)
    .where(eq(visitWorkItems.id, workItemId))
    .limit(1);
  if (!item) {
    return { ok: false, code: "notFound" };
  }
  const visit = await requireEditableVisit(item.visitId);
  if (!visit) {
    return { ok: false, code: "notFound" };
  }
  if (visit.status !== "DRAFT") {
    return { ok: false, code: "visitLocked" };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(visitWorkItems)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(visitWorkItems.id, workItemId));
    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.WORK_ITEM_CANCELLED,
        entityType: "work_item",
        entityId: workItemId,
        metadata: { visitId: item.visitId },
      },
      tx
    );
  });

  return { ok: true, id: workItemId };
}

/* ------------------------------------------------------------------ */
/* Aggregations                                                        */
/* ------------------------------------------------------------------ */

export type WorkItemRow = {
  id: string;
  visitId: string;
  serviceId: string;
  serviceCode: string;
  serviceNameAr: string;
  serviceNameEn: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientFileNumber: string;
  patientName: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  total: string;
  currency: Currency;
  notes: string | null;
  status: string;
  visitDate: Date;
};

export async function listVisitWorkItems(visitId: string): Promise<WorkItemRow[]> {
  const rows = await db
    .select({
      id: visitWorkItems.id,
      visitId: visitWorkItems.visitId,
      serviceId: visitWorkItems.serviceId,
      serviceCode: services.code,
      serviceNameAr: services.nameAr,
      serviceNameEn: services.nameEn,
      doctorId: visitWorkItems.doctorId,
      doctorName: users.name,
      patientId: visits.patientId,
      patientFileNumber: patients.fileNumber,
      patientName: patients.fullName,
      quantity: visitWorkItems.quantity,
      unitPrice: visitWorkItems.unitPrice,
      discount: visitWorkItems.discount,
      total: visitWorkItems.total,
      currency: visitWorkItems.currency,
      notes: visitWorkItems.notes,
      status: visitWorkItems.status,
      visitDate: visits.visitDate,
    })
    .from(visitWorkItems)
    .innerJoin(services, eq(visitWorkItems.serviceId, services.id))
    .innerJoin(users, eq(visitWorkItems.doctorId, users.id))
    .innerJoin(visits, eq(visitWorkItems.visitId, visits.id))
    .innerJoin(patients, eq(visits.patientId, patients.id))
    .where(eq(visitWorkItems.visitId, visitId))
    .orderBy(asc(visitWorkItems.createdAt));

  return rows as WorkItemRow[];
}

export type WorkSummaryRow = {
  key: string;
  serviceId: string;
  serviceNameAr: string;
  serviceNameEn: string;
  doctorId: string;
  doctorName: string;
  currency: Currency;
  count: number;
  totalMinor: number;
};

/**
 * Completed-work summary grouped by (service, doctor, currency).
 * Only ACTIVE items on COMPLETED visits inside the window count; cancelled
 * items are reported separately (never silently dropped).
 */
export async function getWorkSummary(
  startUtc: Date,
  endUtc: Date,
  filter?: { doctorId?: string; serviceId?: string }
): Promise<WorkSummaryRow[]> {
  const conditions = [
    eq(visits.status, "COMPLETED"),
    eq(visitWorkItems.status, "ACTIVE"),
    gte(visits.visitDate, startUtc),
    lt(visits.visitDate, endUtc),
  ];
  if (filter?.doctorId) {
    conditions.push(eq(visitWorkItems.doctorId, filter.doctorId));
  }
  if (filter?.serviceId) {
    conditions.push(eq(visitWorkItems.serviceId, filter.serviceId));
  }

  const rows = await db
    .select({
      serviceId: visitWorkItems.serviceId,
      serviceNameAr: services.nameAr,
      serviceNameEn: services.nameEn,
      doctorId: visitWorkItems.doctorId,
      doctorName: users.name,
      currency: visitWorkItems.currency,
      count: sql<number>`count(*)::int`,
      total: sql<string>`sum(${visitWorkItems.total})`,
    })
    .from(visitWorkItems)
    .innerJoin(services, eq(visitWorkItems.serviceId, services.id))
    .innerJoin(users, eq(visitWorkItems.doctorId, users.id))
    .innerJoin(visits, eq(visitWorkItems.visitId, visits.id))
    .where(and(...conditions))
    .groupBy(
      visitWorkItems.serviceId,
      services.nameAr,
      services.nameEn,
      visitWorkItems.doctorId,
      users.name,
      visitWorkItems.currency
    );

  return rows.map((row) => ({
    key: `${row.serviceId}:${row.doctorId}:${row.currency}`,
    serviceId: row.serviceId,
    serviceNameAr: row.serviceNameAr,
    serviceNameEn: row.serviceNameEn,
    doctorId: row.doctorId,
    doctorName: row.doctorName,
    currency: row.currency,
    count: row.count,
    totalMinor: toMinorUnits(row.total ?? "0"),
  }));
}

/** Today's completed work in the clinic timezone (Asia/Aden). */
export function getTodayWorkSummary(filter?: { doctorId?: string }) {
  const { startUtc, endUtc } = getAppDayRangeUtc(new Date());
  return getWorkSummary(startUtc, endUtc, filter);
}

/** Detailed completed work rows for a day (drill-down from the summary). */
export async function getDayWorkItems(
  startUtc: Date,
  endUtc: Date,
  filter?: { doctorId?: string; serviceId?: string }
): Promise<WorkItemRow[]> {
  const conditions = [
    eq(visits.status, "COMPLETED"),
    gte(visits.visitDate, startUtc),
    lt(visits.visitDate, endUtc),
  ];
  if (filter?.doctorId) {
    conditions.push(eq(visitWorkItems.doctorId, filter.doctorId));
  }
  if (filter?.serviceId) {
    conditions.push(eq(visitWorkItems.serviceId, filter.serviceId));
  }

  const rows = await db
    .select({
      id: visitWorkItems.id,
      visitId: visitWorkItems.visitId,
      serviceId: visitWorkItems.serviceId,
      serviceCode: services.code,
      serviceNameAr: services.nameAr,
      serviceNameEn: services.nameEn,
      doctorId: visitWorkItems.doctorId,
      doctorName: users.name,
      patientId: visits.patientId,
      patientFileNumber: patients.fileNumber,
      patientName: patients.fullName,
      quantity: visitWorkItems.quantity,
      unitPrice: visitWorkItems.unitPrice,
      discount: visitWorkItems.discount,
      total: visitWorkItems.total,
      currency: visitWorkItems.currency,
      notes: visitWorkItems.notes,
      status: visitWorkItems.status,
      visitDate: visits.visitDate,
    })
    .from(visitWorkItems)
    .innerJoin(services, eq(visitWorkItems.serviceId, services.id))
    .innerJoin(users, eq(visitWorkItems.doctorId, users.id))
    .innerJoin(visits, eq(visitWorkItems.visitId, visits.id))
    .innerJoin(patients, eq(visits.patientId, patients.id))
    .where(and(...conditions))
    .orderBy(desc(visits.visitDate));

  return rows as WorkItemRow[];
}

export { generateCommissionsForCompletedVisit };
