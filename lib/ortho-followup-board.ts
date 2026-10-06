import {
  selectFollowupBookings, type ClassifiedFollowupBooking, type FollowupBookingFacts, type FollowupTarget,
} from "./ortho-followup-booking-context";
import type { FollowupBookingContext, NextAppointmentInfo } from "./ortho-followup";

/** All fields come from server-side joins; none are accepted from a write request. */
export interface ProjectedFollowupBooking extends FollowupBookingFacts {
  serviceName: string | null;
  doctorName: string | null;
}

/** Keep the complete selection available to reception without exposing raw links. */
export function projectFollowupBookings(input: {
  target: FollowupTarget;
  today: string;
  appointments: readonly ProjectedFollowupBooking[];
}): { nextAppointment: NextAppointmentInfo | null; bookingContext: FollowupBookingContext } {
  if (!Array.isArray(input.appointments)) throw new TypeError("Booking projection is required");
  const selected = selectFollowupBookings(input);
  const facts = new Map(input.appointments.map((appointment) => [appointment.id, appointment]));
  const view = (row: ClassifiedFollowupBooking): NextAppointmentInfo => {
    const detail = facts.get(row.appointment.id);
    return {
      id: row.appointment.id, date: row.appointment.scheduledDate, time: row.appointment.scheduledTime,
      status: row.appointment.status, serviceName: detail?.serviceName ?? null,
      doctorName: detail?.doctorName ?? null, appointmentType: detail?.appointmentType ?? null,
      matchBasis: row.basis, reason: row.reason,
    };
  };
  return {
    nextAppointment: selected.nextAppointment ? view(selected.nextAppointment) : null,
    bookingContext: {
      verified: true,
      pastUnresolvedAppointment: selected.pastUnresolvedAppointment ? view(selected.pastUnresolvedAppointment) : null,
      reviewAppointments: selected.reviewAppointments.map(view),
      otherAppointments: selected.otherAppointments.map(view),
    },
  };
}
