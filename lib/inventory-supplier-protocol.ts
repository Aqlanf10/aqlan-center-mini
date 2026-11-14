import type { StaffIdentityClaims } from "./staff-authenticated-identity";
import type { InvoiceVersionExpectation } from "./inventory-domain/supplier-finance";
import type { SupplierInvoiceRevision } from "./inventory-domain/procurement";
export const SUPPLIER_PROTOCOL = "inventory-supplier-v2" as const;
export type SupplierAction = "revise" | "post" | "cancel";
export type SupplierInput = InvoiceVersionExpectation & {
  document?: SupplierInvoiceRevision;
};
export interface SupplierIntent {
  protocol: typeof SUPPLIER_PROTOCOL;
  authority: StaffIdentityClaims;
  nonce: string;
  action: SupplierAction;
  input: SupplierInput;
}
export interface SupplierEnvelope extends SupplierIntent {
  operationKey: string;
  actorUserId: number;
  username: string;
}
export interface SupplierAdmission {
  envelope: SupplierEnvelope;
  digest: string;
}
export interface SupplierAcknowledgement extends SupplierAdmission {
  status: "committed" | "retired";
  result?: Record<string, unknown>;
  reason?: string;
}

export interface SupplierRejectedIntent {
  status: "rejected";
  intent: SupplierIntent;
  digest: string;
  code: "supplier_invoice_intent_pending";
  reason: string;
}
export type SupplierAdmissionResult =
  | SupplierAdmission
  | SupplierRejectedIntent;
