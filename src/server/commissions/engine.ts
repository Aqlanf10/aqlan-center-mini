import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  commissions,
  doctorCommissionPlans,
  services,
  users,
  vouchers,
  visitWorkItems,
} from "@/db/schema";
import type { Currency } from "@/db/schema/enums";
import { toMinorUnits, fromMinorUnits } from "@/lib/money";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { findIdempotentEntityId } from "@/server/idempotency";
import type { Actor, TxClient, VoucherResult } from "@/server/finance/vouchers";
import { createPaymentVoucher } from "@/server/finance/vouchers";

export type CommissionResult =
  | { ok: true; id: string }
  | { ok: false; code: "notFound" | "notPending" | "noAmount" | "alreadyPaid" | "failed" };

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

/**
 * Resolve the applicable plan for a (doctor, service): the per-service plan
 * wins over the doctor default (service_id IS NULL).
 */
export async function resolvePlan(
  doctorId: string,
  serviceId: string
): Promise<{
  basis: "WORK_VALUE" | "COLLECTED";
  type: "PERCENT" | "FIXED";
  value: string;
} | null> {
  const plans = await db
    .select({
      serviceId: doctorCommissionPlans.serviceId,
      basis: doctorCommissionPlans.basis,
      type: doctorCommissionPlans.type,
      value: doctorCommissionPlans.value,
    })
    .from(doctorCommissionPlans)
    .where(
      and(
        eq(doctorCommissionPlans.doctorId, doctorId),
        eq(doctorCommissionPlans.active, true)
      )
    );

  const specific = plans.find((p) => p.serviceId === serviceId);
  const general = plans.find((p) => p.serviceId === null);
  const chosen = specific ?? general;
  return chosen
    ? { basis: chosen.basis, type: chosen.type, value: chosen.value }
    : null;
}

export async function savePlan(
  actor: Actor,
  input: {
    doctorId: string;
    serviceId?: string | null;
    basis: "WORK_VALUE" | "COLLECTED";
    type: "PERCENT" | "FIXED";
    value: string;
  }
): Promise<{ ok: true; id: string } | { ok: false; code: "failed" }> {
  try {
    const id = await db.transaction(async (tx) => {
      // Upsert on (doctor, service) — one row per pair.
      const [row] = await tx
        .insert(doctorCommissionPlans)
        .values({
          doctorId: input.doctorId,
          serviceId: input.serviceId ?? null,
          basis: input.basis,
          type: input.type,
          value: input.value,
          active: true,
        })
        .onConflictDoUpdate({
          target: [
            doctorCommissionPlans.doctorId,
            doctorCommissionPlans.serviceId,
          ],
          set: {
            basis: input.basis,
            type: input.type,
            value: input.value,
            active: true,
            updatedAt: new Date(),
          },
        })
        .returning({ id: doctorCommissionPlans.id });
      if (!row) return null;

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.COMMISSION_PLAN_SAVED,
          entityType: "commission_plan",
          entityId: row.id,
          metadata: {
            doctorId: input.doctorId,
            serviceId: input.serviceId ?? undefined,
            basis: input.basis,
            type: input.type,
          },
        },
        tx
      );
      return row.id;
    });
    return id ? { ok: true, id } : { ok: false, code: "failed" };
  } catch {
    return { ok: false, code: "failed" };
  }
}

export async function deletePlan(
  actor: Actor,
  planId: string
): Promise<{ ok: true } | { ok: false; code: "notFound" }> {
  const [existing] = await db
    .select({ id: doctorCommissionPlans.id })
    .from(doctorCommissionPlans)
    .where(eq(doctorCommissionPlans.id, planId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(doctorCommissionPlans)
      .where(eq(doctorCommissionPlans.id, planId));
    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.COMMISSION_PLAN_DELETED,
        entityType: "commission_plan",
        entityId: planId,
      },
      tx
    );
  });

  return { ok: true };
}

export function listPlans(doctorId?: string) {
  return db
    .select({
      id: doctorCommissionPlans.id,
      doctorId: doctorCommissionPlans.doctorId,
      doctorName: users.name,
      serviceId: doctorCommissionPlans.serviceId,
      serviceCode: services.code,
      serviceNameAr: services.nameAr,
      serviceNameEn: services.nameEn,
      basis: doctorCommissionPlans.basis,
      type: doctorCommissionPlans.type,
      value: doctorCommissionPlans.value,
      active: doctorCommissionPlans.active,
    })
    .from(doctorCommissionPlans)
    .innerJoin(users, eq(doctorCommissionPlans.doctorId, users.id))
    .leftJoin(services, eq(doctorCommissionPlans.serviceId, services.id))
    .where(
      doctorId
        ? eq(doctorCommissionPlans.doctorId, doctorId)
        : undefined
    )
    .orderBy(desc(doctorCommissionPlans.updatedAt));
}

/* ------------------------------------------------------------------ */
/* Commission amount computation (pure, unit-testable)                */
/* ------------------------------------------------------------------ */

/** Percent of the base or a fixed amount, in integer minor units. */
export function computeCommissionAmount(input: {
  type: "PERCENT" | "FIXED";
  value: string;
  baseAmount: string;
}): number {
  const base = toMinorUnits(input.baseAmount);
  if (input.type === "FIXED") {
    return toMinorUnits(input.value);
  }
  const percent = toMinorUnits(input.value); // e.g. 25.00% -> 2500 minor
  return Math.round((base * percent) / 10000);
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Generate WORK_VALUE commissions for every ACTIVE work item of a visit,
 * called when the visit transitions to COMPLETED. Runs INSIDE the visit's
 * completion transaction so work items and commissions commit together.
 *
 * - service.commissionEligible must be true.
 * - The plan (type/value/basis) is SNAPSHOTTED onto the commission row.
 * - No plan configured → commission stays PENDING with amount NULL
 *   (no entitlement, no payment) until ADMIN configures/approves.
 * - Uniqueness: one commission per work item (partial unique index).
 */
export async function generateCommissionsForCompletedVisit(
  tx: TxClient,
  visitId: string,
  actorId: string
): Promise<void> {
  const items = await tx
    .select({
      id: visitWorkItems.id,
      doctorId: visitWorkItems.doctorId,
      serviceId: visitWorkItems.serviceId,
      total: visitWorkItems.total,
      currency: visitWorkItems.currency,
    })
    .from(visitWorkItems)
    .where(
      and(
        eq(visitWorkItems.visitId, visitId),
        eq(visitWorkItems.status, "ACTIVE")
      )
    );

  for (const item of items) {
    const [service] = await tx
      .select({ commissionEligible: services.commissionEligible })
      .from(services)
      .where(eq(services.id, item.serviceId))
      .limit(1);
    if (!service?.commissionEligible) {
      continue;
    }

    // Plans live in the same database — read through the transaction.
    const plans = await tx
      .select({
        serviceId: doctorCommissionPlans.serviceId,
        basis: doctorCommissionPlans.basis,
        type: doctorCommissionPlans.type,
        value: doctorCommissionPlans.value,
      })
      .from(doctorCommissionPlans)
      .where(
        and(
          eq(doctorCommissionPlans.doctorId, item.doctorId),
          eq(doctorCommissionPlans.active, true)
        )
      );
    const specific = plans.find((p) => p.serviceId === item.serviceId);
    const general = plans.find((p) => p.serviceId === null);
    const plan = specific ?? general ?? null;

    // Only WORK_VALUE commissions are generated on completion; COLLECTED
    // commissions are generated per receipt (generateCollectedCommission).
    if (plan && plan.basis === "COLLECTED") {
      continue;
    }

    const amount = plan
      ? fromMinorUnits(
          computeCommissionAmount({
            type: plan.type,
            value: plan.value,
            baseAmount: item.total,
          })
        )
      : null;

    await tx
      .insert(commissions)
      .values({
        doctorId: item.doctorId,
        workItemId: item.id,
        basis: "WORK_VALUE",
        planType: plan?.type ?? null,
        planValue: plan?.value ?? null,
        baseAmount: item.total,
        currency: item.currency,
        amount,
        status: "PENDING",
        createdBy: actorId,
      })
      .onConflictDoNothing({
        target: [commissions.workItemId],
        where: sql`basis = 'WORK_VALUE' AND work_item_id IS NOT NULL`,
      });

    await recordAudit(
      {
        userId: actorId,
        action: AUDIT_ACTIONS.COMMISSION_GENERATED,
        entityType: "commission",
        entityId: item.id,
        metadata: {
          workItemId: item.id,
          visitId,
          doctorId: item.doctorId,
          basis: "WORK_VALUE",
          planned: Boolean(plan),
        },
      },
      tx
    );
  }
}

/**
 * Generate a COLLECTED-basis commission for a receipt explicitly linked to
 * a work item. Called from the receipt-voucher flow INSIDE its transaction.
 */
export async function generateCollectedCommission(
  tx: TxClient,
  sourceVoucherId: string,
  workItemId: string,
  actorId: string
): Promise<void> {
  const [item] = await tx
    .select({
      id: visitWorkItems.id,
      doctorId: visitWorkItems.doctorId,
      serviceId: visitWorkItems.serviceId,
      total: visitWorkItems.total,
      currency: visitWorkItems.currency,
    })
    .from(visitWorkItems)
    .where(eq(visitWorkItems.id, workItemId))
    .limit(1);
  if (!item) {
    return;
  }

  const [service] = await tx
    .select({ commissionEligible: services.commissionEligible })
    .from(services)
    .where(eq(services.id, item.serviceId))
    .limit(1);
  if (!service?.commissionEligible) {
    return;
  }

  const plans = await tx
    .select({
      serviceId: doctorCommissionPlans.serviceId,
      basis: doctorCommissionPlans.basis,
      type: doctorCommissionPlans.type,
      value: doctorCommissionPlans.value,
    })
    .from(doctorCommissionPlans)
    .where(
      and(
        eq(doctorCommissionPlans.doctorId, item.doctorId),
        eq(doctorCommissionPlans.active, true)
      )
    );
  const specific = plans.find((p) => p.serviceId === item.serviceId);
  const general = plans.find((p) => p.serviceId === null);
  const plan = specific ?? general ?? null;

  // Only COLLECTED-basis plans earn on collection.
  if (!plan || plan.basis !== "COLLECTED") {
    return;
  }

  const [voucher] = await tx
    .select({ amount: vouchers.amount })
    .from(vouchers)
    .where(eq(vouchers.id, sourceVoucherId))
    .limit(1);
  if (!voucher) {
    return;
  }

  const amount = fromMinorUnits(
    computeCommissionAmount({
      type: plan.type,
      value: plan.value,
      baseAmount: voucher.amount,
    })
  );

  await tx
    .insert(commissions)
    .values({
      doctorId: item.doctorId,
      workItemId: item.id,
      sourceVoucherId,
      basis: "COLLECTED",
      planType: plan.type,
      planValue: plan.value,
      baseAmount: voucher.amount,
      currency: item.currency,
      amount,
      status: "PENDING",
      createdBy: actorId,
    })
    .onConflictDoNothing({
      target: [commissions.workItemId, commissions.sourceVoucherId],
      where: sql`basis = 'COLLECTED' AND work_item_id IS NOT NULL AND source_voucher_id IS NOT NULL`,
    });

  await recordAudit(
    {
      userId: actorId,
      action: AUDIT_ACTIONS.COMMISSION_GENERATED,
      entityType: "commission",
      entityId: sourceVoucherId,
      metadata: {
        workItemId: item.id,
        sourceVoucherId,
        doctorId: item.doctorId,
        basis: "COLLECTED",
      },
    },
    tx
  );
}

/** Reverse COLLECTED commissions raised from a reversed receipt voucher. */
export async function reverseCollectedCommissionsForVoucher(
  tx: TxClient,
  sourceVoucherId: string,
  actorId: string
): Promise<void> {
  await tx
    .update(commissions)
    .set({
      status: "REVERSED",
      reversalReason: "عكس سند القبض المرتبط",
      reversedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commissions.sourceVoucherId, sourceVoucherId),
        sql`${commissions.status} IN ('PENDING', 'APPROVED')`
      )
    );

  await recordAudit(
    {
      userId: actorId,
      action: AUDIT_ACTIONS.COMMISSION_REVERSED,
      entityType: "commission",
      entityId: sourceVoucherId,
      metadata: { sourceVoucherId, reason: "receipt-reversed" },
    },
    tx
  );
}

/** Re-open a paid commission when its payment voucher is reversed. */
export async function reopenPaidCommissionForVoucher(
  tx: TxClient,
  paidVoucherId: string,
  actorId: string
): Promise<void> {
  const reopened = await tx
    .update(commissions)
    .set({
      status: "APPROVED",
      paidVoucherId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commissions.paidVoucherId, paidVoucherId),
        eq(commissions.status, "PAID")
      )
    )
    .returning({ id: commissions.id });

  for (const commission of reopened) {
    await recordAudit(
      {
        userId: actorId,
        action: AUDIT_ACTIONS.COMMISSION_PAYMENT_REVERSED,
        entityType: "commission",
        entityId: commission.id,
        metadata: { reason: "payment-voucher-reversed", paidVoucherId },
      },
      tx
    );
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle: set amount, approve, pay, reverse                       */
/* ------------------------------------------------------------------ */

/** ADMIN sets/overrides the amount of a PENDING commission manually. */
export async function setCommissionAmount(
  actor: Actor,
  commissionId: string,
  amount: string
): Promise<CommissionResult> {
  const [existing] = await db
    .select({ id: commissions.id, status: commissions.status })
    .from(commissions)
    .where(eq(commissions.id, commissionId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }
  if (existing.status !== "PENDING") {
    return { ok: false, code: "notPending" };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(commissions)
      .set({ amount, updatedAt: new Date() })
      .where(eq(commissions.id, commissionId));
    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.COMMISSION_AMOUNT_SET,
        entityType: "commission",
        entityId: commissionId,
        metadata: { amount },
      },
      tx
    );
  });

  return { ok: true, id: commissionId };
}

/** ADMIN approves a PENDING commission (requires an amount). */
export async function approveCommission(
  actor: Actor,
  commissionId: string
): Promise<CommissionResult> {
  const [existing] = await db
    .select({ id: commissions.id, status: commissions.status, amount: commissions.amount })
    .from(commissions)
    .where(eq(commissions.id, commissionId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }
  if (existing.status !== "PENDING") {
    return { ok: false, code: "notPending" };
  }
  if (!existing.amount) {
    return { ok: false, code: "noAmount" };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(commissions)
      .set({
        status: "APPROVED",
        approvedBy: actor.id,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(commissions.id, commissionId));
    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.COMMISSION_APPROVED,
        entityType: "commission",
        entityId: commissionId,
      },
      tx
    );
  });

  return { ok: true, id: commissionId };
}

/**
 * ADMIN pays an APPROVED commission: creates the payment voucher and marks
 * the commission PAID in ONE transaction (money and ledger move together).
 */
export async function payCommission(
  actor: Actor,
  commissionId: string,
  input: {
    cashAccountId: string;
    paymentMethod: "CASH" | "TRANSFER" | "CARD" | "OTHER";
    description?: string | null;
    reference?: string | null;
    idempotencyKey?: string | null;
  }
): Promise<
  | { ok: true; id: string; voucherId: string; voucherNumber: string }
  | { ok: false; code: "notFound" | "notApproved" | "currencyMismatch" | "failed" }
> {
  const [commission] = await db
    .select({
      id: commissions.id,
      doctorId: commissions.doctorId,
      amount: commissions.amount,
      currency: commissions.currency,
      status: commissions.status,
    })
    .from(commissions)
    .where(eq(commissions.id, commissionId))
    .limit(1);
  if (!commission) {
    return { ok: false, code: "notFound" };
  }

  // A transport retry with the same key returns the committed payout. This
  // check also covers a retry arriving after the first request completed.
  if (input.idempotencyKey) {
    const replay = await findCommissionPaymentReplay(
      commissionId,
      input.idempotencyKey
    );
    if (replay) {
      return {
        ok: true,
        id: commissionId,
        voucherId: replay.id,
        voucherNumber: replay.voucherNumber,
      };
    }
  }

  if (commission.status !== "APPROVED" || !commission.amount) {
    return { ok: false, code: "notApproved" };
  }

  let voucher: VoucherResult;
  try {
    voucher = await createPaymentVoucher(
      actor,
      {
        party: { kind: "DOCTOR", doctorId: commission.doctorId },
        amount: commission.amount,
        currency: commission.currency as Currency,
        cashAccountId: input.cashAccountId,
        paymentMethod: input.paymentMethod,
        description: input.description ?? `عمولة ${commissionId.slice(0, 8)}`,
        reference: input.reference ?? null,
        commissionId: commission.id,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      {
        onVoucherCreated: async (tx, createdVoucher) => {
          // Conditional state transition is the concurrency barrier. If a
          // second request already paid it, throwing rolls its voucher back.
          const [paid] = await tx
            .update(commissions)
            .set({
              status: "PAID",
              paidVoucherId: createdVoucher.id,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(commissions.id, commissionId),
                eq(commissions.status, "APPROVED")
              )
            )
            .returning({ id: commissions.id });

          if (!paid) {
            throw new CommissionPaymentStateError();
          }

          await recordAudit(
            {
              userId: actor.id,
              action: AUDIT_ACTIONS.COMMISSION_PAID,
              entityType: "commission",
              entityId: commissionId,
              metadata: {
                voucherId: createdVoucher.id,
                voucherNumber: createdVoucher.voucherNumber,
              },
            },
            tx
          );
        },
      }
    );
  } catch (error) {
    if (
      error instanceof CommissionPaymentStateError ||
      isActiveCommissionVoucherConflict(error)
    ) {
      if (input.idempotencyKey) {
        const replay = await findCommissionPaymentReplay(
          commissionId,
          input.idempotencyKey
        );
        if (replay) {
          return {
            ok: true,
            id: commissionId,
            voucherId: replay.id,
            voucherNumber: replay.voucherNumber,
          };
        }
      }
      return { ok: false, code: "notApproved" };
    }
    return { ok: false, code: "failed" };
  }

  if (!voucher.ok) {
    return { ok: false, code: voucher.code === "currencyMismatch" ? "currencyMismatch" : "failed" };
  }

  return {
    ok: true,
    id: commissionId,
    voucherId: voucher.id,
    voucherNumber: voucher.voucherNumber,
  };
}

class CommissionPaymentStateError extends Error {
  constructor() {
    super("Commission is no longer approved for payment");
    this.name = "CommissionPaymentStateError";
  }
}

function isActiveCommissionVoucherConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  if (candidate.code !== "23505") return false;
  const detail = `${String(candidate.constraint ?? "")} ${String(candidate.message ?? "")}`;
  return detail.includes("vouchers_active_commission_payment_unique");
}

async function findCommissionPaymentReplay(
  commissionId: string,
  idempotencyKey: string
): Promise<{ id: string; voucherNumber: string } | null> {
  const voucherId = await findIdempotentEntityId(
    idempotencyKey,
    "payment-voucher"
  );
  if (!voucherId) return null;

  const [row] = await db
    .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
    .from(commissions)
    .innerJoin(vouchers, eq(commissions.paidVoucherId, vouchers.id))
    .where(
      and(
        eq(commissions.id, commissionId),
        eq(commissions.status, "PAID"),
        eq(vouchers.id, voucherId),
        eq(vouchers.commissionId, commissionId)
      )
    )
    .limit(1);

  return row ?? null;
}

/** ADMIN reverses a commission entirely (wrong work item, mistake). */
export async function reverseCommission(
  actor: Actor,
  commissionId: string,
  reason: string
): Promise<CommissionResult> {
  const [existing] = await db
    .select({ id: commissions.id, status: commissions.status })
    .from(commissions)
    .where(eq(commissions.id, commissionId))
    .limit(1);
  if (!existing) {
    return { ok: false, code: "notFound" };
  }
  if (existing.status === "REVERSED") {
    return { ok: false, code: "notPending" };
  }
  if (existing.status === "PAID") {
    return { ok: false, code: "alreadyPaid" };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(commissions)
      .set({
        status: "REVERSED",
        reversalReason: reason,
        reversedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(commissions.id, commissionId));
    await recordAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.COMMISSION_REVERSED,
        entityType: "commission",
        entityId: commissionId,
        metadata: { reason },
      },
      tx
    );
  });

  return { ok: true, id: commissionId };
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export type CommissionRow = {
  id: string;
  doctorId: string;
  doctorName: string;
  workItemId: string | null;
  sourceVoucherId: string | null;
  basis: "WORK_VALUE" | "COLLECTED";
  planType: "PERCENT" | "FIXED" | null;
  planValue: string | null;
  baseAmount: string;
  currency: Currency;
  amount: string | null;
  status: "PENDING" | "APPROVED" | "PAID" | "REVERSED";
  paidVoucherId: string | null;
  createdAt: Date;
};

export async function listCommissions(filter?: {
  doctorId?: string;
  status?: "PENDING" | "APPROVED" | "PAID" | "REVERSED";
  limit?: number;
}): Promise<CommissionRow[]> {
  const conditions = [];
  if (filter?.doctorId) {
    conditions.push(eq(commissions.doctorId, filter.doctorId));
  }
  if (filter?.status) {
    conditions.push(eq(commissions.status, filter.status));
  }

  const rows = await db
    .select({
      id: commissions.id,
      doctorId: commissions.doctorId,
      doctorName: users.name,
      workItemId: commissions.workItemId,
      sourceVoucherId: commissions.sourceVoucherId,
      basis: commissions.basis,
      planType: commissions.planType,
      planValue: commissions.planValue,
      baseAmount: commissions.baseAmount,
      currency: commissions.currency,
      amount: commissions.amount,
      status: commissions.status,
      paidVoucherId: commissions.paidVoucherId,
      createdAt: commissions.createdAt,
    })
    .from(commissions)
    .innerJoin(users, eq(commissions.doctorId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(commissions.createdAt))
    .limit(filter?.limit ?? 200);

  return rows as CommissionRow[];
}

/** Doctor-visible summary: own commissions grouped by status and currency. */
export async function getDoctorCommissionSummary(doctorId: string) {
  const rows = await db
    .select({
      status: commissions.status,
      currency: commissions.currency,
      count: sql<number>`count(*)::int`,
      total: sql<string>`sum(${commissions.amount})`,
    })
    .from(commissions)
    .where(eq(commissions.doctorId, doctorId))
    .groupBy(commissions.status, commissions.currency);
  return rows;
}
