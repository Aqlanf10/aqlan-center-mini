import { isKnownZone } from './clinicZone';
import { readClinicalRosterSources } from './doctor-clinical-roster';
import { doctorBookingDay, type DoctorBookingDay } from './doctor-booking-window';
import type { DbClient } from './db';

function validAdvisoryInput(doctorId: number, date: string, zone: string): boolean {
  const epoch = Date.parse(`${date}T00:00:00Z`);
  return Number.isSafeInteger(doctorId) && doctorId > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === date
    && date > '0001-01-01' && date < '9999-12-31' && isKnownZone(zone);
}

/** Caller owns the REPEATABLE READ READ ONLY snapshot (canonical read snapshot). */
export async function readDoctorAvailabilityAdvisoryWith(
  q: Pick<DbClient, 'query'>, doctorId: number, date: string, zone: string,
) {
  const envelope = (day: DoctorBookingDay) => ({
    purpose: 'advisory_only' as const, bookingGuaranteed: false as const,
    doctorId, date, timeZone: zone, ...day,
  });
  if (!validAdvisoryInput(doctorId, date, zone)) {
    return envelope({ resolved: false, reason: 'invalid_request', windows: [] });
  }
  const sources = await readClinicalRosterSources(q, doctorId, date);
  const day = sources ? doctorBookingDay(sources, doctorId, date, zone)
    : { resolved: false, reason: 'schema_unavailable', windows: [] };
  return envelope(day);
}

/** Internal display-only reader. Caller must authorize doctor scope before use.
 * This snapshot excludes appointment occupancy/capacity and is never admission
 * authority. No source identifiers, leave reasons or HR financial data escape.
 */
export async function readDoctorAvailabilityAdvisory(doctorId: number, date: string, zone: string) {
  const envelope = (day: DoctorBookingDay) => ({
    purpose: 'advisory_only' as const, bookingGuaranteed: false as const,
    doctorId, date, timeZone: zone, ...day,
  });
  if (!validAdvisoryInput(doctorId, date, zone)) {
    return envelope({ resolved: false, reason: 'invalid_request', windows: [] });
  }
  const { getPool } = await import('./db');
  const client = await getPool().connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // One source snapshot contains both anchor days; no separate day transactions.
    const sources = await readClinicalRosterSources(client, doctorId, date);
    const day = sources ? doctorBookingDay(sources, doctorId, date, zone)
      : { resolved: false, reason: 'schema_unavailable', windows: [] };
    await client.query('COMMIT');
    return envelope(day);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
