import {
  canReadAppointment, patientAppointmentVisibility, type AppointmentReadScope,
} from "./appointment-read-scope";
import type { Referral } from "./referrals";

/** Internal evidence from the actual joined appointment, never from the referral's recipient. */
interface AppointmentReference {
  id: number;
  patientId: number | null;
  doctorId: number | null;
}

/**
 * Patient GET response projection only. Referral clinical/workflow fields survive
 * unchanged, and the canonical calendar reader remains the sole grant authority.
 * Never use this projected object for a referral write or transition check.
 */
export function projectReferralAppointmentMetadata(
  referral: Referral,
  scope: AppointmentReadScope,
  references: { current: AppointmentReference | null; last: AppointmentReference | null },
): Referral {
  const visibility = patientAppointmentVisibility(scope, referral.patientId);
  const samePatient = (reference: AppointmentReference) => reference.patientId === referral.patientId;
  const inconsistent = (referral.appointmentId !== null
    && (!references.current || references.current.id !== referral.appointmentId))
    || (references.current !== null && !samePatient(references.current))
    || (references.last !== null && !samePatient(references.last));
  if (visibility === "hidden" || inconsistent) {
    return {
      ...referral, appointmentId: null, appointmentDate: null, missedAppointment: null,
      appointmentVisibility: visibility === "hidden" ? "hidden" : "unknown",
    };
  }
  const readable = (reference: AppointmentReference | null) => reference !== null
    && samePatient(reference)
    && canReadAppointment(scope, { patientId: referral.patientId, doctorId: reference.doctorId });
  const currentReadable = readable(references.current);
  // Deleted-appointment audit fallback has no remaining provider evidence. It is
  // readable only when the existing policy allows every appointment for this patient.
  const lastReadable = references.last === null ? visibility === "all" : readable(references.last);
  return {
    ...referral,
    appointmentId: currentReadable ? referral.appointmentId : null,
    appointmentDate: currentReadable ? referral.appointmentDate : null,
    missedAppointment: lastReadable ? referral.missedAppointment : null,
    appointmentVisibility: visibility,
  };
}
