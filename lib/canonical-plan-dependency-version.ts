import "server-only";
import { createHash } from "node:crypto";

/** Opaque comparison witness for this stored edge version, not a request receipt.
 * Exact PostgreSQL timestamp text and MVCC tuple identity distinguish a removed
 * and recreated edge, including within a single transaction. A physical rewrite
 * can invalidate the witness safely; the user must read again. */
export function planDependencyVersion(row: { itemId: number; requiresItemId: number; requirement: string; note: string | null; createdBy: string; createdAt: string; rowXmin: string; rowTid: string }): string {
  return createHash("sha256").update(JSON.stringify([row.itemId, row.requiresItemId, row.requirement, row.note, row.createdBy, row.createdAt, row.rowXmin, row.rowTid])).digest("hex");
}
