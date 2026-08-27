import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  cashAccounts,
  vouchers,
  voucherCounters,
  payments,
} from "@/db/schema";
import { getZonedParts } from "@/lib/datetime";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import {
  claimIdempotencyKey,
  findIdempotentEntityId,
  isIdempotencyConflict,
} from "@/server/idempotency";

/** Executor that can run queries — the pool client or an open transaction. */
export type DbClient = typeof db;
export type TxClient = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export type Executor = DbClient | TxClient;

/** Acting staff member passed down from the server-action guard. */
export type Actor = {
  id: string;
  role: "ADMIN" | "DOCTOR" | "RECEPTION";
  name: string;
};

export type VoucherErrorCode =
  | "cashAccountMissing"
  | "currencyMismatch"
  | "partyMissing"
  | "patientMissing"
  | "notFound"
  | "alreadyReversed"
  | "reversalOfReversal"
  | "expenseCategoryRequired"
  | "invalidPartyLink"
  | "duplicate";

export type VoucherResult =
  | { ok: true; id: string; voucherNumber: string }
  | { ok: false; code: VoucherErrorCode; id?: string };

export type ReceiptInput = {
  patientId?: string | null;
  otherPartyName?: string | null;
  amount: string;
  currency: "YER" | "SAR" | "USD";
  cashAccountId: string;
  paymentMethod: "CASH" | "TRANSFER" | "CARD" | "OTHER";
  voucherDate?: Date;
  description?: string | null;
  reference?: string | null;
  idempotencyKey?: string | null;
};

export type PaymentPartyInput =
  | { kind: "DOCTOR"; doctorId: string }
  | { kind: "LAB"; labId: string; labCaseId?: string | null }
  | { kind: "SUPPLIER"; supplierId: string; purchaseInvoiceId?: string | null }
  | {
      kind: "OTHER";
      otherPartyName: string;
      expenseCategoryId: string;
      purchaseInvoiceId?: string | null;
      labCaseId?: string | null;
    };

export type PaymentInput = {
  party: PaymentPartyInput;
  amount: string;
  currency: "YER" | "SAR" | "USD";
  cashAccountId: string;
  paymentMethod: "CASH" | "TRANSFER" | "CARD" | "OTHER";
  voucherDate?: Date;
  description?: string | null;
  reference?: string | null;
  commissionId?: string | null;
  idempotencyKey?: string | null;
};

const VOUCHER_PREFIX = { RECEIPT: "RCPT", PAYMENT: "PV" } as const;

/**
 * Draw the next human-readable voucher number for (kind, year).
 * Runs inside the voucher transaction; the UPDATE takes a row lock so two
 * concurrent submissions can never draw the same number. The counter row is
 * created on first use for a year.
 */
async function nextVoucherNumber(
  tx: TxClient,
  kind: "RECEIPT" | "PAYMENT",
  when: Date
): Promise<string> {
  const year = getZonedParts(when).year;
  const insertValues = { kind, year, lastNumber: 0 } as const;

  await tx
    .insert(voucherCounters)
    .values(insertValues)
    .onConflictDoNothing({
      target: [voucherCounters.kind, voucherCounters.year],
    });

  const [row] = await tx
    .update(voucherCounters)
    .set({ lastNumber: sql`${voucherCounters.lastNumber} + 1` })
    .where(
      and(
        eq(voucherCounters.kind, kind),
        eq(voucherCounters.year, year)
      )
    )
    .returning({ lastNumber: voucherCounters.lastNumber });

  const number = row?.lastNumber ?? 0;
  return `${VOUCHER_PREFIX[kind]}-${year}-${String(number).padStart(6, "0")}`;
}

/** Load the cash account and verify its currency matches the voucher. */
async function requireCurrencyMatch(
  executor: Executor,
  cashAccountId: string,
  currency: string
): Promise<{ ok: true; id: string; name: string } | { ok: false; code: "cashAccountMissing" | "currencyMismatch" }> {
  const [account] = await executor
    .select({ id: cashAccounts.id, name: cashAccounts.name, currency: cashAccounts.currency, active: cashAccounts.active })
    .from(cashAccounts)
    .where(eq(cashAccounts.id, cashAccountId))
    .limit(1);

  if (!account || !account.active) {
    return { ok: false, code: "cashAccountMissing" };
  }
  if (account.currency !== currency) {
    return { ok: false, code: "currencyMismatch" };
  }
  return { ok: true, id: account.id, name: account.name };
}

/**
 * Create a receipt voucher (سند قبض).
 *
 * One atomic transaction:
 *   1. draw the voucher number (row-locked counter),
 *   2. insert the voucher row,
 *   3. for patient receipts: insert the linked `payments` row (the patient
 *      ledger stays the balance source of truth),
 *   4. write the audit row,
 *   5. claim the idempotency key (double-submit barrier).
 */
export async function createReceiptVoucher(
  actor: Actor,
  input: ReceiptInput,
  hooks?: {
    onPatientReceipt?: (
      tx: TxClient,
      voucherId: string,
      patientId: string,
      amount: string,
      currency: "YER" | "SAR" | "USD"
    ) => Promise<void>;
  }
): Promise<VoucherResult> {
  if (!input.patientId && !input.otherPartyName?.trim()) {
    return { ok: false, code: "partyMissing" };
  }

  // Idempotent replay: same key returns the original voucher.
  if (input.idempotencyKey) {
    const existing = await findIdempotentEntityId(
      input.idempotencyKey,
      "receipt-voucher"
    );
    if (existing) {
      const [row] = await db
        .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
        .from(vouchers)
        .where(eq(vouchers.id, existing))
        .limit(1);
      if (row) {
        return { ok: true, id: row.id, voucherNumber: row.voucherNumber };
      }
    }
  }

  const account = await requireCurrencyMatch(db, input.cashAccountId, input.currency);
  if (!account.ok) {
    return { ok: false, code: account.code };
  }

  const when = input.voucherDate ?? new Date();

  try {
    const created = await db.transaction(async (tx) => {
      const voucherNumber = await nextVoucherNumber(tx, "RECEIPT", when);

      const [voucher] = await tx
        .insert(vouchers)
        .values({
          type: "RECEIPT",
          voucherNumber,
          partyType: input.patientId ? "PATIENT" : "OTHER",
          patientId: input.patientId ?? null,
          otherPartyName: input.patientId ? null : (input.otherPartyName ?? null),
          amount: input.amount,
          currency: input.currency,
          cashAccountId: input.cashAccountId,
          paymentMethod: input.paymentMethod,
          voucherDate: when,
          description: input.description ?? null,
          reference: input.reference ?? null,
          createdBy: actor.id,
          approvedBy: actor.id,
        })
        .returning({ id: vouchers.id, voucherNumber: vouchers.voucherNumber });
      if (!voucher) {
        return null;
      }

      // Patient receipts mirror into the patient ledger (charges/payments),
      // keeping old and new balance views identical by construction.
      if (input.patientId) {
        await tx.insert(payments).values({
          patientId: input.patientId,
          amount: input.amount,
          currency: input.currency,
          description: input.description ?? `سند قبض ${voucherNumber}`,
          voucherId: voucher.id,
          createdBy: actor.id,
        });

        if (hooks?.onPatientReceipt) {
          await hooks.onPatientReceipt(
            tx,
            voucher.id,
            input.patientId,
            input.amount,
            input.currency
          );
        }
      }

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.VOUCHER_CREATED,
          entityType: "voucher",
          entityId: voucher.id,
          metadata: {
            type: "RECEIPT",
            voucherNumber,
            currency: input.currency,
            patientId: input.patientId ?? undefined,
            otherPartyName: input.otherPartyName ?? undefined,
          },
        },
        tx
      );

      if (input.idempotencyKey) {
        await claimIdempotencyKey(
          tx,
          input.idempotencyKey,
          "receipt-voucher",
          voucher.id
        );
      }

      return voucher;
    });

    if (!created) {
      return { ok: false, code: "duplicate" };
    }
    return { ok: true, id: created.id, voucherNumber: created.voucherNumber };
  } catch (error) {
    if (input.idempotencyKey && isIdempotencyConflict(error)) {
      const existing = await findIdempotentEntityId(
        input.idempotencyKey,
        "receipt-voucher"
      );
      if (existing) {
        const [row] = await db
          .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(eq(vouchers.id, existing))
          .limit(1);
        if (row) {
          return { ok: true, id: row.id, voucherNumber: row.voucherNumber };
        }
      }
    }
    throw error;
  }
}

/**
 * Create a payment voucher (سند صرف) — money out to a doctor (commission),
 * lab, supplier or a general expense. Same atomic guarantees as receipts.
 */
export async function createPaymentVoucher(
  actor: Actor,
  input: PaymentInput
): Promise<VoucherResult> {
  const account = await requireCurrencyMatch(db, input.cashAccountId, input.currency);
  if (!account.ok) {
    return { ok: false, code: account.code };
  }

  const when = input.voucherDate ?? new Date();

  const partyColumns = (() => {
    switch (input.party.kind) {
      case "DOCTOR":
        return {
          partyType: "DOCTOR" as const,
          doctorId: input.party.doctorId,
          labId: null,
          supplierId: null,
          otherPartyName: null,
          labCaseId: null,
          purchaseInvoiceId: null,
          expenseCategoryId: null,
        };
      case "LAB":
        return {
          partyType: "LAB" as const,
          doctorId: null,
          labId: input.party.labId,
          supplierId: null,
          otherPartyName: null,
          labCaseId: input.party.labCaseId ?? null,
          purchaseInvoiceId: null,
          expenseCategoryId: null,
        };
      case "SUPPLIER":
        return {
          partyType: "SUPPLIER" as const,
          doctorId: null,
          labId: null,
          supplierId: input.party.supplierId,
          otherPartyName: null,
          labCaseId: null,
          purchaseInvoiceId: input.party.purchaseInvoiceId ?? null,
          expenseCategoryId: null,
        };
      case "OTHER":
        return {
          partyType: "OTHER" as const,
          doctorId: null,
          labId: null,
          supplierId: null,
          otherPartyName: input.party.otherPartyName,
          labCaseId: null,
          purchaseInvoiceId: input.party.purchaseInvoiceId ?? null,
          expenseCategoryId: input.party.expenseCategoryId,
        };
    }
  })();

  // Idempotent replay.
  if (input.idempotencyKey) {
    const existing = await findIdempotentEntityId(
      input.idempotencyKey,
      "payment-voucher"
    );
    if (existing) {
      const [row] = await db
        .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
        .from(vouchers)
        .where(eq(vouchers.id, existing))
        .limit(1);
      if (row) {
        return { ok: true, id: row.id, voucherNumber: row.voucherNumber };
      }
    }
  }

  try {
    const created = await db.transaction(async (tx) => {
      const voucherNumber = await nextVoucherNumber(tx, "PAYMENT", when);

      const [voucher] = await tx
        .insert(vouchers)
        .values({
          type: "PAYMENT",
          voucherNumber,
          ...partyColumns,
          commissionId: input.commissionId ?? null,
          amount: input.amount,
          currency: input.currency,
          cashAccountId: input.cashAccountId,
          paymentMethod: input.paymentMethod,
          voucherDate: when,
          description: input.description ?? null,
          reference: input.reference ?? null,
          createdBy: actor.id,
          approvedBy: actor.id,
        })
        .returning({ id: vouchers.id, voucherNumber: vouchers.voucherNumber });
      if (!voucher) {
        return null;
      }

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.VOUCHER_CREATED,
          entityType: "voucher",
          entityId: voucher.id,
          metadata: {
            type: "PAYMENT",
            voucherNumber,
            currency: input.currency,
            partyType: partyColumns.partyType,
            commissionId: input.commissionId ?? undefined,
          },
        },
        tx
      );

      if (input.idempotencyKey) {
        await claimIdempotencyKey(
          tx,
          input.idempotencyKey,
          "payment-voucher",
          voucher.id
        );
      }

      return voucher;
    });

    if (!created) {
      return { ok: false, code: "duplicate" };
    }
    return { ok: true, id: created.id, voucherNumber: created.voucherNumber };
  } catch (error) {
    if (input.idempotencyKey && isIdempotencyConflict(error)) {
      const existing = await findIdempotentEntityId(
        input.idempotencyKey,
        "payment-voucher"
      );
      if (existing) {
        const [row] = await db
          .select({ id: vouchers.id, voucherNumber: vouchers.voucherNumber })
          .from(vouchers)
          .where(eq(vouchers.id, existing))
          .limit(1);
        if (row) {
          return { ok: true, id: row.id, voucherNumber: row.voucherNumber };
        }
      }
    }
    throw error;
  }
}

/**
 * Reverse a voucher (عكس السند) — ADMIN only.
 *
 * Creates a counterpart voucher entry (same type, same amount, same cash
 * account, linked back to the original, with the mandatory reason) and
 * marks the original REVERSED. Nothing is edited or deleted; the cash
 * impact of the pair nets to zero. Reversal of a reversal is refused.
 */
export async function reverseVoucher(
  actor: Actor,
  voucherId: string,
  reason: string,
  hooks?: {
    onReceiptReversed?: (tx: TxClient, originalVoucherId: string) => Promise<void>;
  }
): Promise<VoucherResult> {
  const [original] = await db
    .select({
      id: vouchers.id,
      type: vouchers.type,
      voucherNumber: vouchers.voucherNumber,
      partyType: vouchers.partyType,
      patientId: vouchers.patientId,
      doctorId: vouchers.doctorId,
      labId: vouchers.labId,
      supplierId: vouchers.supplierId,
      otherPartyName: vouchers.otherPartyName,
      labCaseId: vouchers.labCaseId,
      purchaseInvoiceId: vouchers.purchaseInvoiceId,
      commissionId: vouchers.commissionId,
      expenseCategoryId: vouchers.expenseCategoryId,
      amount: vouchers.amount,
      currency: vouchers.currency,
      cashAccountId: vouchers.cashAccountId,
      paymentMethod: vouchers.paymentMethod,
      description: vouchers.description,
      reference: vouchers.reference,
      status: vouchers.status,
      reversalOfVoucherId: vouchers.reversalOfVoucherId,
    })
    .from(vouchers)
    .where(eq(vouchers.id, voucherId))
    .limit(1);

  if (!original) {
    return { ok: false, code: "notFound" };
  }
  if (original.status === "REVERSED") {
    return { ok: false, code: "alreadyReversed" };
  }
  if (original.reversalOfVoucherId) {
    return { ok: false, code: "reversalOfReversal" };
  }

  const when = new Date();

  try {
    const created = await db.transaction(async (tx) => {
      const voucherNumber = await nextVoucherNumber(tx, original.type, when);

      // The counterpart entry mirrors the original exactly (same type so it
      // nets inside the same register) and points back to it.
      const [reversal] = await tx
        .insert(vouchers)
        .values({
          type: original.type,
          voucherNumber,
          partyType: original.partyType,
          patientId: original.patientId,
          doctorId: original.doctorId,
          labId: original.labId,
          supplierId: original.supplierId,
          otherPartyName: original.otherPartyName,
          labCaseId: original.labCaseId,
          purchaseInvoiceId: original.purchaseInvoiceId,
          commissionId: original.commissionId,
          expenseCategoryId: original.expenseCategoryId,
          amount: original.amount,
          currency: original.currency,
          cashAccountId: original.cashAccountId,
          paymentMethod: original.paymentMethod,
          voucherDate: when,
          description: original.description,
          reference: original.reference,
          status: "ACTIVE",
          reversalOfVoucherId: original.id,
          reversalReason: reason,
          createdBy: actor.id,
          approvedBy: actor.id,
        })
        .returning({ id: vouchers.id, voucherNumber: vouchers.voucherNumber });
      if (!reversal) {
        return null;
      }

      await tx
        .update(vouchers)
        .set({ status: "REVERSED", updatedAt: when })
        .where(eq(vouchers.id, original.id));

      // Reversing a patient receipt also removes the mirrored payment so the
      // patient ledger stays consistent with the treasury (opposite entry,
      // never a delete).
      if (original.type === "RECEIPT" && original.patientId) {
        await tx
          .update(payments)
          .set({
            amount: sql`-${payments.amount}`,
            description: sql`concat('عكس سند قبض ', ${payments.description})`,
          })
          .where(eq(payments.voucherId, original.id));

        if (hooks?.onReceiptReversed) {
          await hooks.onReceiptReversed(tx, original.id);
        }
      }

      await recordAudit(
        {
          userId: actor.id,
          action: AUDIT_ACTIONS.VOUCHER_REVERSED,
          entityType: "voucher",
          entityId: original.id,
          metadata: {
            voucherNumber: original.voucherNumber,
            reversalVoucherId: reversal.id,
            reversalVoucherNumber: reversal.voucherNumber,
            currency: original.currency,
          },
        },
        tx
      );

      return reversal;
    });

    if (!created) {
      return { ok: false, code: "duplicate" };
    }
    return { ok: true, id: created.id, voucherNumber: created.voucherNumber };
  } catch {
    return { ok: false, code: "duplicate" };
  }
}
