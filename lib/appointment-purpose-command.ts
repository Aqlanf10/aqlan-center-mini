import { createHash } from 'node:crypto';

/** Values explicitly requested by the user, never mutable catalogue/default
 * values. The receipt owner is compared separately, not hidden in this hash. */
export interface DirectAppointmentIntent {
  patientId: number;
  date: string;
  time: string;
  durationMinutes?: number | null;
  serviceId?: number | null;
  appointmentType?: string | null;
  note?: string | null;
  doctorId?: number | null;
  chairNo?: number | null;
  overrideReason?: string | null;
  isNewPatient?: boolean;
  appointmentPurpose: 'consultation' | 'start_treatment';
  bookingIntent?: 'ortho_follow_up' | null;
  /** Waiting-list conversion has its own recovery identity; never hide it in
   * a direct-purpose command that does not bind that row. */
  waitingListId?: number | null;
}

export type NormalizedDirectAppointmentIntent = Required<Omit<DirectAppointmentIntent, 'waitingListId'>>;

const optionalId = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('APPOINTMENT_COMMAND_INVALID_ID');
  return value;
};
const requiredId = (value: unknown): number => {
  const parsed = optionalId(value);
  if (parsed === null) throw new Error('APPOINTMENT_COMMAND_INVALID_ID');
  return parsed;
};
const optionalText = (value: unknown, length: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('APPOINTMENT_COMMAND_INVALID_TEXT');
  return value.trim().slice(0, length) || null;
};

/** A versioned, fixed-field projection. Object property order, omitted/null
 * optional fields, and display-only whitespace cannot change replay identity.
 * A new interpretation requires a new version, never an unreviewed rehash. */
export function normalizeDirectAppointmentIntent(input: DirectAppointmentIntent): NormalizedDirectAppointmentIntent {
  if (input.appointmentPurpose !== 'consultation' && input.appointmentPurpose !== 'start_treatment')
    throw new Error('APPOINTMENT_COMMAND_INVALID_PURPOSE');
  if (input.waitingListId !== null && input.waitingListId !== undefined)
    throw new Error('APPOINTMENT_COMMAND_WAITING_LIST_UNSUPPORTED');
  if (input.isNewPatient !== undefined && typeof input.isNewPatient !== 'boolean')
    throw new Error('APPOINTMENT_COMMAND_INVALID_NEW_PATIENT');
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date))
    throw new Error('APPOINTMENT_COMMAND_INVALID_DATE');
  const [year, month, day] = input.date.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1])
    throw new Error('APPOINTMENT_COMMAND_INVALID_DATE');
  const time = typeof input.time === 'string' ? /^(\d{1,2}):([0-5]\d)$/.exec(input.time) : null;
  if (!time || Number(time[1]) > 23) throw new Error('APPOINTMENT_COMMAND_INVALID_TIME');
  const duration = input.durationMinutes === null || input.durationMinutes === undefined
    ? null : input.durationMinutes;
  if (duration !== null && (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0))
    throw new Error('APPOINTMENT_COMMAND_INVALID_DURATION');
  // The ortho follow-up shortcut has its own service/plan validation. It is
  // not a direct consultation/start command and cannot bypass that boundary.
  if (input.bookingIntent !== null && input.bookingIntent !== undefined)
    throw new Error('APPOINTMENT_COMMAND_INVALID_INTENT');
  return {
    patientId: requiredId(input.patientId), date: input.date,
    time: `${time[1].padStart(2, '0')}:${time[2]}`,
    durationMinutes: duration, serviceId: optionalId(input.serviceId),
    appointmentType: optionalText(input.appointmentType, 60),
    note: optionalText(input.note, 300), doctorId: optionalId(input.doctorId),
    chairNo: optionalId(input.chairNo), overrideReason: optionalText(input.overrideReason, 300),
    isNewPatient: input.isNewPatient === true, appointmentPurpose: input.appointmentPurpose,
    bookingIntent: input.bookingIntent ?? null,
  };
}

export function fingerprintDirectAppointmentIntent(input: DirectAppointmentIntent): string {
  const intent = normalizeDirectAppointmentIntent(input);
  const canonical = [
    1, intent.patientId, intent.date, intent.time, intent.durationMinutes,
    intent.serviceId, intent.appointmentType, intent.note, intent.doctorId, intent.chairNo,
    intent.overrideReason, intent.isNewPatient, intent.appointmentPurpose, intent.bookingIntent,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Only canonical RFC 4122 UUID text is accepted at the new direct boundary.
 * The JS client uses crypto.randomUUID; legacy callers do not provide this. */
export const isDirectAppointmentCommandId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
