import type { StaffCapability } from "./staff-capability-catalogue";

/**
 * Registered canonical RECORD reads (M2, docs/security/staff-cutover/M2_ROUTE_CAPABILITY_MAP.md).
 *
 * A record read is admitted by the owning RR snapshot reader when, in the same
 * snapshot:
 *  - every `need` capability is held, and one `anyOf` capability when any are listed;
 *  - the actor's record scope for `record` is not `none` (`own` requires the
 *    validated, active clinician link, `all` is explicit or the protected owner).
 * The reader hands the resulting constraint to the domain read, which must filter
 * rows by it. A role label never widens a scope; there is no caller-selected scope.
 *
 * Keys are a closed set and never collide with operation actions (`read:` prefix).
 */
export interface CanonicalRecordReadRule {
  readonly record: "patient" | "appointment";
  readonly need: readonly StaffCapability[];
  readonly anyOf: readonly StaffCapability[];
}

export const CANONICAL_RECORD_READS = Object.freeze({
  /** GET /api/ceph/compare and /superimpose: two saved studies, each in the patient scope. */
  "read:ceph.compare": Object.freeze({ record: "patient", need: Object.freeze(["clinical.xrays.view"] as const), anyOf: Object.freeze([]) }),
  "read:ceph.superimpose": Object.freeze({ record: "patient", need: Object.freeze(["clinical.xrays.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho/followups: clinical follow-up; appointment facts separately scoped. */
  "read:ortho.decisions": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  "read:ortho.followups": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/plans: clinical facts only, independent plan grant and patient scope. */
  "read:plans.clinical": Object.freeze({ record: "patient", need: Object.freeze(["clinical.plans.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ceph/[id]: saved measurements and diagnosis, no image payload or mutations. */
  "read:ceph.study": Object.freeze({ record: "patient", need: Object.freeze(["clinical.xrays.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/ceph: bounded saved study summaries, independent imaging grant. */
  "read:ceph.list": Object.freeze({ record: "patient", need: Object.freeze(["clinical.xrays.view"] as const), anyOf: Object.freeze([]) }),
  /** GET proposals: existing plan-edit grant and patient scope, independent balances. */
  "read:plans.proposals": Object.freeze({ record: "patient", need: Object.freeze(["clinical.plans.edit"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/legacy, /legacy-onboarding, /legacy-treatments and
   * /historical-documents (M2 slice 95a, G4-2): the clinical description with the patient record
   * read; every amount with finance.patient-ledger.view; plan sources with clinical.plans.view. */
  "read:patients.history": Object.freeze({ record: "patient", need: Object.freeze([] as const), anyOf: Object.freeze([]) }),
  /** GET /api/plans/[id]/agreement-amendment and /reconcile: the agreement previews inside the
   * patient scope; finance.agreements.manage (M2 slice 94d-2). */
  "read:plans.agreement": Object.freeze({ record: "patient", need: Object.freeze(["finance.agreements.manage"] as const), anyOf: Object.freeze([]) }),
  /** GET coverage: agreement authority and patient scope, independent invoice projection. */
  "read:ortho.coverage": Object.freeze({ record: "patient", need: Object.freeze(["finance.agreements.manage"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho/[id]/strategy: saved clinical strategy, separate plan-link grant (M2 slice 32). */
  "read:ortho.strategy": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho/[id]/assessment: immutable clinical assessment read (M2 slice 31). */
  "read:ortho.assessment": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho/[id]: native clinical detail only (M2 slice 30). */
  "read:ortho.case": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho: bounded case summaries, never funding or imaging (M2 slice 29). */
  "read:ortho.cases": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients: search and browse the patient list. */
  "read:patients.directory": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/ledger and the patient account reads (M2 slice 88): the
   * patient's whole financial account inside the patient scope; finance.patient-ledger.view. */
  "read:patients.ledger": Object.freeze({ record: "patient", need: Object.freeze(["finance.patient-ledger.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/invoices (?patientId), /api/invoices/[id], /api/invoices/archive and
   * /api/invoices/[id]/archive: invoices inside the patient scope; finance.invoices.view
   * (M2 slice 92). The ledger grant never substitutes (owner decision 6629149113). */
  "read:invoices.patient": Object.freeze({ record: "patient", need: Object.freeze(["finance.invoices.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/visits/[id]/walkout and /billing-preview: the visit's dues inside the patient
   * scope; finance.invoices.view admits, the other groups by their own grants (M2 slice 89). */
  "read:visits.money": Object.freeze({ record: "patient", need: Object.freeze(["finance.invoices.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/visits/[id]/financial-context: coverage for documenters, references with the
   * invoice view (M2 slice 89). */
  "read:visits.financial-context": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze(["clinical.visits.document", "finance.invoices.view"] as const) }),
  /** GET /api/payments (?date): the day's receipts, rows inside the patient scope;
   * finance.payments.view (M2 slice 90a, G4-4). */
  "read:payments.day": Object.freeze({ record: "patient", need: Object.freeze(["finance.payments.view"] as const), anyOf: Object.freeze([]) }),
  /** POST /api/invoices/clinical-preview: the read-only linkage preview with the same parser and
   * price engine as creation, inside the patient scope (M2 slice 93b, G4-1). */
  "read:invoices.preview": Object.freeze({ record: "patient", need: Object.freeze(["finance.invoices.create"] as const), anyOf: Object.freeze([]) }),
  /** GET and PUT /api/invoices/[id]/add-service: the form context and the preview, the invoice's
   * patient inside the scope (M2 slice 93b-2, G4-1). */
  "read:invoices.add-service": Object.freeze({ record: "patient", need: Object.freeze(["finance.invoices.create"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/invoices/[id]/correct: the correction context, the invoice's patient inside the
   * scope (M2 slice 93c, G4-8). */
  "read:invoices.correct": Object.freeze({ record: "patient", need: Object.freeze(["finance.invoices.correct"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/plans: the plan list, its groups by grant (M2 slice 94a, G4-1; contract section 9). */
  "read:plans.list": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze(["clinical.plans.view", "finance.invoices.view", "finance.patient-ledger.view"] as const) }),
  /** GET /api/finance/debts: the debtors list, rows inside the actor's patient scope (M2 slice 88). */
  "read:finance.debts": Object.freeze({ record: "patient", need: Object.freeze(["finance.patient-ledger.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]: one patient's file, only inside the actor's patient scope. */
  "read:patients.record": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/families/[id] and /api/patients/[id]/family: members inside the patient
   * scope; balances only with finance.patient-ledger.view (M2 slice 72). */
  "read:families.record": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/families (?q, ?phone): linking search for family writers, members inside
   * the patient scope only (M2 slice 72). */
  /** GET /api/patients/[id]/documents and GET /api/documents/[id]: X-rays and documents
   * inside the patient scope; hidden ones only with patients.documents.delete (M2 slice 75). */
  "read:documents.list": Object.freeze({ record: "patient", need: Object.freeze(["clinical.xrays.view"] as const), anyOf: Object.freeze([]) }),
  "read:documents.file": Object.freeze({ record: "patient", need: Object.freeze(["clinical.xrays.view"] as const), anyOf: Object.freeze([]) }),
  "read:families.search": Object.freeze({ record: "patient", need: Object.freeze(["patients.edit"] as const), anyOf: Object.freeze([]) }),
  /** Clinical sub-reads of one patient (medical history, vitals, problems): a clinical
   * grant (the care group of lib/canonical-patient-reads.ts) inside the patient scope. */
  "read:patients.clinical": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze(["clinical.plans.view", "clinical.visits.document", "clinical.xrays.view"] as const) }),
  /** GET /api/visits: today's queue, rows inside the actor's patient scope (M2 slice 11). */
  "read:visits.today": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/visits/readiness: chair readiness of today's visits (or one patient's), rows
   * inside the actor's patient scope, details by grant (M2 slice 13). */
  "read:visits.readiness": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/waiting-list and /api/waiting-list/[id]: entries inside the actor's
   * appointment scope (M2 slice 14). */
  "read:waiting-list": Object.freeze({ record: "appointment", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/appointments?date=: one day's appointments inside the appointment scope (M2 slice 15). */
  "read:appointments.day": Object.freeze({ record: "appointment", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/appointments/mine: the actor's own clinician schedule (M2 slice 15). */
  "read:appointments.mine": Object.freeze({ record: "appointment", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/recall: open past appointments, missed appointments and lapsed patients
   * inside the actor's patient scope (M2 slice 24). */
  "read:recall": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/booking-requests: the online booking queue — appointments.create and the
   * whole appointment scope (M2 slice 21). */
  "read:booking-requests": Object.freeze({ record: "appointment", need: Object.freeze(["appointments.create"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/provider-blocks: one doctor's active blocks on one clinic day, inside the
   * appointment scope (`own` = the actor's own clinician party only) (M2 slice 25). */
  "read:provider-blocks": Object.freeze({ record: "appointment", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/lab: lab orders (and their badge counts) inside the patient scope, the
   * money group only with finance.cost-prices.view (M2 slice 66). */
  "read:lab.orders": Object.freeze({ record: "patient", need: Object.freeze(["clinical.lab.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/lab/backlog: the whole clinic's open lab work; the reader requires the
   * WHOLE patient scope (`all`) (M2 slice 66). */
  "read:lab.backlog": Object.freeze({ record: "patient", need: Object.freeze(["clinical.lab.view"] as const), anyOf: Object.freeze([]) }),
  /** One lab order's tracking events (PATCH /api/lab/[id] action=events), inside the
   * patient scope (M2 slice 67). */
  "read:lab.events": Object.freeze({ record: "patient", need: Object.freeze(["clinical.lab.view"] as const), anyOf: Object.freeze([]) }),
} as const satisfies Readonly<Record<`read:${string}`, CanonicalRecordReadRule>>);

export type CanonicalRecordRead = keyof typeof CANONICAL_RECORD_READS;

export function isCanonicalRecordRead(value: unknown): value is CanonicalRecordRead {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CANONICAL_RECORD_READS, value);
}
export function canonicalRecordReadRule(read: CanonicalRecordRead): CanonicalRecordReadRule {
  return CANONICAL_RECORD_READS[read];
}
