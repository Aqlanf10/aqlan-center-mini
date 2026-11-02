import { describe, expect, it } from 'vitest';
import { fingerprintDirectAppointmentIntent, normalizeDirectAppointmentIntent } from '../lib/appointment-purpose-command';

const intent = {
  patientId: 19, date: '2030-01-15', time: '16:00', durationMinutes: null,
  serviceId: null, appointmentType: 'consultation', note: 'synthetic note',
  doctorId: null, chairNo: null, overrideReason: null, isNewPatient: false,
  appointmentPurpose: 'consultation' as const, bookingIntent: null,
};

describe('direct purpose booking command fingerprint', () => {
  it('is canonical for equivalent normalized intent, not changing service defaults', () => {
    const expected = fingerprintDirectAppointmentIntent(intent);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDirectAppointmentIntent({ ...intent, note: ' synthetic note ',
      durationMinutes: undefined })).toBe(expected);
    expect(fingerprintDirectAppointmentIntent({ ...intent, note: 'synthetic note',
      durationMinutes: null })).toBe(expected);
    expect(normalizeDirectAppointmentIntent({ ...intent, note: ' synthetic note ' }).note)
      .toBe('synthetic note');
  });

  it('binds the patient, slot, explicit choice, and purpose independently', () => {
    const expected = fingerprintDirectAppointmentIntent(intent);
    for (const changed of [
      { patientId: 20 }, { date: '2030-01-16' }, { time: '16:30' },
      { durationMinutes: 30 }, { serviceId: 7 }, { doctorId: 8 },
      { isNewPatient: true }, { appointmentPurpose: 'start_treatment' as const },
    ]) expect(fingerprintDirectAppointmentIntent({ ...intent, ...changed })).not.toBe(expected);
  });

  it('rejects noncanonical numeric IDs instead of rounding or accepting exponent strings', () => {
    expect(() => fingerprintDirectAppointmentIntent({ ...intent, patientId: 1.5 })).toThrow();
    expect(() => fingerprintDirectAppointmentIntent({ ...intent, patientId: '1e2' as unknown as number })).toThrow();
    expect(() => fingerprintDirectAppointmentIntent({ ...intent, doctorId: 1.2 })).toThrow();
    expect(() => fingerprintDirectAppointmentIntent({ ...intent, serviceId: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => fingerprintDirectAppointmentIntent({ ...intent,
      isNewPatient: 'false' as unknown as boolean })).toThrow();
    expect(() => fingerprintDirectAppointmentIntent({ ...intent, waitingListId: 9 })).toThrow();
    expect(() => fingerprintDirectAppointmentIntent({ ...intent, date: '2030-02-31' })).toThrow();
  });
});
