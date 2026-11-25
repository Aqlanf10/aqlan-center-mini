import { createHash } from "node:crypto";
import type { DbClient } from "./db";

type Runner = Pick<DbClient, "query">;
type Revision = string;
type Adjustment = { id: number; case_id: number; revision: Revision };
type OrthoCase = { id: number; patient_id: number; responsible_doctor_id: number | null; status: string; revision: Revision };
type ClinicalBridge = { id: number; patient_id: number; responsible_party_id: number | null; specialty: string; status: string; revision: Revision };
type Doctor = { id: number; name: string; revision: Revision };

export type OrthoAdjustmentBookingContext =
  | { ok: true; patientId: number; caseId: number; adjustmentId: number; doctorId: number; doctorName: string; fingerprint: string }
  | { ok: false; code: "unavailable" | "responsibility_missing" };

const positiveId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
const missing = { ok: false, code: "unavailable" } as const;
const noDoctor = { ok: false, code: "responsibility_missing" } as const;

/**
 * Only the exact saved adjustment can identify this shortcut's case. Neither
 * the invoice doctor nor the previous performer is responsibility authority.
 * For lock=true, the booking transaction must hold its day lock first. Lock
 * the case before re-reading the adjustment and the unique clinical bridge; use
 * non-waiting locks so a concurrent clinical edit returns to review instead
 * of leaving day capacity locked. The case UPDATE lock also serializes a new bridge link.
 */
export async function readOrthoAdjustmentBookingContext(
  client: Runner, input: { patientId: number; caseId: number; adjustmentId: number; visitId?: number }, lock = false,
): Promise<OrthoAdjustmentBookingContext> {
  const { patientId, caseId, adjustmentId } = input;
  if (![patientId, caseId, adjustmentId].every(positiveId)) return missing;
  const { rows: [ortho] } = await client.query<OrthoCase>(`
    SELECT id, patient_id, responsible_doctor_id, status, xmin::text AS revision
    FROM ortho_cases WHERE id = $1 AND patient_id = $2${lock ? " FOR UPDATE NOWAIT" : ""}
  `, [caseId, patientId]);
  if (!ortho || !["active", "retention"].includes(ortho.status)) return missing;
  const visitConstraint = input.visitId === undefined ? "" : " AND visit_id = $3";
  const adjustmentParams = input.visitId === undefined ? [adjustmentId, caseId] : [adjustmentId, caseId, input.visitId];
  const { rows: [adjustment] } = await client.query<Adjustment>(`
    SELECT id, case_id, xmin::text AS revision
    FROM ortho_adjustments WHERE id = $1 AND case_id = $2${visitConstraint}${lock ? " FOR SHARE NOWAIT" : ""}
  `, adjustmentParams);
  if (!adjustment) return missing;

  let bridge: ClinicalBridge | undefined;
  if (ortho.responsible_doctor_id === null) {
    const { rows } = await client.query<ClinicalBridge>(`
      SELECT id, patient_id, responsible_party_id, specialty, status, xmin::text AS revision
      FROM clinical_cases WHERE ortho_case_id = $1 ORDER BY id${lock ? " FOR SHARE NOWAIT" : ""}
    `, [caseId]);
    if (rows.length > 1) return missing;
    bridge = rows[0];
    if (bridge && (bridge.patient_id !== patientId || bridge.specialty !== "orthodontics")) return missing;
  }
  const doctorId = ortho.responsible_doctor_id
    ?? (bridge && ["active", "waiting"].includes(bridge.status) ? bridge.responsible_party_id : null);
  if (!positiveId(doctorId)) return noDoctor;
  const { rows: [doctor] } = await client.query<Doctor>(`
    SELECT id, name, xmin::text AS revision
    FROM parties WHERE id = $1 AND kind = 'doctor' AND is_active${lock ? " FOR SHARE NOWAIT" : ""}
  `, [doctorId]);
  if (!doctor || !doctor.name.trim()) return noDoctor;

  // Bind the precise fact revisions to the displayed preview. An A→B→A
  // reassignment invalidates old UI confirmations without requiring a migration.
  const fingerprint = createHash("sha256").update(JSON.stringify([
    patientId, caseId, adjustmentId, ortho.revision, adjustment.revision,
    bridge?.id ?? null, bridge?.revision ?? null, doctor.id, doctor.revision,
  ])).digest("hex");
  return { ok: true, patientId, caseId, adjustmentId, doctorId: doctor.id, doctorName: doctor.name, fingerprint };
}
