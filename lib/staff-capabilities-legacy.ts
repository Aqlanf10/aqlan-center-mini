import { parseDoctorPermissions, type DoctorPermissions } from "./doctor-permissions";
import { financeAccessFor } from "./finance-permissions";
import { isRole, type Role } from "./roles";
import { classifyStaffPermissionEnvelope } from "./staff-permission-envelope";
import type { StaffCapability } from "./staff-capability-catalogue";

/** A review report, deliberately NOT a canonical document or authorization context. */
export interface LegacyStaffCapabilityReview {
  readonly kind: "legacy-review";
  readonly role: Role;
  readonly requiresMigrationReview: true;
  readonly owner: false;
  readonly patientRead: "none" | "own" | "all" | "today";
  readonly patientEdit: "none" | "own" | "all";
  readonly patientDelete: "none" | "all";
  readonly appointmentRead: "none" | "own-and-unassigned" | "all";
  /** Legacy flag/helper overlaps only, NOT effective authorization for every route. */
  readonly observedCapabilities: Readonly<Partial<Record<StaffCapability, true>>>;
  readonly blockers: readonly string[];
}
export type LegacyStaffAdapterResult =
  | { readonly ok: true; readonly value: LegacyStaffCapabilityReview }
  | { readonly ok: false; readonly reason: string };

/**
 * Explicit, read-only compatibility adapter. It reads the legacy parser's behavior;
 * it does not call the canonical resolver, write profiles, infer an owner or identity,
 * or promise that scattered legacy routes enforce every stored toggle.
 */
export function reviewLegacyStaffCapabilities(role: unknown, rawPermissions: unknown): LegacyStaffAdapterResult {
  if (!isRole(role)) return { ok: false, reason: "unknown-legacy-role" };
  const envelope = classifyStaffPermissionEnvelope(rawPermissions);
  if (envelope.kind === "canonical") return { ok: false, reason: "versioned-document-requires-strict-parser" };
  if (envelope.kind === "invalid") return { ok: false, reason: envelope.reason };

  const p: DoctorPermissions = parseDoctorPermissions(envelope.value, role);
  const grants: Partial<Record<StaffCapability, true>> = {};
  const add = (condition: boolean, ...keys: StaffCapability[]) => { if (condition) for (const key of keys) grants[key] = true; };
  const admin = role === "admin";
  const reception = role === "reception";
  const doctor = role === "doctor";
  const cashier = role === "cashier";
  const accountant = role === "accountant";
  const moneyReader = admin || reception || cashier || accountant;
  const f = financeAccessFor(role, p.financeAccess);
  const blockers = [
    "Review report only: route/resource projections, mutation guards and revocation must be integrated before activation.",
    "Unmapped operations remain denied in the future catalogue; this report is not a lossless migration.",
    "Observed capabilities describe legacy flags/helpers, not all route responses. PR191 financial-summary profit requires revenue + expenses + profit permission; a profit flag alone does not expose net.",
    "Existing users.party_id remains separate; never infer or create a clinician binding from these grants.",
  ];

  add(admin || reception || (doctor && p.canAddPatient), "patients.create");
  add(admin || reception || (doctor && p.canEditPatient), "patients.edit");
  add(admin, "patients.delete"); // The actual DELETE route is admin-only, even if a doctor flag says true.
  add(admin || reception || (doctor && p.canViewPlans), "clinical.plans.view");
  add(admin || reception || (doctor && p.canEditPlans), "clinical.plans.edit");
  add(admin || reception || (doctor && p.canViewXrays), "clinical.xrays.view");
  add(admin || reception || (doctor && p.canUploadXrays), "clinical.xrays.upload");
  add(admin || reception || doctor, "settings.view");
  add(moneyReader, "finance.invoices.view", "finance.payments.view", "finance.expenses.view", "finance.shifts.view");
  add(admin || reception || accountant, "finance.service-prices.view");
  add(admin || reception, "finance.invoices.create"); // Cashier's proxy allowlist excludes invoice POST.
  add(admin || reception || (cashier && f.collectPayments), "finance.payments.collect");
  add(admin || reception || (cashier && f.createExpenses), "finance.expenses.create");
  add(admin || reception || (cashier && f.operateShift), "finance.shifts.operate");
  add(admin || reception || ((cashier || accountant) && f.viewPatientLedger) || (doctor && p.canViewPatientPayments), "finance.patient-ledger.view");
  add(admin, "finance.invoices.cancel", "finance.invoices.mark-paid", "finance.payments.refund", "finance.expenses.void",
    "finance.service-prices.edit", "finance.discounts.override", "finance.price-increases.apply", "finance.commissions.manage-rates");
  add(admin || reception || doctor, "finance.discounts.apply"); // Still subject to configured ceiling/reason/route guards.
  add(admin || (doctor && p.canViewCostPrices), "finance.cost-prices.view");
  add(doctor && p.canViewExpenses, "finance.expenses.view");
  add(doctor && p.canViewCashDrawer, "finance.shifts.view");
  add(doctor && p.canViewServicePrices, "finance.service-prices.view");
  add(admin || (doctor && (p.canViewClinicRevenue || p.canViewClinicFinance)), "finance.revenue.view");
  add(admin || (doctor && (p.canViewClinicProfits || p.canViewAdminReports)), "finance.profits.view");
  add(doctor && p.canViewOwnCommissions, "finance.commissions.view-own");
  add(admin || (accountant && f.viewCommissions) || (doctor && p.canViewOwnCommissions
    && (p.canViewClinicRevenue || p.canViewClinicFinance || p.canViewOtherDoctorsAccounts)), "finance.commissions.view-all");
  add(admin || (accountant && f.viewReports), "reports.financial.view");
  add(admin || reception, "reports.operational.view");
  add(admin, "reports.clinical.view", "staff.view", "staff.profile.edit", "staff.accounts.create", "staff.accounts.disable", "staff.permissions.edit", "settings.view", "settings.operational.edit", "settings.finance.edit", "audit.view");
  add(admin || (accountant && f.viewSuppliers), "finance.suppliers.view");
  add(admin || (accountant && f.viewReconciliation), "finance.reconciliation.view");

  if (admin) blockers.push("Legacy admin is unrestricted and ignores permission JSON; it is not an owner identity and cannot become a scoped manager until role bypasses are removed.");
  if (reception) blockers.push("Reception patient/plan operations bypass several stored toggles. Restricting the JSON or UI alone does not restrict the actual routes.");
  if (doctor) blockers.push("Legacy all-patient viewing still permits demographic edits only to owned patients. Own appointments also include owned-patient and unassigned appointments; future strict own scope cannot be substituted blindly.");
  if (role === "assistant") blockers.push("Assistant today-only patient/visit access cannot be represented by none/own/all; no broad patient grant is inferred.");
  if (cashier || accountant) blockers.push("Finance role boundaries depend on both role-routes and financeAccess. Report IDs, financial patient summaries and print paths need their existing fine-grained projections retained.");

  return { ok: true, value: Object.freeze({
    kind: "legacy-review", role, requiresMigrationReview: true, owner: false,
    patientRead: admin || reception ? "all" : doctor ? (p.canViewAllPatients ? "all" : "own") : role === "assistant" ? "today" : "none",
    patientEdit: admin || reception ? "all" : doctor && p.canEditPatient ? "own" : "none",
    patientDelete: admin ? "all" : "none",
    appointmentRead: admin || reception ? "all" : doctor ? (p.canViewAllAppointments ? "all" : "own-and-unassigned") : "none",
    observedCapabilities: Object.freeze(grants), blockers: Object.freeze(blockers),
  }) };
}
