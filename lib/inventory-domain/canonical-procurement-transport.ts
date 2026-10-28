import "server-only";
import { getPool } from "../db";
import type { VerifiedDurableSession } from "../staff-durable-session";
import type { InventoryRuntimeAction } from "../staff-operation-runtime";
import { canonicalInventoryActor, withCanonicalInventoryOperation, type CanonicalInventoryAuthority } from "./canonical-operation";
import { InventoryDomainError, invariant } from "./quantities";
import {
  amendPurchaseOrder, approvePurchaseRequest, issuePurchaseOrder, postInspectedReceipt, recordSupplierInvoiceMatch,
  resolveQuarantineReceipt, revisePurchaseRequest, submitPurchaseRequest, type InventoryActor,
} from "./procurement-store";
import {
  acknowledgeCustodyTransfer, approveCustodyWaste, closeCustodyPackage, dispatchCustodyTransfer, objectCustodySettlement,
  proposeAnnualCustodySettlement, reconcileHistoricalMovements, recordCustodyStocktake, recordCustodyUsage,
  type CustodyAcknowledgement, type CustodyDispatch, type CustodyPackageClosureInput, type CustodySettlementObjectionInput,
  type CustodySettlementProposalInput, type CustodyStocktakeInput, type CustodyUsageInput, type CustodyWasteApprovalInput,
  type LegacyReconciliationInput,
} from "./custody-store";
import type { PurchaseOrder, ReceiptRevision, RequestRevision, SupplierInvoiceRevision } from "./procurement";

/**
 * Canonical procurement/custody command adapter (M3a). Each HTTP command maps to
 * exactly one catalogue capability (docs/inventory/CENTRAL-PERMISSION-BINDINGS-20261027.md).
 * The capability admits the operation inside `withStaffOperation`; the store then
 * re-proves the same authority before the reset fence, after it and after the
 * operation-key lock. Record scope (own request, own custody, independent approver,
 * limits) stays in the store. A role label never decides anything here.
 *
 * `custody.consume` with `approved_waste` additionally consumes a waste approval that
 * the store verifies against the approver's CURRENT `inventory.custody.approve-waste`.
 */
export const PROCUREMENT_COMMAND_CAPABILITIES = Object.freeze({
  "request.submit": "inventory.requests.create",
  "request.revise": "inventory.requests.create",
  "request.approve": "inventory.requests.approve",
  "order.issue": "inventory.orders.manage",
  "order.amend": "inventory.orders.manage",
  "receipt.post": "inventory.receipts.post",
  "quarantine.resolve": "inventory.quarantine.resolve",
  "invoice.match": "inventory.supplier-invoices.record",
  "custody.dispatch": "inventory.custody.dispatch",
  "custody.acknowledge": "inventory.custody.acknowledge",
  "custody.consume": "inventory.custody.use",
  "custody.return_to_store": "inventory.custody.use",
  "custody.stocktake": "inventory.custody.stocktake",
  "custody.close_package": "inventory.custody.stocktake",
  "custody.approve_waste": "inventory.custody.approve-waste",
  "custody.propose_settlement": "inventory.custody.settlement.propose",
  "custody.object_settlement": "inventory.custody.settlement.object",
  "legacy.reconcile": "inventory.reconcile",
} as const satisfies Readonly<Record<string, InventoryRuntimeAction>>);
export type CanonicalProcurementCommand = keyof typeof PROCUREMENT_COMMAND_CAPABILITIES;
export function isCanonicalProcurementCommand(value: string): value is CanonicalProcurementCommand {
  return Object.prototype.hasOwnProperty.call(PROCUREMENT_COMMAND_CAPABILITIES, value);
}

/** Validated route inputs (shape checks stay in the route, as for the legacy path). */
export type CanonicalProcurementInput =
  | { command: "request.submit"; document: RequestRevision }
  | { command: "request.revise"; revision: Parameters<typeof revisePurchaseRequest>[2] }
  | { command: "request.approve"; approval: Parameters<typeof approvePurchaseRequest>[2] }
  | { command: "order.issue"; document: PurchaseOrder }
  | { command: "order.amend"; amendment: Parameters<typeof amendPurchaseOrder>[2] }
  | { command: "receipt.post"; document: ReceiptRevision }
  | { command: "quarantine.resolve"; resolution: Parameters<typeof resolveQuarantineReceipt>[2] }
  | { command: "invoice.match"; document: SupplierInvoiceRevision }
  | { command: "custody.dispatch"; transfer: CustodyDispatch }
  | { command: "custody.acknowledge"; acknowledgement: CustodyAcknowledgement }
  | { command: "custody.consume" | "custody.return_to_store"; usage: CustodyUsageInput }
  | { command: "custody.stocktake"; stocktake: CustodyStocktakeInput }
  | { command: "custody.close_package"; closure: CustodyPackageClosureInput }
  | { command: "custody.approve_waste"; approval: CustodyWasteApprovalInput }
  | { command: "custody.propose_settlement"; settlement: CustodySettlementProposalInput }
  | { command: "custody.object_settlement"; objection: CustodySettlementObjectionInput }
  | { command: "legacy.reconcile"; reconciliation: LegacyReconciliationInput };

async function dispatch(actor: InventoryActor, key: string, input: CanonicalProcurementInput, authority: CanonicalInventoryAuthority): Promise<object> {
  switch (input.command) {
    // The requester is always the admitted actor, never a body field.
    case "request.submit": return submitPurchaseRequest(actor, key, { ...input.document, requestedBy: actor.userId }, authority);
    case "request.revise": return revisePurchaseRequest(actor, key, input.revision, authority);
    case "request.approve": return approvePurchaseRequest(actor, key, input.approval, authority);
    case "order.issue": return issuePurchaseOrder(actor, key, input.document, authority);
    case "order.amend": return amendPurchaseOrder(actor, key, input.amendment, authority);
    case "receipt.post": return postInspectedReceipt(actor, key, input.document, authority);
    case "quarantine.resolve": return resolveQuarantineReceipt(actor, key, input.resolution, authority);
    case "invoice.match": return recordSupplierInvoiceMatch(actor, key, input.document, authority);
    case "custody.dispatch": return dispatchCustodyTransfer(actor, key, input.transfer, authority);
    case "custody.acknowledge": return acknowledgeCustodyTransfer(actor, key, input.acknowledgement, authority);
    case "custody.consume":
      invariant(input.usage.kind === "consumed" || input.usage.kind === "approved_waste", "invalid_custody_usage", "Consumption records actual use or approved waste");
      return recordCustodyUsage(actor, key, input.usage, authority);
    case "custody.return_to_store":
      invariant(input.usage.kind === "returned_to_store", "invalid_custody_usage", "A return records unused issued quantity");
      return recordCustodyUsage(actor, key, input.usage, authority);
    case "custody.stocktake": return recordCustodyStocktake(actor, key, input.stocktake, authority);
    case "custody.close_package": return closeCustodyPackage(actor, key, input.closure, authority);
    case "custody.approve_waste": return approveCustodyWaste(actor, key, input.approval, authority);
    case "custody.propose_settlement": return proposeAnnualCustodySettlement(actor, key, input.settlement, authority);
    case "custody.object_settlement": return objectCustodySettlement(actor, key, input.objection, authority);
    case "legacy.reconcile": return reconcileHistoricalMovements(actor, key, input.reconciliation, authority);
    default: throw new InventoryDomainError("invalid_command", "Use a supported procurement transition");
  }
}

/** One admitted canonical operation for one exact command. */
export async function runCanonicalProcurementCommand(
  session: VerifiedDurableSession,
  operationKey: string,
  input: CanonicalProcurementInput,
  pool = getPool(),
): Promise<Record<string, unknown>> {
  invariant(isCanonicalProcurementCommand(input.command), "invalid_command", "Use a supported procurement transition");
  const action = PROCUREMENT_COMMAND_CAPABILITIES[input.command];
  return withCanonicalInventoryOperation(pool, session, action, async authority => {
    const actor: InventoryActor = { ...canonicalInventoryActor(authority) };
    return (await dispatch(actor, operationKey, input, authority)) as Record<string, unknown>;
  });
}
