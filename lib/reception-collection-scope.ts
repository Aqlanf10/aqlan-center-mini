import type { DbClient } from "./db";

type Reader = Pick<DbClient, "query">;
export const COLLECTION_SCOPE_MESSAGE = "يتطلب التحصيل زيارة أو موعدًا للمريض اليوم، أو تكليفًا من الإدارة.";
export class CollectionScopeDenied extends Error {
  constructor() { super(COLLECTION_SCOPE_MESSAGE); }
}

/** The assignment writer locks the same patient FOR UPDATE before appending its decision. */
export async function receptionCollectionAllowed(db: Reader, patientId: number, username: string, timeZone: string, lock = false) {
  if (!Number.isSafeInteger(patientId) || patientId < 1 || !username) return false;
  if (lock) await db.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [patientId]);
  const share = lock ? "FOR SHARE" : "";
  const { rows } = await db.query<{ allowed: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM patients p JOIN users u ON u.username=$2 AND u.role='reception' AND u.is_active
    WHERE p.id=$1 AND (
      EXISTS (SELECT 1 FROM visits v WHERE v.patient_id=p.id AND v.status <> 'cancelled'
        AND (v.arrived_at AT TIME ZONE $3)::date=(statement_timestamp() AT TIME ZONE $3)::date ${share})
      OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id=p.id AND a.status IN ('booked','arrived','done')
        AND a.scheduled_date=(statement_timestamp() AT TIME ZONE $3)::date ${share})
      OR (SELECT log.action='collection.assign' FROM audit_log log
          WHERE log.entity='patient' AND log.entity_id=p.id::text AND log.actor_role='admin'
            AND log.action IN ('collection.assign','collection.revoke') AND log.details->>'collectorId'=u.id::text
            AND log.details->>'patientNumber'=p.patient_number AND log.created_at>=GREATEST(p.created_at,u.created_at)
          ORDER BY log.id DESC LIMIT 1)
    ) ${lock ? "FOR SHARE OF u" : ""}
  ) AS allowed`, [patientId, username, timeZone]);
  return rows[0]?.allowed === true;
}

export async function requireCollectionScope(db: Reader, role: string | null | undefined, patientId: number, username: string, timeZone: string) {
  if (role === "reception" && !await receptionCollectionAllowed(db, patientId, username, timeZone, true)) throw new CollectionScopeDenied();
}
