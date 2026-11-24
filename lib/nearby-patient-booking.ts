import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DbClient } from "./db";

/** Deliberately no patient name, phone, clinical note, or other patient's data. */
export interface NearbyPatientAppointment {
  id: number;
  scheduledDate: string;
  scheduledTime: string;
  doctorName: string | null;
}
export interface NearbyBookingProposal {
  actor: string;
  scope: string;
  patientId: number;
  date: string;
  time: string;
  durationMinutes: number;
  serviceId: number | null;
  doctorId: number | null;
  chairNo: number | null;
  excludeId: number | null;
}
const volatileSecret = randomBytes(32).toString("hex");
const secret = () => {
  const configured = process.env.SESSION_SECRET;
  return configured && configured.length >= 32 ? configured : volatileSecret;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sign = (payload: string) => createHmac("sha256", secret()).update(`nearby-patient-booking:v1:${payload}`).digest("base64url");
const MAX_AGE_MS = 10 * 60 * 1000;

export function nearbyConfirmationToken(proposal: NearbyBookingProposal, snapshot: unknown, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, fingerprint: digest([proposal, snapshot]), expires: now + MAX_AGE_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function acceptsNearbyConfirmation(token: unknown, proposal: NearbyBookingProposal, snapshot: unknown, now = Date.now()): boolean {
  if (!proposal.actor || typeof token !== "string" || token.length > 4096) return false;
  const pieces = token.split(".");
  if (pieces.length !== 2) return false;
  const [payload, signature] = pieces;
  const expected = Buffer.from(sign(payload));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.v === 1 && Number.isSafeInteger(parsed.expires)
      && parsed.expires > now && parsed.expires <= now + MAX_AGE_MS
      && parsed.fingerprint === digest([proposal, snapshot]);
  } catch { return false; }
}

/** Must run under the existing sorted D..D+2 day transaction locks. */
export async function nearbyPatientBookingWarning(client: DbClient, proposal: NearbyBookingProposal, confirmation?: string | null) {
  const { rows } = await client.query<NearbyPatientAppointment & { status: string; durationMinutes: number; doctorId: number | null }>(
    `SELECT a.id, to_char(a.scheduled_date, 'YYYY-MM-DD') AS "scheduledDate",
       to_char(a.scheduled_time, 'HH24:MI') AS "scheduledTime", doc.name AS "doctorName",
       a.status, a.duration_minutes AS "durationMinutes", a.doctor_id AS "doctorId"
     FROM appointments a LEFT JOIN parties doc ON doc.id = a.doctor_id
     WHERE a.patient_id = $1 AND a.scheduled_date BETWEEN $2::date AND $2::date + 2
       AND a.status IN ('booked', 'arrived') AND ($3::int IS NULL OR a.id <> $3)
     ORDER BY a.scheduled_date, a.scheduled_time, a.id`,
    [proposal.patientId, proposal.date, proposal.excludeId],
  );
  if (!rows.length || acceptsNearbyConfirmation(confirmation, proposal, rows)) return null;
  return {
    kind: "nearby_patient_appointments" as const,
    nearbyAppointments: rows.map(({ id, scheduledDate, scheduledTime, doctorName }) => ({ id, scheduledDate, scheduledTime, doctorName })),
    confirmationToken: nearbyConfirmationToken(proposal, rows),
  };
}
