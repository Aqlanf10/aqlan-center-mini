"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/guards";
import { parseDateTimeLocal } from "@/lib/datetime";
import {
  paymentVoucherFormSchema,
  receiptVoucherFormSchema,
  validateWith,
  voucherReversalFormSchema,
} from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { failure, success, type ActionResult } from "@/server/types";
import {
  createPaymentVoucher,
  createReceiptVoucher,
  reverseVoucher,
  type Actor,
} from "@/server/finance/vouchers";
import {
  reopenPaidCommissionForVoucher,
  reverseCollectedCommissionsForVoucher,
} from "@/server/commissions/engine";

/** Receipt vouchers: RECEPTION may create patient receipts; ADMIN anything. */
const RECEIPT_ROLES = ["ADMIN", "RECEPTION"] as const;
/** Payment vouchers and reversals are ADMIN-only. */
const ADMIN_ONLY = ["ADMIN"] as const;

function revalidateFinancePages() {
  revalidatePath("/finance");
  revalidatePath("/finance/receipts");
  revalidatePath("/finance/vouchers");
  revalidatePath("/finance/daily-closing");
  revalidatePath("/finance/reports");
  revalidatePath("/dashboard");
}

export async function createReceiptVoucherAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(RECEIPT_ROLES, "/finance/receipts");

  const validation = validateWith(receiptVoucherFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const actor: Actor = { id: user.id, role: user.role, name: user.name };

  // RECEPTION may only issue receipts for patients (server-side rule).
  if (user.role === "RECEPTION" && !data.patientId) {
    return failure("finance.vouchers.receptionPatientOnly");
  }

  const voucherDate = data.voucherDate
    ? parseDateTimeLocal(data.voucherDate) ?? undefined
    : undefined;

  const result = await createReceiptVoucher(actor, {
    patientId: data.patientId ?? null,
    otherPartyName: data.otherPartyName ?? null,
    amount: data.amount,
    currency: data.currency,
    cashAccountId: data.cashAccountId,
    paymentMethod: data.paymentMethod,
    voucherDate,
    description: data.description ?? null,
    reference: data.reference ?? null,
    idempotencyKey: data.idempotencyKey ?? null,
  });

  if (!result.ok) {
    return failure(`finance.vouchers.errors.${result.code}`);
  }

  if (data.patientId) {
    revalidatePath(`/patients/${data.patientId}`);
  }
  revalidateFinancePages();
  return success("finance.vouchers.toasts.receiptCreated", result.id);
}

export async function createPaymentVoucherAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance/vouchers");

  const validation = validateWith(paymentVoucherFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const actor: Actor = { id: user.id, role: user.role, name: user.name };

  // Resolve the party from exactly one selector.
  if (data.partyType === "DOCTOR" && !data.doctorId) {
    return failure("common.serverError", { doctorId: "required" });
  }
  if (data.partyType === "LAB" && !data.labId) {
    return failure("common.serverError", { labId: "required" });
  }
  if (data.partyType === "SUPPLIER" && !data.supplierId) {
    return failure("common.serverError", { supplierId: "required" });
  }
  if (data.partyType === "OTHER" && !data.otherPartyName?.trim()) {
    return failure("common.serverError", { otherPartyName: "required" });
  }
  if (data.partyType === "OTHER" && !data.expenseCategoryId) {
    return failure("common.serverError", { expenseCategoryId: "required" });
  }

  const voucherDate = data.voucherDate
    ? parseDateTimeLocal(data.voucherDate) ?? undefined
    : undefined;

  const party =
    data.partyType === "DOCTOR"
      ? ({ kind: "DOCTOR", doctorId: data.doctorId! } as const)
      : data.partyType === "LAB"
        ? ({
            kind: "LAB",
            labId: data.labId!,
            labCaseId: data.labCaseId || null,
          } as const)
        : data.partyType === "SUPPLIER"
          ? ({
              kind: "SUPPLIER",
              supplierId: data.supplierId!,
              purchaseInvoiceId: data.purchaseInvoiceId || null,
            } as const)
          : ({
              kind: "OTHER",
              otherPartyName: data.otherPartyName!,
              expenseCategoryId: data.expenseCategoryId!,
            } as const);

  const result = await createPaymentVoucher(actor, {
    party,
    amount: data.amount,
    currency: data.currency,
    cashAccountId: data.cashAccountId,
    paymentMethod: data.paymentMethod,
    voucherDate,
    description: data.description ?? null,
    reference: data.reference ?? null,
    idempotencyKey: data.idempotencyKey ?? null,
  });

  if (!result.ok) {
    return failure(`finance.vouchers.errors.${result.code}`);
  }

  revalidateFinancePages();
  if (data.labId) revalidatePath("/labs");
  if (data.supplierId) revalidatePath("/suppliers");
  return success("finance.vouchers.toasts.paymentCreated", result.id);
}

export async function reverseVoucherAction(
  voucherId: string,
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance");

  const validation = validateWith(voucherReversalFormSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  const actor: Actor = { id: user.id, role: user.role, name: user.name };

  const result = await reverseVoucher(actor, voucherId, validation.data.reason, {
    onReceiptReversed: async (tx, originalVoucherId) => {
      // COLLECTED-basis commissions raised from this receipt are reversed
      // inside the SAME transaction (money + commissions stay consistent).
      await reverseCollectedCommissionsForVoucher(tx, originalVoucherId, actor.id);
    },
    onPaymentReversed: async (tx, originalVoucherId) => {
      // A reversed payout re-opens the linked commission for a deliberate
      // future payment; it must never remain falsely marked as PAID.
      await reopenPaidCommissionForVoucher(tx, originalVoucherId, actor.id);
    },
  });

  if (!result.ok) {
    return failure(`finance.vouchers.errors.${result.code}`);
  }

  revalidateFinancePages();
  return success("finance.vouchers.toasts.reversed", result.id);
}

/**
 * Print audit (reprint-safe): printing never modifies the movement; the
 * PRINTED/REPRINTED event lands in the audit log with NO sensitive data
 * (no amounts, no party names — just ids and the print kind).
 */
export async function recordVoucherPrintAction(
  voucherId: string,
  reprint: boolean
): Promise<ActionResult> {
  const user = await requireRole(RECEIPT_ROLES, "/finance/receipts");

  await recordAudit({
    userId: user.id,
    action: reprint ? AUDIT_ACTIONS.VOUCHER_PRINTED : AUDIT_ACTIONS.VOUCHER_PRINTED,
    entityType: "voucher",
    entityId: voucherId,
    metadata: { reprint },
  });

  return success("common.ok");
}

export async function recordStatementPrintAction(
  entityType: "patient" | "doctor" | "lab" | "supplier",
  entityId: string
): Promise<ActionResult> {
  const user = await requireRole(RECEIPT_ROLES, "/patients");

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STATEMENT_PRINTED,
    entityType: entityType as "patient",
    entityId,
    metadata: {},
  });

  return success("common.ok");
}

export async function recordReportPrintAction(
  reportType: string,
  params: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(ADMIN_ONLY, "/finance");

  // Only filter keys are stored — never row data or amounts.
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.REPORT_PRINTED,
    entityType: "settings",
    entityId: reportType,
    metadata: { filters: params },
  });

  return success("common.ok");
}
