/**
 * Read-only periodic Ortho follow-up classification. Not wired to the board.
 * Inputs are projections of existing records, not new persistent links.
 * A match identifies appointment purpose; it does not prove exact case linkage
 * or completion of clinical work. Due dates are deliberately not an input.
 */
export interface FollowupTarget {
  patientId: number;
  orthoCaseId: number;
  clinicalCaseId: number | null;
  startDate: string;
}

export interface FollowupBookingFacts {
  id: number;
  patientId: number;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  appointmentType?: string | null;
  serviceId: number | null;
  service: {
    id: number;
    code: string;
    specialty: string;
    legacyType: string | null;
  } | null;
  referralId: number | null;
  referral: {
    id: number;
    patientId: number;
    toSpecialty: string;
    caseId: number | null;
    casePatientId: number | null;
    orthoCaseId: number | null;
  } | null;
  plannedVisitId: number | null;
}

export type FollowupBookingClass = "identified_followup" | "other" | "needs_review" | "excluded";
export interface FollowupBookingDecision {
  classification: FollowupBookingClass;
  reason: string;
  basis: "designated_service" | "legacy_type" | null;
}

const SERVICE_SPECIALTIES = new Set([
  "general", "orthodontics", "endodontics", "surgery", "implantology",
  "prosthodontics", "periodontics", "pediatric", "radiology", "consultation",
  "emergency", "cosmetic", "other",
]);
const REFERRAL_SPECIALTIES = new Set([
  "oral_surgery", "periodontics", "endodontics", "prosthodontics", "implant",
  "restorative", "pediatric", "radiology", "ent", "other",
]);
const LEGACY_TYPES = new Set([
  "consultation", "follow_up", "emergency", "filling", "endo", "surgery",
  "prosthetics", "cleaning", "other",
]);
const NON_PERIODIC_ORTHO_CODES = new Set([
  "ORTHO_WIRE_CHANGE", "BRACKET_REBOND", "BRACKET_BONDING", "ORTHO_START", "ORTHO_DEBOND", "ORTHO_RECORDS",
]);
const own = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const optionalId = (value: unknown): boolean => value === null || id(value);
const nullableText = (value: unknown): boolean => value === null || typeof value === "string";
const decision = (classification: FollowupBookingClass, reason: string,
  basis: FollowupBookingDecision["basis"] = null): FollowupBookingDecision => ({ classification, reason, basis });

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTarget(target: FollowupTarget): boolean {
  return id(own(target, "patientId")) && id(own(target, "orthoCaseId"))
    && optionalId(own(target, "clinicalCaseId")) && validDate(own(target, "startDate"));
}

/** Missing projections are uncertainty, never permission to invent a link. */
export function classifyFollowupBooking(target: FollowupTarget, booking: FollowupBookingFacts): FollowupBookingDecision {
  if (!validTarget(target)) {
    return decision("needs_review", "invalid_target");
  }
  if (!id(own(booking, "id")) || !id(own(booking, "patientId"))) return decision("excluded", "invalid_identity");
  if (booking.patientId !== target.patientId) return decision("excluded", "different_patient");
  if (!validDate(own(booking, "scheduledDate")) || typeof own(booking, "scheduledTime") !== "string"
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(booking.scheduledTime)) return decision("excluded", "invalid_schedule");
  const status = own(booking, "status");
  if (status === "done" || status === "cancelled" || status === "no_show") return decision("excluded", "not_open");
  if (status !== "booked" && status !== "arrived") return decision("needs_review", "unknown_status");
  if (booking.scheduledDate < target.startDate) return decision("needs_review", "before_case_start");

  const serviceId = own(booking, "serviceId");
  const referralId = own(booking, "referralId");
  const plannedVisitId = own(booking, "plannedVisitId");
  if (!optionalId(serviceId) || !optionalId(referralId) || !optionalId(plannedVisitId)
    || own(booking, "service") === undefined || own(booking, "referral") === undefined) {
    return decision("needs_review", "missing_or_invalid_context");
  }

  // An explicit referral is not inferred from a patient, doctor or master plan.
  const referral = own(booking, "referral");
  if (referralId === null) {
    if (referral !== null) return decision("needs_review", "inconsistent_referral");
  } else {
    if (own(referral, "id") !== referralId || own(referral, "patientId") !== target.patientId
      || !optionalId(own(referral, "caseId")) || !optionalId(own(referral, "casePatientId"))
      || !optionalId(own(referral, "orthoCaseId"))) return decision("needs_review", "unresolved_referral");
    const specialty = own(referral, "toSpecialty");
    if (typeof specialty !== "string" || !REFERRAL_SPECIALTIES.has(specialty)) return decision("needs_review", "unknown_referral_specialty");
    const caseId = own(referral, "caseId");
    const orthoCaseId = own(referral, "orthoCaseId");
    const casePatientId = own(referral, "casePatientId");
    if (caseId === null) return decision("needs_review", "referral_without_case");
    if (casePatientId !== target.patientId) return decision("needs_review", "referral_patient_mismatch");
    if (orthoCaseId !== null && orthoCaseId !== target.orthoCaseId) return decision("needs_review", "different_referral_case");
    if (target.clinicalCaseId !== null && caseId !== target.clinicalCaseId) return decision("needs_review", "different_referral_case");
    if (orthoCaseId !== target.orthoCaseId && caseId !== target.clinicalCaseId) return decision("needs_review", "unresolved_referral_case");
    // Canonical referral specialties currently have no orthodontics identifier.
    if (specialty !== "other") return decision("needs_review", "contrary_referral_specialty");
  }
  // A planned visit can span specialties. Defer until item/session facts exist;
  // shared plan_id or doctor_id alone must never satisfy this classifier.
  if (plannedVisitId !== null) return decision("needs_review", "planned_visit_requires_review");

  const type = own(booking, "appointmentType");
  if (type !== undefined && type !== null && (typeof type !== "string" || !LEGACY_TYPES.has(type))) {
    return decision("needs_review", "unknown_appointment_type");
  }
  const service = own(booking, "service");
  if (serviceId === null) {
    if (service !== null) return decision("needs_review", "inconsistent_service");
    return type === "follow_up"
      ? decision("identified_followup", "service_less_legacy", "legacy_type")
      : type === undefined || type === null || type === "other"
        ? decision("needs_review", "untyped_legacy") : decision("other", "different_legacy_type");
  }
  if (own(service, "id") !== serviceId) return decision("needs_review", "unresolved_service");
  const specialty = own(service, "specialty");
  const code = own(service, "code");
  const legacyType = own(service, "legacyType");
  if (typeof specialty !== "string" || !SERVICE_SPECIALTIES.has(specialty)
    || typeof code !== "string" || !/^[A-Z][A-Z0-9_]{1,39}$/.test(code)
    || !nullableText(legacyType) || (legacyType !== null && !LEGACY_TYPES.has(legacyType as string))) {
    return decision("needs_review", "unknown_service_identifier");
  }
  if (specialty !== "orthodontics") return decision(type === "follow_up" ? "needs_review" : "other", "contrary_service_specialty");
  if (NON_PERIODIC_ORTHO_CODES.has(code)) return decision("needs_review", "other_ortho_service");
  const periodic = code === "ORTHO_FOLLOW_UP" || legacyType === "follow_up";
  if (!periodic) return decision("needs_review", "unclassified_ortho_service");
  if ((legacyType !== null && legacyType !== "follow_up") || (type != null && type !== "follow_up")) {
    return decision("needs_review", "conflicting_periodic_type");
  }
  return decision("identified_followup", "designated_periodic_service", "designated_service");
}

export type ClassifiedFollowupBooking = FollowupBookingDecision & {
  appointment: Pick<FollowupBookingFacts, "id" | "patientId" | "scheduledDate" | "scheduledTime" | "status">;
};

/** Actual dates/times only; no calculated due date, mutations, or auto-booking. */
export function selectFollowupBookings(input: {
  target: FollowupTarget;
  today: string;
  appointments: readonly FollowupBookingFacts[];
}): {
  nextAppointment: ClassifiedFollowupBooking | null;
  pastUnresolvedAppointment: ClassifiedFollowupBooking | null;
  reviewAppointments: ClassifiedFollowupBooking[];
  otherAppointments: ClassifiedFollowupBooking[];
} {
  if (!validTarget(input.target)) throw new RangeError("A valid patient and Ortho case are required");
  if (!validDate(input.today)) throw new RangeError("A valid clinic date is required");
  const rows = input.appointments.flatMap((booking): ClassifiedFollowupBooking[] => {
    const result = classifyFollowupBooking(input.target, booking);
    if (result.classification === "excluded") return [];
    // Avoid echoing inherited/extra properties such as a calculated dueDate.
    return [{ ...result, appointment: {
      id: booking.id, patientId: booking.patientId, scheduledDate: booking.scheduledDate,
      scheduledTime: booking.scheduledTime,
      status: typeof own(booking, "status") === "string" ? booking.status : "unknown",
    } }];
  });
  const chronological = (a: ClassifiedFollowupBooking, b: ClassifiedFollowupBooking) =>
    a.appointment.scheduledDate.localeCompare(b.appointment.scheduledDate)
    || a.appointment.scheduledTime.localeCompare(b.appointment.scheduledTime)
    || a.appointment.id - b.appointment.id;
  rows.sort(chronological);
  const relevant = rows.filter((row) => row.classification === "identified_followup");
  return {
    nextAppointment: relevant.find((row) => row.appointment.scheduledDate >= input.today) ?? null,
    pastUnresolvedAppointment: relevant.filter((row) => row.appointment.scheduledDate < input.today).at(-1) ?? null,
    reviewAppointments: rows.filter((row) => row.classification === "needs_review"),
    otherAppointments: rows.filter((row) => row.classification === "other"),
  };
}
