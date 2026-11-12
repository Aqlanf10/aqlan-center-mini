import "server-only";
import { createHash } from "node:crypto";
import type { CanonicalSnapshotQuery } from "./canonical-read-snapshot";

/** An opaque observation of the saved draft and its children, never authority or a request receipt. */
export async function cephDraftVersionWith(q: CanonicalSnapshotQuery, id: number, lockChildren = false): Promise<string | null> {
  const { rows: [study] } = await q.query("SELECT id::text,patient_id::text,status,xmin::text AS revision,ctid::text AS location FROM ceph_analyses WHERE id=$1", [id]);
  if (!study || study.status !== "draft") return null;
  const children = [];
  // Fixed server-owned identifiers. Parent UPDATE lock in writers fences new FK children.
  for (const [table, key, limit] of [["ceph_landmarks", "id", 256], ["ceph_measurements", "id", 256], ["ceph_diagnoses", "analysis_id", 1]] as const) {
    const count = Number((await q.query(`SELECT count(*)::text n FROM ${table} WHERE analysis_id=$1`, [id])).rows[0].n);
    if (!Number.isSafeInteger(count) || count > limit) throw new Error("CEPH_DRAFT_VERSION_LIMIT");
    children.push((await q.query(`SELECT ${key}::text AS id,xmin::text AS revision,ctid::text AS location FROM ${table} WHERE analysis_id=$1 ORDER BY ${key}${lockChildren ? " FOR SHARE NOWAIT" : ""}`, [id])).rows);
  }
  return createHash("sha256").update(JSON.stringify([study, ...children])).digest("hex");
}
