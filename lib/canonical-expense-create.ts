import "server-only";
import { expenseRequestKeyIsUnused, getPool, getSettingsWith, ratesFromSettings, recordExpenseOn, retireExpenseRequestWith, retireRefusedExpenseRequest, type Expense, type ExpenseRequestBinding, type ExpenseRequestRetirement } from "./db";
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
    readonly quote: SettlementQuote | null = null,
    /** Checked under the key's lock inside this operation: nothing is recorded under the request key. */
    readonly keyUnused = false,
    /** 0133: the request's retirement committed after this refusal's rollback (or it was retired before). */
    readonly keyState: "retired" | null = null) {
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
  let binding: ExpenseRequestBinding | null = null;
  try {
    return await withStaffOperation(pool, session, ACTION, async (client, handle) => {
      try { return await create(client, handle); } catch (error) {
        if (error instanceof CanonicalExpenseRefusal && !error.keyUnused && error.code !== "expense_request_conflict"
          && error.code !== "expense_request_retired" && await expenseRequestKeyIsUnused(command.requestKey, client)) {
          throw new CanonicalExpenseRefusal(error.code, error.status, error.message, error.quote, true);
        }
        throw error;
      }
    });
  } catch (error) {
    if (!(error instanceof CanonicalExpenseRefusal)) throw error;
    if (error.code === "expense_request_retired") {
      throw new CanonicalExpenseRefusal(error.code, error.status, error.message, error.quote, false, "retired");
    }
    // 0133: the operation is rolled back; retire this exact request in its own transaction. "retired" is
    // reported only after that commit, so no late send of the request can write a voucher afterwards.
    if (error.keyUnused && binding) {
      const keyState = await retireRefusedExpenseRequest(binding);
      // Not retired (error, saved meanwhile, conflict): nothing about the key is claimed; the screen stays unknown.
      throw new CanonicalExpenseRefusal(error.code, error.status, error.message, error.quote, keyState === "retired", keyState ?? null);
    }
    throw error;
  }
  async function create(client: OperationClient, handle: OperationHandle) {
    const f = await fingerprint(client, handle, command);
    binding = { key: command.requestKey, hash: f.hash, actor: f.identity.username };
    const { request, split, identity, owner, settings, rates } = f;

    let accountCode: string | null = null;
    if (split.ownerPrivateMinor > 0) {
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

    const result = await recordExpenseOn(client, {
      category: request.category, partyId: request.partyId, payeeText: request.payeeText,
      amountMinor: request.amountMinor, currency: request.currency, baseCurrency: CLINIC_BASE_CURRENCY,
      exchangeRate: request.exchangeRate, payableId: request.payableId, note: request.note,
      createdBy: identity.username, actorRole: identity.role, rates,
      payableExchangeRate: request.payableExchangeRate, rateOverrideReason: request.rateOverrideReason,
      prepaymentReason: request.prepaymentReason, expectedQuote: request.expectedQuote,
      request: { key: command.requestKey, hash: f.hash },
      paymentSplit: { ...split, ownerUserId: split.ownerPrivateMinor > 0 ? identity.userId : null, accountCode },
    }, rates);
    if (result.reason) {
      throw new CanonicalExpenseRefusal(result.reason, refusalStatus(result.reason) as 400 | 404 | 409,
        refusalMessage(result.reason, result.quote), result.quote, result.keyUnused === true);
    }
    if (!result.expense) throw new Error("Canonical expense create returned no voucher");
    return { expense: result.expense, replayed: result.replayed === true };
  }
}

type OperationClient = Parameters<Parameters<typeof withStaffOperation>[3]>[0];
type OperationHandle = Parameters<Parameters<typeof withStaffOperation>[3]>[1];

/**
 * The admitted actor and the request's 0128 fingerprint, computed exactly as the create computes them.
 * Shared by the create and the retirement (0133), so a retirement binds to the same request it fences.
 */
async function fingerprint(client: OperationClient, handle: OperationHandle, command: CanonicalExpenseCommand) {
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
  const hash = expenseRequestHash(identity.username, request, {
    source: split.value.ownerPrivateMinor === 0 ? "drawer" : split.value.drawerMinor === 0 ? "owner_private" : "drawer_and_owner_private",
    drawerMinor: split.value.drawerMinor, ownerPrivateMinor: split.value.ownerPrivateMinor,
    ownerPrivateReason: split.value.ownerPrivateReason,
  });
  return { held, owner, identity, settings, rates, request, split: split.value, hash };
}

/**
 * 0133 (docs/finance/EXPENSE_REQUEST_RETIREMENTS_0133.md §2.1): the sender ends an unknown request for good.
 * Same admission as the create; the body is the exact body that was sent, fingerprinted the same way. A
 * body that no longer parses cannot be bound, so nothing is retired. Commits with the operation.
 */
export async function commandCanonicalRetireExpenseRequest(session: VerifiedDurableSession,
  command: CanonicalExpenseCommand, pool = getPool()): Promise<ExpenseRequestRetirement> {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    let f: Awaited<ReturnType<typeof fingerprint>>;
    try { f = await fingerprint(client, handle, command); } catch (error) {
      if (error instanceof CanonicalExpenseRefusal) {
        throw new CanonicalExpenseRefusal("expense_retirement_unproven", 409,
          "تعذّر ربط هذا الطلب ببياناته الحالية، فلم يُنهَ. يبقى معلّقًا؛ تحقّق منه أو راجع سجل الصرف قبل أي تسجيل جديد.");
      }
      throw error;
    }
    return retireExpenseRequestWith(client, { key: command.requestKey, hash: f.hash, actor: f.identity.username },
      { actorRole: f.identity.role });
  });
}
