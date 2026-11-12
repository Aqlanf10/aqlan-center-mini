import "server-only";
import { createHash } from "node:crypto";
import type { CanonicalSnapshotQuery } from "./canonical-read-snapshot";
/** A saved native case observation; never a capability or a durable request receipt. */
export async function orthoLifecycleVersionWith(q: CanonicalSnapshotQuery, id: number): Promise<string | null> {
  const row=(await q.query("SELECT id::text,patient_id::text,status,xmin::text revision,ctid::text location FROM ortho_cases WHERE id=$1",[id])).rows[0];
  if(!row || !["active","retention"].includes(row.status))return null;
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}
