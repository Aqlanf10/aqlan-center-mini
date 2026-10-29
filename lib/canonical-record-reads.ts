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
} as const satisfies Readonly<Record<`read:${string}`, CanonicalRecordReadRule>>);

export type CanonicalRecordRead = keyof typeof CANONICAL_RECORD_READS;

export function isCanonicalRecordRead(value: unknown): value is CanonicalRecordRead {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CANONICAL_RECORD_READS, value);
}
export function canonicalRecordReadRule(read: CanonicalRecordRead): CanonicalRecordReadRule {
  return CANONICAL_RECORD_READS[read];
}
