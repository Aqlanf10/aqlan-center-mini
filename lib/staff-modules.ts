/** Browser-safe module projection of the canonical capability catalogue (owner decision 4,
 * Dot 6484846432). A module is a named set of capabilities; every catalogue capability
 * belongs to exactly one module (unit-tested). "Hiding" a module for a staff member means
 * revoking every capability in it, saved atomically through the existing editor write.
 * The server then refuses every route, page and API of that module from the account's
 * current grants: nothing here is a client-side switch. */
import { STAFF_CAPABILITIES, type StaffCapability } from "./staff-capability-catalogue";

export interface StaffModule { readonly key: string; readonly label: string; readonly capabilities: readonly StaffCapability[] }

const byPrefix = (...prefixes: string[]) => STAFF_CAPABILITIES.filter(capability => prefixes.some(prefix => capability.startsWith(prefix)));
const LAB = ["clinical.lab.", "clinical.laboratories.", "finance.lab-prices."];
const ORTHO = ["clinical.ortho.", "clinical.ceph."];

export const STAFF_MODULES: readonly StaffModule[] = Object.freeze([
  { key: "patients", label: "المرضى", capabilities: byPrefix("patients.") },
  { key: "appointments", label: "المواعيد", capabilities: byPrefix("appointments.") },
  { key: "visits", label: "الزيارات والوصول", capabilities: byPrefix("visits.") },
  { key: "clinic", label: "العيادة (التوثيق السريري)", capabilities: byPrefix("clinical.").filter(c => !LAB.some(p => c.startsWith(p)) && !ORTHO.some(p => c.startsWith(p))) },
  { key: "ortho", label: "التقويم والسيفالومتري", capabilities: byPrefix(...ORTHO) },
  { key: "lab", label: "المختبر", capabilities: byPrefix(...LAB) },
  { key: "finance", label: "المالية", capabilities: byPrefix("finance.").filter(c => !LAB.some(p => c.startsWith(p))) },
  { key: "reports", label: "التقارير", capabilities: byPrefix("reports.") },
  { key: "inventory", label: "المخزون والمشتريات", capabilities: byPrefix("inventory.") },
  { key: "hr", label: "الموارد البشرية", capabilities: byPrefix("hr.") },
  { key: "work", label: "المهام والرسائل", capabilities: byPrefix("tasks.", "messages.") },
  { key: "staff", label: "الطاقم والصلاحيات", capabilities: byPrefix("staff.") },
  { key: "settings", label: "الإعدادات", capabilities: byPrefix("settings.") },
  { key: "audit", label: "سجل التدقيق", capabilities: byPrefix("audit.") },
].map(module => Object.freeze({ ...module, capabilities: Object.freeze(module.capabilities) })));

export function staffModuleOf(capability: StaffCapability): StaffModule {
  const module = STAFF_MODULES.find(candidate => candidate.capabilities.includes(capability));
  if (!module) throw new Error(`capability without a module: ${capability}`);
  return module;
}
/** A module is visible to an account when it holds at least one of its capabilities. */
export function staffModuleVisible(module: StaffModule, grants: ReadonlySet<StaffCapability>): boolean {
  return module.capabilities.some(capability => grants.has(capability));
}
