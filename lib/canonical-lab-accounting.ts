import "server-only";
import {
  getLabOrderWith, getPool, getSettings, patientInDoctorScopeWith, updateLabOrderAccountingOn,
  type DbClient, type LabAccountingInput,
} from "./db";
import { isLabAccountingRate } from "./lab-accounting-edit";
import { LabFinancialBoundaryError } from "./lab-financial-boundary";
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount, type Currency } from "./money";
import { rateFromSettings } from "./settings";
import { clinicalLabOrder } from "./canonical-lab-reads";
import { parseLabOrderId } from "./canonical-lab-orders";
import type { StaffRecordConstraint } from "./staff-capabilities";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

/**
 * Canonical lab-order accounting (M2 slice 71): PATCH /api/lab/[id] actions
 * `update_accounting`, `post` and `unpost`.
 *
 * - One admitted `finance.payables.record` transaction (the map's branch requirement; the
 *   legacy route allowed money roles by label). The legacy writer's own body runs
 *   unchanged (updateLabOrderAccountingOn): the order row locked, the payable link and
 *   settlement guards, the period lock (`finance.locked_before`, the linked visit invoice
 *   included), the saved-snapshot and FX precision rules, the payable updated or created
 *   once, tracking and the `lab_order.accounting` audit row with the write.
 * - The patient must be inside the actor's patient scope (`own` = the clinician's
 *   patients; `none` refused; outside reads like a missing order). The legacy rule was
 *   "money roles see every patient; doctors their accessible patients".
 * - The exchange rate is the server's (settings), never the client's; an optional
 *   `expectedExchangeRate` fences a stale on-screen quote (409), as in the legacy route.
 * - OWNER RULE (#483, 6615124926): amounts in the response only with
 *   finance.cost-prices.view; an accountant without it records but never reads a stored
 *   cost back.
 */
export class CanonicalLabAccountingRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "CanonicalLabAccountingRefusal";
  }
}
const ACTION = "finance.payables.record" as const;

async function inScope(client: DbClient, scope: StaffRecordConstraint, patientId: number): Promise<boolean> {
  if (scope.kind === "all") return true;
  if (scope.kind === "own") return patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
  return false;
}

/** The legacy route's parsing, field for field (codes and messages unchanged). */
export async function parseCanonicalLabAccounting(source: Record<string, unknown>): Promise<LabAccountingInput> {
  const isPosted = source.action === "post" ? true : source.action === "unpost" ? false
    : source.isPosted !== undefined ? Boolean(source.isPosted) : undefined;
  const rawCategory = Number(source.expenseCategoryId);
  const expenseCategoryId = Number.isInteger(rawCategory) && rawCategory > 0 ? rawCategory : source.expenseCategoryId === null ? null : undefined;
  const expenseAccountCode = typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim() ? source.expenseAccountCode.trim().slice(0, 10) : undefined;
  const payableAccountCode = typeof source.payableAccountCode === "string" && source.payableAccountCode.trim() ? source.payableAccountCode.trim().slice(0, 10) : undefined;
  let costMinor: number | null | undefined = undefined;
  let costCurrency: Currency | undefined = undefined;
  let exchangeRate: number | undefined = undefined;
  if (source.cost !== undefined && String(source.cost).trim() !== "") {
    if (!isCurrency(source.costCurrency)) throw new CanonicalLabAccountingRefusal("lab_accounting_currency_required", 400, "اختر عملة التكلفة الفعلية؛ لا تُفترض عملة تلقائيًا.");
    costCurrency = source.costCurrency;
    costMinor = parseAmount(String(source.cost), costCurrency);
    if (costMinor === null || costMinor < 0) throw new CanonicalLabAccountingRefusal("invalid_lab_accounting", 400, "اكتب تكلفة صحيحة أو اتركها فارغة.");
    const settings = await getSettings();
    const rate = costCurrency === CLINIC_BASE_CURRENCY ? 1 : rateFromSettings(settings, costCurrency, CLINIC_BASE_CURRENCY);
    exchangeRate = rate != null && rate > 0 ? rate : undefined;
    if (source.expectedExchangeRate !== undefined) {
      if (!isLabAccountingRate(source.expectedExchangeRate)) throw new CanonicalLabAccountingRefusal("lab_accounting_rate_invalid", 400, "سعر معاينة غير صالح. أعد تحميل المعاينة.");
      if (!isLabAccountingRate(exchangeRate) || source.expectedExchangeRate !== exchangeRate) {
        throw new CanonicalLabAccountingRefusal("lab_accounting_rate_changed", 409, "تغيّر سعر الصرف أو تعذّر التحقق منه. حدّث المعاينة وراجعها قبل الحفظ.");
      }
    }
    if (!isLabAccountingRate(exchangeRate)) throw new CanonicalLabAccountingRefusal("lab_accounting_rate_invalid", 409, "سعر صرف عملة التكلفة غير صالح؛ راجع الإعدادات قبل الحفظ.");
  } else if (source.cost === null || source.cost === "") {
    costMinor = null;
  }
  return { expenseCategoryId, expenseAccountCode, payableAccountCode, isPosted, costMinor, costCurrency, exchangeRate };
}

const ACCOUNTING_CONFLICTS: Record<string, string> = {
  lab_order_accounting_settled: "للإرسالية أثر سداد؛ لا يمكن تغيير بياناتها المالية. راجع التسوية المحاسبية دون تعديل المدفوعات السابقة.",
  lab_order_accounting_period_locked: "الفترة المالية للإرسالية مقفلة؛ لا يمكن تعديل بياناتها المالية.",
  lab_order_accounting_busy: "تُحدّث بيانات الإرسالية أو سدادها الآن؛ أعد تحميلها ثم حاول مجددًا.",
  lab_order_accounting_link_invalid: "ربط الالتزام المالي للإرسالية غير متسق؛ راجعه قبل التعديل.",
};

export async function commandCanonicalLabAccounting(session: VerifiedDurableSession, rawId: string, source: Record<string, unknown>, pool = getPool()) {
  const id = parseLabOrderId(rawId);
  const input = await parseCanonicalLabAccounting(source);
  try {
    return await withStaffOperation(pool, session, ACTION, async (client, handle) => {
      const scope = await staffOperationPatientScope(client, handle, ACTION);
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const identity = await staffOperationIdentity(client, handle, ACTION);
      const outcome = await updateLabOrderAccountingOn(client, id, input, {
        actor: { username: identity.username, role: identity.role },
        canAccessPatientMoney: patientId => inScope(client, scope, patientId),
      });
      if (outcome === "not_found") throw new CanonicalLabAccountingRefusal("lab_order_not_found", 404, "أمر المختبر غير موجود.");
      const order = await getLabOrderWith(client, id);
      if (!order) throw new CanonicalLabAccountingRefusal("lab_order_not_found", 404, "أمر المختبر غير موجود.");
      const costs = (await staffOperationCapabilities(client, handle, ACTION, ["finance.cost-prices.view"] as const)).has("finance.cost-prices.view");
      return { order: costs ? order : clinicalLabOrder(order), projection: { costs }, outcome };
    });
  } catch (error) {
    // A patient outside the scope reads like a missing order.
    if (error instanceof LabFinancialBoundaryError && error.code === "lab_accounting_patient_forbidden") {
      throw new CanonicalLabAccountingRefusal("lab_order_not_found", 404, "أمر المختبر غير موجود.");
    }
    const code = error instanceof Error ? error.message : "";
    if (code === "lab_order_accounting_price_invalid") throw new CanonicalLabAccountingRefusal(code, 400, "التكلفة المعدّلة يجب أن تكون مبلغًا موجبًا؛ لا يمكن مسح الالتزام المالي من هذا الإجراء.");
    if (code === "lab_order_exchange_rate_invalid") throw new CanonicalLabAccountingRefusal(code, 400, "سعر الصرف غير صالح؛ راجع الإعدادات.");
    if (ACCOUNTING_CONFLICTS[code]) throw new CanonicalLabAccountingRefusal(code, 409, ACCOUNTING_CONFLICTS[code]);
    if ((error as { code?: string }).code === "55P03") throw new CanonicalLabAccountingRefusal("lab_order_accounting_busy", 409, ACCOUNTING_CONFLICTS.lab_order_accounting_busy);
    throw error;
  }
}
