import type { InventoryCommandIdentity } from "./inventory-domain/command-lifecycle";

export const REFERENCE_PROTOCOL = "inventory-reference-v1" as const;
/** Values supplied by the central server adapter. They are never permission grants. */
export interface ReferenceAuthority {
  realmId: string;
  subjectId: string;
  generation: string;
}
export type ReferenceInput =
  | {
      action: "item.create";
      name: string;
      category: string;
      baseUnit: string;
      basePrecision: number;
      minLevel: string;
      note: string;
      reason: string;
    }
  | {
      action: "unit.revise";
      itemId: number;
      expectedVersion: number;
      enteredUnit: string;
      factor: string;
      enteredPrecision: number;
      basePrecision: number;
      reason: string;
    }
  | {
      action: "location.create";
      id: string;
      label: string;
      kind: "store" | "transit" | "custody";
      doctorPartyId: number | null;
      reason: string;
    }
  | {
      action: "policy.revise";
      expectedVersion: number;
      limitMinor: number;
      reason: string;
    };
export type ReferenceAction = ReferenceInput["action"];
export interface ReferenceIntent {
  protocol: typeof REFERENCE_PROTOCOL;
  authority: ReferenceAuthority;
  nonce: string;
  input: ReferenceInput;
}
export interface ReferenceAdmission {
  intent: ReferenceIntent;
  identity: InventoryCommandIdentity;
}
export interface ReferenceResult {
  action: ReferenceAction;
  id: string;
  version: number;
}
export type ReferenceReply = ReferenceAdmission &
  (
    | { status: "admitted" | "pending" }
    | { status: "committed"; result: ReferenceResult & { replayed: boolean } }
    | { status: "retired"; reason: string }
  );
export interface ReferenceRead {
  authority: ReferenceAuthority;
  allowedActions: ReferenceAction[];
  items: {
    id: number;
    name: string;
    category: string;
    unit: string;
    isActive: boolean;
    version: number;
    enteredUnit: string | null;
    factor: string | null;
    enteredPrecision: number | null;
    basePrecision: number | null;
  }[];
  locations: {
    id: string;
    label: string;
    kind: string;
    doctorPartyId: number | null;
    isActive: boolean;
  }[];
  doctors: { id: number; name: string }[];
  policy: {
    version: number;
    limitMinor: number;
    allowSelfApproval: boolean;
  } | null;
  page: number;
  hasMore: boolean;
  query: string;
}
