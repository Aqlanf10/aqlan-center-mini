/** Synthetic persisted strategy rows, only in disposable test databases. */
import { randomUUID } from "node:crypto";
import type { DbClient } from "../../lib/db";
import type { StrategyRevision } from "../../lib/ortho-treatment-strategy";
export async function seedCanonicalStrategy(q: Pick<DbClient, "query">, input: {
  patientId: number; caseId: number; bridgeId: number; actorId: number; problemId: number;
  version?: number; previous?: number | null; reason?: string; rows?: StrategyRevision["rows"]; createdAt?: string;
}) {
  const rows = input.rows ?? [{ problem: { id: input.problemId, label: "SYN saved problem", site: "upper" },
    objective: "SYN saved objective", strategy: "SYN saved strategy", rationale: "SYN clinical rationale", planItems: [] }];
  const row = (await q.query<{ id: number }>(`INSERT INTO ortho_strategy_revisions
    (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,rows,created_at)
    VALUES($1,$1,$2,$3,1,$4,$5,$6,'SYN strategy recorder',$7,'retrospective',$8,$9,$10::jsonb,COALESCE($11::timestamptz,NOW())) RETURNING id`,
  [input.patientId,input.caseId,input.bridgeId,input.version??1,input.previous??null,input.actorId,input.reason??"SYN saved reason",randomUUID(),"a".repeat(64),JSON.stringify(rows),input.createdAt??null])).rows[0];
  return { id: row.id, rows };
}
