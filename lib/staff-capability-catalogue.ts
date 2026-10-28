/** Inert future policy catalogue. Nothing in this module grants access to live routes. */
export const STAFF_CAPABILITY_SCHEMA_VERSION = 1 as const;
/** Bump when authorization semantics change, even if the document schema does not. */
export const STAFF_AUTHORIZATION_POLICY_VERSION = 5 as const;

export const STAFF_CAPABILITIES = Object.freeze([
  "patients.create", "patients.edit", "patients.delete", "patients.export",
  "clinical.plans.view", "clinical.plans.edit", "clinical.xrays.view", "clinical.xrays.upload",
  "clinical.visits.document", "clinical.visits.sign",
  "appointments.create", "appointments.edit", "appointments.cancel", "appointments.override-capacity",
  "finance.invoices.view", "finance.invoices.create", "finance.invoices.cancel", "finance.invoices.mark-paid",
  "finance.payments.view", "finance.payments.collect", "finance.payments.refund", "finance.payments.void",
  "finance.expenses.view", "finance.expenses.create", "finance.expenses.void",
  "finance.shifts.view", "finance.shifts.operate", "finance.patient-ledger.view",
  "finance.service-prices.view", "finance.service-prices.edit", "finance.cost-prices.view",
  "finance.discounts.apply", "finance.discounts.override", "finance.price-increases.apply",
  "finance.commissions.view-own", "finance.commissions.view-all", "finance.commissions.manage-rates",
  "finance.revenue.view", "finance.profits.view", "finance.suppliers.view", "finance.reconciliation.view",
  "finance.export", "reports.operational.view", "reports.financial.view", "reports.clinical.view", "reports.export",
  "inventory.references.view", "inventory.items.create", "inventory.units.revise", "inventory.locations.create",
  // Inventory & procurement operations (M3a, docs/inventory/CENTRAL-PERMISSION-BINDINGS-20261027.md).
  "inventory.approval-policy.manage",
  "inventory.requests.view", "inventory.requests.create", "inventory.requests.approve",
  "inventory.orders.view", "inventory.orders.manage", "inventory.receipts.post", "inventory.quarantine.resolve",
  "inventory.supplier-invoices.record", "inventory.supplier-invoices.cancel",
  "inventory.custody.view", "inventory.custody.dispatch", "inventory.custody.acknowledge", "inventory.custody.use",
  "inventory.custody.stocktake", "inventory.custody.approve-waste",
  "inventory.custody.settlement.propose", "inventory.custody.settlement.object",
  "inventory.reconcile", "inventory.costs.view",
  "staff.view", "staff.profile.edit", "staff.accounts.create", "staff.accounts.disable", "staff.permissions.edit",
  "settings.view", "settings.operational.edit", "settings.finance.edit", "audit.view", "audit.export",
] as const);
export type StaffCapability = typeof STAFF_CAPABILITIES[number];

/** These are not editable grants and cannot occur in a permission document. */
export const OWNER_ONLY_OPERATIONS = Object.freeze([
  "staff.credentials.reset", "staff.clinician-link.change", "staff.role.change",
  "settings.security.change", "settings.integrations.change",
] as const);
export type OwnerOnlyOperation = typeof OWNER_ONLY_OPERATIONS[number];

export const STAFF_RECORD_SCOPES = Object.freeze(["none", "own", "all"] as const);
export type StaffRecordScope = typeof STAFF_RECORD_SCOPES[number];

export interface StaffCapabilityDocument {
  readonly schemaVersion: typeof STAFF_CAPABILITY_SCHEMA_VERSION;
  /** Monotonic server-managed revision; schemaVersion is not a revocation counter. */
  readonly revision: number;
  readonly patientScope: StaffRecordScope;
  readonly appointmentScope: StaffRecordScope;
  readonly grants: Readonly<Partial<Record<StaffCapability, boolean>>>;
}

const knownCapabilities = new Set<string>(STAFF_CAPABILITIES);
export function isStaffCapability(value: unknown): value is StaffCapability {
  return typeof value === "string" && knownCapabilities.has(value);
}

/** Explicit action prerequisites. Reads never imply writes, refunds, exports or delegation. */
export const STAFF_CAPABILITY_PREREQUISITES: Readonly<Partial<Record<StaffCapability, readonly StaffCapability[]>>> = Object.freeze({
  "inventory.items.create": Object.freeze(["inventory.references.view"] as const),
  "inventory.units.revise": Object.freeze(["inventory.references.view"] as const),
  "inventory.locations.create": Object.freeze(["inventory.references.view"] as const),
  "inventory.approval-policy.manage": Object.freeze(["inventory.references.view"] as const),
  "inventory.requests.create": Object.freeze(["inventory.requests.view", "inventory.references.view"] as const),
  "inventory.requests.approve": Object.freeze(["inventory.requests.view"] as const),
  "inventory.orders.manage": Object.freeze(["inventory.orders.view", "inventory.requests.view"] as const),
  "inventory.receipts.post": Object.freeze(["inventory.orders.view"] as const),
  "inventory.quarantine.resolve": Object.freeze(["inventory.orders.view"] as const),
  "inventory.supplier-invoices.record": Object.freeze(["inventory.orders.view", "finance.suppliers.view"] as const),
  "inventory.supplier-invoices.cancel": Object.freeze(["inventory.supplier-invoices.record"] as const),
  "inventory.custody.dispatch": Object.freeze(["inventory.custody.view"] as const),
  "inventory.custody.acknowledge": Object.freeze(["inventory.custody.view"] as const),
  "inventory.custody.use": Object.freeze(["inventory.custody.view"] as const),
  "inventory.custody.stocktake": Object.freeze(["inventory.custody.view"] as const),
  "inventory.custody.approve-waste": Object.freeze(["inventory.custody.view"] as const),
  "inventory.custody.settlement.propose": Object.freeze(["inventory.custody.view"] as const),
  "inventory.custody.settlement.object": Object.freeze(["inventory.custody.view"] as const),
  "inventory.reconcile": Object.freeze(["inventory.references.view"] as const),
  "inventory.costs.view": Object.freeze(["finance.cost-prices.view"] as const),
  "clinical.plans.edit": Object.freeze(["clinical.plans.view"] as const),
  "clinical.xrays.upload": Object.freeze(["clinical.xrays.view"] as const),
  "finance.invoices.cancel": Object.freeze(["finance.invoices.view"] as const),
  "finance.invoices.mark-paid": Object.freeze(["finance.invoices.view"] as const),
  "finance.payments.refund": Object.freeze(["finance.payments.view"] as const),
  "finance.payments.void": Object.freeze(["finance.payments.view"] as const),
  "finance.expenses.void": Object.freeze(["finance.expenses.view"] as const),
  "finance.shifts.operate": Object.freeze(["finance.shifts.view"] as const),
  "finance.service-prices.edit": Object.freeze(["finance.service-prices.view"] as const),
  "finance.discounts.override": Object.freeze(["finance.discounts.apply"] as const),
  "staff.profile.edit": Object.freeze(["staff.view"] as const),
  "staff.accounts.create": Object.freeze(["staff.view"] as const),
  "staff.accounts.disable": Object.freeze(["staff.view"] as const),
  "staff.permissions.edit": Object.freeze(["staff.view"] as const),
  "settings.operational.edit": Object.freeze(["settings.view"] as const),
  "settings.finance.edit": Object.freeze(["settings.view"] as const),
  "audit.export": Object.freeze(["audit.view"] as const),
});
