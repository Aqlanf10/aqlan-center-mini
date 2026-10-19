import type { SessionPayload } from "./auth";
import { ensureSchema, getPool } from "./db";
import { canAccessPatient } from "./patient-access";

/** Resolve only ownership before loading clinical data for a Ceph page. */
export async function getAccessibleCephPatientId(session: SessionPayload, id: number): Promise<number | null> {
  await ensureSchema();
  const { rows } = await getPool().query<{ patient_id: number }>(
    `SELECT patient_id FROM ceph_analyses WHERE id = $1 AND status <> 'discarded'`,
    [id],
  );
  const patientId = rows[0]?.patient_id;
  if (!patientId || !(await canAccessPatient(session, patientId, "canViewXrays").catch(() => false))) return null;
  return patientId;
}
