/** Clinical reason for booking, independent of attendance and treatment stage.
 * Old rows remain unclassified; neither a service name nor patient history is evidence. */
export const APPOINTMENT_CATEGORY_LABEL = {
  orthodontics: 'تقويم', new_orthodontic_patient: 'مريض تقويم جديد',
  endodontics: 'علاج عصب', filling: 'حشوة', prosthetics: 'تركيبات',
  awaiting_prosthetics: 'بانتظار التركيبات', other: 'أخرى',
} as const;
export type AppointmentCategory = keyof typeof APPOINTMENT_CATEGORY_LABEL;
export const isAppointmentCategory = (value: unknown): value is AppointmentCategory =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(APPOINTMENT_CATEGORY_LABEL, value);
