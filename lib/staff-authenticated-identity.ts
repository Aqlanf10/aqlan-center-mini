import "server-only";
import { getPool, type DbClient } from "./db";

export interface StaffIdentityClaims {
  realmId: string;
  subjectId: string;
  executionEpochId: string;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validStaffIdentity(
  value: unknown,
): value is StaffIdentityClaims {
  if (!value || typeof value !== "object") return false;
  const v = value as StaffIdentityClaims;
  return [v.realmId, v.subjectId, v.executionEpochId].every(
    (x) => typeof x === "string" && uuid.test(x),
  );
}
/** One snapshot, no provisioning. Absence leaves legacy login compatibility intact. */
export async function readStaffIdentityClaims(
  userId: number,
  client?: DbClient,
): Promise<StaffIdentityClaims | undefined> {
  const source = client ?? getPool();
  const schema = (
    await source.query<{
      ready: boolean;
    }>(`SELECT to_regclass('staff_authority_identity') IS NOT NULL
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='staff_subject_id') AS ready`)
  ).rows[0];
  if (!schema?.ready) return undefined;
  const row = (
    await source.query<{
      realm_id: string;
      staff_subject_id: string;
      execution_epoch_id: string;
    }>(
      "SELECT a.realm_id,u.staff_subject_id,a.execution_epoch_id FROM staff_authority_identity a CROSS JOIN users u WHERE a.singleton AND u.id=$1",
      [userId],
    )
  ).rows[0];
  return row
    ? {
        realmId: row.realm_id,
        subjectId: row.staff_subject_id,
        executionEpochId: row.execution_epoch_id,
      }
    : undefined;
}
export {
  bootstrapStaffIdentityInTransaction,
  rotateStaffExecutionEpochInTransaction,
} from "./staff-authority-lifecycle.mjs";
