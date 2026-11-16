import type { CephReferenceSetRow } from "./db";

export const CEPH_REFERENCE_SET_LIMIT = 200;
export const CEPH_REFERENCE_VALUE_LIMIT = 256;
export interface CanonicalCephReferenceCatalog {
  projection: "ceph-reference-catalog";
  sets: CephReferenceSetRow[];
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const age = (value: unknown): value is number | null => value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Values are catalogue facts, never replacement values for a saved study. */
export function isCanonicalCephReferenceCatalog(value: unknown): value is CanonicalCephReferenceCatalog {
  if (!value || typeof value !== "object") return false;
  const body = value as CanonicalCephReferenceCatalog;
  if (body.projection !== "ceph-reference-catalog" || !Array.isArray(body.sets) || body.sets.length > CEPH_REFERENCE_SET_LIMIT) return false;
  const keys = new Set<string>();
  return body.sets.every(set => {
    if (!set || !text(set.key) || !text(set.name) || !text(set.version) || keys.has(set.key)) return false;
    keys.add(set.key);
    if (set.population !== null && typeof set.population !== "string") return false;
    if (!age(set.ageMin) || !age(set.ageMax) || set.ageMin !== null && set.ageMax !== null && set.ageMin > set.ageMax) return false;
    if (set.sex !== null && set.sex !== "female" && set.sex !== "male") return false;
    if (!set.values || typeof set.values !== "object" || Array.isArray(set.values)) return false;
    const entries = Object.entries(set.values);
    return entries.length <= CEPH_REFERENCE_VALUE_LIMIT && entries.every(([code, pair]) => text(code) && code.length <= 100 && pair
      && typeof pair.mean === "number" && Number.isFinite(pair.mean)
      && typeof pair.sd === "number" && Number.isFinite(pair.sd) && pair.sd > 0);
  });
}
