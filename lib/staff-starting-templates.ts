/** Reviewed starting templates by type of work (owner decision 3, Dot 6484846432).
 *
 * A template is a SUGGESTION the editor can fill in for one account; nothing is granted
 * until the owner (or a delegated editor within its own authority) reviews it and saves
 * that account through the normal atomic, audited write. There is no automatic
 * conversion of legacy roles and no template is ever applied by a role label.
 * Templates are closed under prerequisites and never contain owner-only operations
 * (unit-tested). The clinical assistant's legacy scope ("today's visits only") has no
 * canonical record scope yet, so no assistant template is offered (owner decision
 * pending); the owner can still grant an assistant account explicitly. */
import type { StaffCapability, StaffRecordScope } from "./staff-capability-catalogue";

export interface StaffStartingTemplate {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly patientScope: StaffRecordScope;
  readonly appointmentScope: StaffRecordScope;
  readonly grants: readonly StaffCapability[];
}
const COMMON: readonly StaffCapability[] = ["tasks.use", "messages.use", "hr.leaves.request"];

export const STAFF_STARTING_TEMPLATES: readonly StaffStartingTemplate[] = Object.freeze(([
  {
    key: "reception", label: "استقبال", description: "تسجيل المرضى والمواعيد والوصول، والتحصيل في وردية الصندوق، مع الملخص التشغيلي دون البيانات السريرية.",
    patientScope: "all", appointmentScope: "all",
    grants: ["patients.create", "patients.edit", "patients.operational-summary.view", "appointments.create", "appointments.edit", "appointments.cancel",
      "visits.manage", "finance.patient-ledger.view", "finance.invoices.view", "finance.invoices.create", "finance.payments.view", "finance.payments.collect",
      "finance.shifts.view", "finance.shifts.operate", "finance.service-prices.view", ...COMMON],
  },
  {
    key: "cashier", label: "كاشير", description: "التحصيل وورديات الصندوق وكشف حساب المريض، دون المواعيد أو البيانات السريرية.",
    patientScope: "all", appointmentScope: "none",
    grants: ["finance.patient-ledger.view", "finance.invoices.view", "finance.payments.view", "finance.payments.collect",
      "finance.shifts.view", "finance.shifts.operate", ...COMMON],
  },
  {
    key: "accountant", label: "محاسب", description: "القراءة المالية والمصروفات والتقارير المالية وتصديرها المحدود، دون التحصيل أو البيانات السريرية.",
    patientScope: "all", appointmentScope: "none",
    grants: ["finance.invoices.view", "finance.payments.view", "finance.expenses.view", "finance.expenses.create", "finance.patient-ledger.view",
      "finance.revenue.view", "finance.suppliers.view", "finance.reconciliation.view", "finance.service-prices.view", "finance.cost-prices.view",
      "finance.shifts.view", "reports.financial.view", "reports.export", "finance.export", ...COMMON],
  },
  {
    key: "doctor", label: "طبيب", description: "مرضاه ومواعيده فقط: التوثيق والتوقيع والخطط والأشعة والتقويم والوصفات والإحالات والمختبر، ومستحقاته الشخصية.",
    patientScope: "own", appointmentScope: "own",
    grants: ["clinical.plans.view", "clinical.plans.edit", "clinical.xrays.view", "clinical.xrays.upload", "clinical.visits.document", "clinical.visits.sign",
      "clinical.ortho.view", "clinical.ortho.edit", "clinical.ceph.analyze", "clinical.prescriptions.write", "clinical.referrals.manage",
      "clinical.lab.view", "clinical.lab.order", "finance.service-prices.view", "finance.commissions.view-own", "reports.clinical.view", ...COMMON],
  },
  {
    key: "lab-coordinator", label: "منسق مختبر", description: "متابعة أوامر المختبر وتحديثها والمختبرات، مع الملخص التشغيلي للمرضى.",
    patientScope: "all", appointmentScope: "none",
    grants: ["patients.operational-summary.view", "clinical.lab.view", "clinical.lab.order", "clinical.laboratories.manage", ...COMMON],
  },
  {
    key: "inventory-keeper", label: "أمين مخزن", description: "الأصناف والمواقع والاستلام والفحص وصرف العهدة، دون التكاليف أو الاعتماد.",
    patientScope: "none", appointmentScope: "none",
    grants: ["inventory.references.view", "inventory.items.create", "inventory.units.revise", "inventory.locations.create", "inventory.requests.view",
      "inventory.orders.view", "inventory.receipts.post", "inventory.quarantine.resolve", "inventory.custody.view", "inventory.custody.dispatch", ...COMMON],
  },
] satisfies StaffStartingTemplate[]).map(template => Object.freeze({ ...template, grants: Object.freeze([...template.grants]) as readonly StaffCapability[] })));

/** What applying a template to the editor form would produce for this actor: the
 * template's grants and scopes limited to what the actor may delegate. Dropped items are
 * reported so the screen can say so; nothing is saved here. */
export function applyStartingTemplate(template: StaffStartingTemplate, delegable: ReadonlySet<StaffCapability>, scopeOptions: Readonly<{ patient: readonly StaffRecordScope[]; appointment: readonly StaffRecordScope[] }>) {
  const grants = new Set(template.grants.filter(capability => delegable.has(capability)));
  const dropped = template.grants.filter(capability => !delegable.has(capability));
  const patientScope: StaffRecordScope = scopeOptions.patient.includes(template.patientScope) ? template.patientScope : "none";
  const appointmentScope: StaffRecordScope = scopeOptions.appointment.includes(template.appointmentScope) ? template.appointmentScope : "none";
  return { grants, dropped, patientScope, appointmentScope, scopeLimited: patientScope !== template.patientScope || appointmentScope !== template.appointmentScope };
}
