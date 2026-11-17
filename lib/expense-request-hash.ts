import { createHash } from "node:crypto";
import type { ParsedExpenseRequest } from "./expense-request";

/**
 * Fingerprint of an expense create (docs/finance/EXPENSE_COMMANDS_0128.md §2.1).
 *
 * It covers what the voucher means and who asked for it. It covers the payment rate only when the
 * request overrides the settings rate: a retry of a lost response after the settings rate changed is
 * the same request. The preview's `expected` values are excluded for the same reason.
 */
export interface ExpensePaymentSplit {
  source: "drawer" | "owner_private" | "drawer_and_owner_private";
  drawerMinor: number;
  ownerPrivateMinor: number;
  ownerPrivateReason: string | null;
}

export function expenseRequestHash(actor: string, request: ParsedExpenseRequest, split: ExpensePaymentSplit): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    actor,
    category: request.category,
    partyId: request.partyId,
    payeeText: request.payeeText,
    amountMinor: request.amountMinor,
    currency: request.currency,
    paymentRateOverride: request.rateOverrideReason !== null && request.exchangeRate !== request.settingsExchangeRate
      ? request.exchangeRate : null,
    payableId: request.payableId,
    payableExchangeRate: request.payableExchangeRate,
    rateOverrideReason: request.rateOverrideReason,
    prepaymentReason: request.prepaymentReason,
    note: request.note,
    source: split.source,
    drawerMinor: split.drawerMinor,
    ownerPrivateMinor: split.ownerPrivateMinor,
    ownerPrivateReason: split.ownerPrivateReason,
  })).digest("hex");
}
