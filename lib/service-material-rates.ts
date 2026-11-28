import { commissionTimeKey } from "./commission-time";
import { FULL_RATE_BP } from "./materialRate";

export type ServiceMaterialRateEvent = { effectiveFrom: bigint; rateBp: number | null };
export type ServiceMaterialRateTimeline = ReadonlyMap<number, readonly ServiceMaterialRateEvent[]>;

/** null means use the category rate; a recorded zero is an explicit exemption. */
export function serviceMaterialRateAsOf(
  history: ServiceMaterialRateTimeline,
  serviceId: number,
  atIso: string,
): number | null {
  const entries = history.get(serviceId);
  if (!entries?.length) return null;
  const at = commissionTimeKey(atIso);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].effectiveFrom <= at) return entries[i].rateBp;
  }
  return null;
}

export function parseServiceMaterialRateChange(input: unknown): {
  serviceId: number; rateBp: number | null; revision: string | null; reason: string;
} | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { serviceId, rateBp, revision, reason } = input as Record<string, unknown>;
  if (typeof serviceId !== "number" || !Number.isSafeInteger(serviceId) || serviceId <= 0 || serviceId > 2147483647) return null;
  if (rateBp !== null && (typeof rateBp !== "number" || !Number.isInteger(rateBp) || rateBp < 0 || rateBp > FULL_RATE_BP)) return null;
  if (revision !== null && (typeof revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(revision))) return null;
  const changeReason = typeof reason === "string" ? reason.trim() : "";
  if (changeReason.length < 3 || changeReason.length > 300) return null;
  return { serviceId, rateBp, revision, reason: changeReason };
}
