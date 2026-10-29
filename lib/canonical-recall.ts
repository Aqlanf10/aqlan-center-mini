import "server-only";
import {
  getPool, insertAuditRow, listLapsedPatientsWith, listMissedAppointmentsWith, listOpenPastAppointmentsWith,
  markAppointmentFollowedUpWith, markPatientRecalledWith, patientInDoctorScopeWith,
} from "./db";
import { LAPSE_OPTIONS } from "./recall";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

/**
 * Canonical recall (M2 slice 24): GET/POST /api/recall.
 *
 * Three lists of people to call — appointments that passed without being closed, missed
 * appointments, and lapsed patients — inside the actor's CURRENT patient scope (the
 * map's scope; `own` = the patient list's condition, applied in SQL before the limits,
 * so a clinician's list is never cut short by other doctors' rows). The legacy route
 * listed every patient to every admitted role.
 * - Read: the record read `read:recall`, one owning snapshot; `canRecord` =
 *   appointments.create (display only).
 * - Record a follow-up: one admitted `appointments.create` transaction (the map's
 *   requirement); the patient (of the appointment, or the patient itself) inside the
 *   scope (outside = missing, 404); the mark keeps the first follow-up time; the
 *   `recall.contact` audit row commits with it.
 */
export class CanonicalRecallRefusal extends Error {
  constructor(readonly code: "invalid_recall" | "recall_not_found" | "recall_conflict", readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "CanonicalRecallRefusal";
  }
}

export function recallWeeks(raw: string | null): number {
  const requested = Number(raw ?? 6);
  // A closed list, never the raw request: a huge number scans the whole table.
  return (LAPSE_OPTIONS as readonly number[]).includes(requested) ? requested : 6;
}

export async function readCanonicalRecall(session: VerifiedDurableSession, weeks: number) {
  return runCanonicalReadSnapshot(session, "read:recall", async (query, scope) => {
    const clinician = scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null;
    // One snapshot, read in order (a client runs one statement at a time).
    const openPast = await listOpenPastAppointmentsWith(query, clinician);
    const missed = await listMissedAppointmentsWith(query, clinician);
    const lapsed = await listLapsedPatientsWith(query, weeks, clinician);
    return { openPast, missed, lapsed, weeks, canRecord: scope.granted("appointments.create") };
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}

const NOT_FOUND = "السجل غير موجود ضمن مرضاك.";

export async function commandCanonicalRecallContact(session: VerifiedDurableSession, kind: unknown, rawId: unknown, pool = getPool()): Promise<{ ok: true }> {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new CanonicalRecallRefusal("invalid_recall", 400, "رقم غير صالح.");
  if (kind !== "missed" && kind !== "lapsed") throw new CanonicalRecallRefusal("invalid_recall", 400, "نوع غير معروف.");
  return withStaffOperation(pool, session, "appointments.create", async (client, handle) => {
    const scope = await staffOperationPatientScope(client, handle, "appointments.create");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const { rows: [row] } = kind === "missed"
      ? await client.query<{ patient_id: number }>("SELECT patient_id FROM appointments WHERE id = $1 FOR UPDATE", [id])
      : await client.query<{ patient_id: number }>("SELECT id AS patient_id FROM patients WHERE id = $1 FOR UPDATE", [id]);
    if (!row || (scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, row.patient_id))) {
      throw new CanonicalRecallRefusal("recall_not_found", 404, NOT_FOUND);
    }
    const done = kind === "missed" ? await markAppointmentFollowedUpWith(client, id) : await markPatientRecalledWith(client, id);
    if (!done) throw new CanonicalRecallRefusal("recall_conflict", 409, "السجل غير موجود أو تغيّرت حالته.");
    const identity = await staffOperationIdentity(client, handle, "appointments.create");
    // (TD-06) من تابع المريض ومتى — في المعاملة نفسها.
    await insertAuditRow(client, {
      action: "recall.contact", entity: kind === "missed" ? "appointment" : "patient", entityId: id,
      details: { النوع: kind === "missed" ? "موعد فائت" : "انقطاع" },
      actor: identity.username, actorRole: identity.role,
    });
    return { ok: true as const };
  });
}
