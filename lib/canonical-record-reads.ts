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
  /** GET /api/ortho: bounded case summaries, never funding or imaging (M2 slice 29). */
  "read:ortho.cases": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho/[id], /api/ortho/[id]/assessment, /api/ortho/[id]/strategy (M2 slice 31). */
  "read:ortho.case": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho/followups: daily follow-up board inside patient scope (M2 slice 31). */
  "read:ortho.followups": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho/billing-decisions: pending outside-contract adjustment decisions inside patient scope (M2 slice 31). */
  "read:ortho.billing-decisions": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/ortho/[id]/followup-coverage: agreement follow-up coverage read inside patient scope (M2 slice 31). */
  "read:ortho.followup-coverage": Object.freeze({ record: "patient", need: Object.freeze(["finance.agreements.manage"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/plans: one patient's treatment plans inside patient scope (M2 slice 32). */
  "read:patients.plans": Object.freeze({ record: "patient", need: Object.freeze(["clinical.plans.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/plans: active treatment plans or single plan read inside patient scope (M2 slice 32). */
  "read:plans": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze(["clinical.plans.view", "finance.invoices.view"] as const) }),
  /** GET /api/plans/proposals: pending plan proposals inside patient scope (M2 slice 32). */
  "read:plans.proposals": Object.freeze({ record: "patient", need: Object.freeze(["clinical.plans.edit"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/plans/[id]/agreement-amendment: approved-agreement amendment snapshot inside patient scope (M2 slice 32). */
  "read:plans.agreement-amendment": Object.freeze({ record: "patient", need: Object.freeze(["finance.agreements.manage"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/plans/[id]/reconcile: approved-agreement reconciliation snapshot inside patient scope (M2 slice 32). */
  "read:plans.reconcile": Object.freeze({ record: "patient", need: Object.freeze(["finance.agreements.manage"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/lab: operational lab orders inside patient scope with cost projection (M2 slice 33). */
  "read:lab.orders": Object.freeze({ record: "patient", need: Object.freeze(["clinical.lab.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/lab/backlog: whole-clinic open lab oversight inside whole patient scope (M2 slice 33). */
  "read:lab.backlog": Object.freeze({ record: "patient", need: Object.freeze(["clinical.lab.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/documents and /api/documents/[id]: active documents inside patient scope (M2 slice 34). */
  "read:patients.documents": Object.freeze({ record: "patient", need: Object.freeze(["clinical.xrays.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/prescriptions: prescriptions, suggestions, prescriber options inside patient scope (M2 slice 34). */
  "read:patients.prescriptions": Object.freeze({ record: "patient", need: Object.freeze(["clinical.prescriptions.write"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/prescriptions/saved: minimal stored-prescription print picker inside patient scope (M2 slice 34). */
  "read:patients.prescriptions-saved": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze(["clinical.prescriptions.write", "patients.operational-summary.view"] as const) }),
  /** GET /api/patients/[id]/ceph, /api/ceph/[id], /api/ceph/compare, /api/ceph/superimpose (M2 slice 30). */
  "read:ceph": Object.freeze({ record: "patient", need: Object.freeze(["clinical.xrays.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients: search and browse the patient list. */
  "read:patients.directory": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]: one patient's file, only inside the actor's patient scope. */
  "read:patients.record": Object.freeze({ record: "patient", need: Object.freeze([]), anyOf: Object.freeze([]) }),
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
  /** GET /api/appointments/availability: advisory booking slots inside appointment scope (`own` = own clinician only) (M2 slice 35). */
  "read:appointments.availability": Object.freeze({ record: "appointment", need: Object.freeze([]), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/number: patient number snapshot inside patient scope (M2 slice 35). */
  "read:patients.number": Object.freeze({ record: "patient", need: Object.freeze(["patients.number.manage"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/ledger, /statement, /treatment-financial-context, /debt-repayments, /legacy-balance-arrangement (M2 slice 36). */
  "read:patients.ledger": Object.freeze({ record: "patient", need: Object.freeze(["finance.patient-ledger.view"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/responsibility (M2 slice 36). */
  "read:patients.responsibility": Object.freeze({ record: "patient", need: Object.freeze(["finance.patient-ledger.manage"] as const), anyOf: Object.freeze([]) }),
  /** POST /api/patients/[id]/historical-documents/preview (read-only snapshot, M2 slice 36). */
  "read:patients.history-preview": Object.freeze({ record: "patient", need: Object.freeze(["patients.history.record"] as const), anyOf: Object.freeze([]) }),
  /** POST /api/patients/[id]/legacy-treatments/preview (read-only snapshot, M2 slice 36). */
  "read:patients.legacy-preview": Object.freeze({ record: "patient", need: Object.freeze(["finance.legacy.record"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/patients/[id]/legacy-treatments/[agreementId]/void (M2 slice 36). */
  "read:patients.legacy-void": Object.freeze({ record: "patient", need: Object.freeze(["finance.legacy.void"] as const), anyOf: Object.freeze([]) }),
  /** GET /api/visits/[id]/walkout, /billing-preview, /financial-context (M2 slice 36). */
  "read:visits.invoices": Object.freeze({ record: "patient", need: Object.freeze(["finance.invoices.view"] as const), anyOf: Object.freeze([]) }),
} as const satisfies Readonly<Record<`read:${string}`, CanonicalRecordReadRule>>);

export type CanonicalRecordRead = keyof typeof CANONICAL_RECORD_READS;

export function isCanonicalRecordRead(value: unknown): value is CanonicalRecordRead {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CANONICAL_RECORD_READS, value);
}
export function canonicalRecordReadRule(read: CanonicalRecordRead): CanonicalRecordReadRule {
  return CANONICAL_RECORD_READS[read];
}
