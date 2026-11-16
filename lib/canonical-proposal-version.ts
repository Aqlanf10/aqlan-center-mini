import { createHash } from "node:crypto";
/** Observation only, not a durable command receipt or a hash of patient content. */
export function proposalContactVersion(row: { planId: number; planXmin: string; planTid: string; contactCount: string; contactId: string | null; contactEpoch: string | null }): string {
  return createHash("sha256").update(JSON.stringify(["proposal-contact-v1", row.planId, row.planXmin, row.planTid, row.contactCount, row.contactId, row.contactEpoch])).digest("hex");
}
