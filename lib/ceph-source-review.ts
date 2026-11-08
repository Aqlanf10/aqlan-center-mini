import type { CephReferenceSnapshot } from "./ceph-completion-provenance";

export interface CephSourceIdentity {
  schemaVersion: 1;
  documentId: number;
  imageSha256: string;
  referenceSetKey: string;
  referenceSetSha256: string;
  engineVersion: string;
  engineSourceSha256: string;
}
export type CephCompletionSources =
  | { state: "available"; identity: CephSourceIdentity; referenceSet: CephReferenceSnapshot }
  | { state: "unavailable"; reason: string };
const keys = ["schemaVersion", "documentId", "imageSha256", "referenceSetKey", "referenceSetSha256", "engineVersion", "engineSourceSha256"] as const;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** Exact bounded payload, with no coercion or mutable registry dependencies. */
export function parseCephSourceIdentity(value: unknown): CephSourceIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))
    || row.schemaVersion !== 1 || typeof row.documentId !== "number" || !Number.isSafeInteger(row.documentId) || row.documentId <= 0
    || !hash(row.imageSha256) || !hash(row.referenceSetSha256) || !hash(row.engineSourceSha256)
    || typeof row.referenceSetKey !== "string" || !row.referenceSetKey.trim() || row.referenceSetKey.length > 200
    || typeof row.engineVersion !== "string" || !row.engineVersion.trim() || row.engineVersion.length > 200) return null;
  return { schemaVersion: 1, documentId: row.documentId, imageSha256: row.imageSha256,
    referenceSetKey: row.referenceSetKey, referenceSetSha256: row.referenceSetSha256,
    engineVersion: row.engineVersion, engineSourceSha256: row.engineSourceSha256 };
}
export function sameCephSourceIdentity(left: unknown, right: unknown): boolean {
  const a = parseCephSourceIdentity(left), b = parseCephSourceIdentity(right);
  return !!a && !!b && keys.every(key => a[key] === b[key]);
}
