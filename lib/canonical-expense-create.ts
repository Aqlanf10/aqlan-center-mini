import "server-only";
import { getPool, getSettingsWith, ratesFromSettings, recordExpenseOn, type Expense } from "./db";
import { parseExpenseRequest, refusalStatus } from "./expense-request";
import { expenseRequestHash } from "./expense-request-hash";
import { ownerFundingAccountProblem, parseExpensePaymentSplit } from "./expense-payment-split";
import { CLINIC_BASE_CURRENCY } from "./money";
import { refusalMessage, type SettlementQuote } from "./supplier-payments";
import {
  staffOperationCapabilities, staffOperationIdentity, staffOperationIsProtectedOwner, withStaffOperation,
} from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Expense create on the canonical runtime (M2 slice 97, first route; owner #483 6831365228 items 2 and 3;
 * contract docs/finance/EXPENSE_COMMANDS_0128.md).
 *
 * One admitted `finance.expenses.create` operation per request. The legacy writer body runs unchanged on
 * the operation's transaction (`recordExpenseOn`), after the staff authority locks, with the request-key
 * replay, the drawer limit, the receipt read and the audit rows in that one transaction. Any refusal rolls
 * the whole operation back. The actor is the operation's identity, never a request field.
 *
 *  - A rate different from the settings needs `finance.fx.manage`; a prepayment above a supplier's balance
 *    needs `finance.payables.record`. The legacy route gave both to the admin label; a canonical session
 *    gets each only from its own grant, or as the protected owner.
 *  - A part paid from the owner's private source is accepted only from the protected owner proved inside
 *    this transaction (`staff_authority_control.owner_user_id`), never from a role label or an expense
 *    grant, and only while `finance.owner_private_funding_account` names a usable account. The account is
 *    captured on the voucher.
 */
const ACTION = "finance.expenses.create" as const;

export class CanonicalExpenseRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string,
    readonly quote: SettlementQuote | null = null) {
    super(message); this.name = "CanonicalExpenseRefusal";
  }
}

export interface CanonicalExpenseCommand {
  /** The request body as received; the actor and any server-owned field in it are ignored. */
  source: Record<string, unknown>;
  /** The Idempotency-Key header, already checked against the shared pattern by the route. */
  requestKey: string;
}

export async function commandCanonicalExpenseCreate(session: VerifiedDurableSession, command: CanonicalExpenseCommand,
  pool = getPool()): Promise<{ expense: Expense; replayed: boolean }> {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const held = await staffOperationCapabilities(client, handle, ACTION, [ACTION, "finance.fx.manage", "finance.payables.record"] as const);
    const owner = await staffOperationIsProtectedOwner(client, handle, ACTION);
    if (!owner && !held.has(ACTION)) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
    const identity = await staffOperationIdentity(client, handle, ACTION);
    const settings = await getSettingsWith(client);
    const rates = ratesFromSettings(settings);

    const parsed = parseExpenseRequest(command.source, rates, {
      rateOverride: owner || held.has("finance.fx.manage"), prepayment: owner || held.has("finance.payables.record"),
    });
    if (!parsed.ok) throw new CanonicalExpenseRefusal("invalid_expense", parsed.status as 400 | 403 | 409, parsed.message);
    const request = parsed.value;
    const split = parseExpensePaymentSplit(command.source, request.amountMinor, request.currency);
    if (!split.ok) throw new CanonicalExpenseRefusal("invalid_payment_split", 400, split.message);

    let accountCode: string | null = null;
    if (split.value.ownerPrivateMinor > 0) {
      if (!owner) {
        throw new CanonicalExpenseRefusal("owner_private_requires_owner", 403,
          "الدفع من المصدر الخاص للمالك وحده؛ لم يُسجَّل شيء. سجّل المصروف من الدرج، أو يسجّله المالك بنفسه.");
      }
      const configured = settings["finance.owner_private_funding_account"] ?? "";
      const problem = ownerFundingAccountProblem(configured);
      // A retry of a request already saved under this key replays it (or is a conflict) even if the
      // setting changed since: the writer's key check decides, with the account captured on that voucher.
      const { rows: saved } = await client.query<{ owner_private_account_code: string | null }>(
        "SELECT owner_private_account_code FROM expenses WHERE idempotency_key = $1", [command.requestKey]);
      if (problem && saved[0]?.owner_private_account_code) {
        accountCode = saved[0].owner_private_account_code;
      } else if (problem) {
        throw new CanonicalExpenseRefusal("owner_private_account_unset", 409,
          `${problem} لم يُسجَّل شيء. يحدّد المالك الحساب في الإعدادات المالية قبل الدفع من المصدر الخاص.`);
      } else {
        accountCode = configured.trim();
      }
    }

    const hash = expenseRequestHash(identity.username, request, {
      source: split.value.ownerPrivateMinor === 0 ? "drawer" : split.value.drawerMinor === 0 ? "owner_private" : "drawer_and_owner_private",
      drawerMinor: split.value.drawerMinor, ownerPrivateMinor: split.value.ownerPrivateMinor,
      ownerPrivateReason: split.value.ownerPrivateReason,
    });
    const result = await recordExpenseOn(client, {
      category: request.category, partyId: request.partyId, payeeText: request.payeeText,
      amountMinor: request.amountMinor, currency: request.currency, baseCurrency: CLINIC_BASE_CURRENCY,
      exchangeRate: request.exchangeRate, payableId: request.payableId, note: request.note,
      createdBy: identity.username, actorRole: identity.role, rates,
      payableExchangeRate: request.payableExchangeRate, rateOverrideReason: request.rateOverrideReason,
      prepaymentReason: request.prepaymentReason, expectedQuote: request.expectedQuote,
      request: { key: command.requestKey, hash },
      paymentSplit: { ...split.value, ownerUserId: split.value.ownerPrivateMinor > 0 ? identity.userId : null, accountCode },
    }, rates);
    if (result.reason) {
      throw new CanonicalExpenseRefusal(result.reason, refusalStatus(result.reason) as 400 | 404 | 409,
        refusalMessage(result.reason, result.quote), result.quote);
    }
    if (!result.expense) throw new Error("Canonical expense create returned no voucher");
    return { expense: result.expense, replayed: result.replayed === true };
  });
}
