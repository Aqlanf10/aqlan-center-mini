/** Browser-safe: the source identity a draft completion is bound to, and its exact parser (no hashing here). */
import { CEPH_ENGINE_ID } from "./engine-identity";

/** What the clinician's screen was showing when "complete" was pressed; compared with the server's capture. */
export interface CephSourceIdentity {
  readonly schemaVersion: 1;
  readonly documentId: number;
  readonly imageSha256: string;
  readonly referenceSetKey: string;
  /** Hash of the reference snapshot, or null when the selected set is not an active stored set (built-in fallback). */
  readonly referenceSetSha256: string | null;
  readonly engineId: typeof CEPH_ENGINE_ID;
  readonly engineVersion: string;
  readonly engineSourceSha256: string;
}


const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const posId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const sha = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 4000;
const keys = (x: Record<string, unknown>, names: readonly string[]) => Object.keys(x).length === names.length && names.every((k) => Object.hasOwn(x, k));

export function parseCephSourceIdentity(value: unknown): CephSourceIdentity | null {
  if (!obj(value) || !keys(value, ["schemaVersion", "documentId", "imageSha256", "referenceSetKey", "referenceSetSha256", "engineId", "engineVersion", "engineSourceSha256"])
    || value.schemaVersion !== 1 || !posId(value.documentId) || !sha(value.imageSha256)
    || typeof value.referenceSetKey !== "string" || !value.referenceSetKey.trim() || value.referenceSetKey.length > 200
    || !(value.referenceSetSha256 === null || sha(value.referenceSetSha256)) || value.engineId !== CEPH_ENGINE_ID
    || !str(value.engineVersion) || value.engineVersion.length > 200 || !sha(value.engineSourceSha256)) return null;
  return { schemaVersion: 1, documentId: value.documentId, imageSha256: value.imageSha256, referenceSetKey: value.referenceSetKey,
    referenceSetSha256: value.referenceSetSha256, engineId: CEPH_ENGINE_ID, engineVersion: value.engineVersion, engineSourceSha256: value.engineSourceSha256 };
}

