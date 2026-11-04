import "server-only";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  CEPH_REFERENCE_SET_LIMIT, CEPH_REFERENCE_VALUE_LIMIT, isCanonicalCephReferenceCatalog,
  type CanonicalCephReferenceCatalog,
} from "./canonical-ceph-reference-projection";

const MAX_BYTES = 2 * 1024 * 1024;
export class CanonicalCephReferenceRefusal extends Error {
  constructor(readonly code: "ceph_reference_limit" | "ceph_reference_invalid", message: string) {
    super(message);
    this.name = "CanonicalCephReferenceRefusal";
  }
}

/** The non-patient catalogue needs its own imaging grant. It grants no patient scope. */
export async function readCephReferencesWith(q: CanonicalSnapshotQuery): Promise<CanonicalCephReferenceCatalog> {
  const { rows: [budget] } = await q.query<{ sets: string; max_values: string; bytes: string }>(`SELECT
    (SELECT count(*)::text FROM ceph_reference_sets WHERE active=TRUE) AS sets,
    COALESCE((SELECT max(n)::text FROM (SELECT count(*) AS n FROM ceph_reference_values v
      JOIN ceph_reference_sets s ON s.id=v.set_id WHERE s.active=TRUE GROUP BY v.set_id) counted),'0') AS max_values,
    (COALESCE((SELECT sum(octet_length(to_jsonb(s)::text)) FROM ceph_reference_sets s WHERE s.active=TRUE),0)
      +COALESCE((SELECT sum(octet_length(to_jsonb(v)::text)) FROM ceph_reference_values v
        JOIN ceph_reference_sets s ON s.id=v.set_id WHERE s.active=TRUE),0))::text AS bytes`);
  if (!budget || Number(budget.sets) > CEPH_REFERENCE_SET_LIMIT || Number(budget.max_values) > CEPH_REFERENCE_VALUE_LIMIT || Number(budget.bytes) > MAX_BYTES) {
    throw new CanonicalCephReferenceRefusal("ceph_reference_limit", "المجموعات المرجعية تتجاوز حد القراءة الآمنة؛ لم تُختصر قيمها.");
  }
  const { rows: sets } = await q.query<{
    id: string; key: string; name: string; population: string | null; age_min: number | null;
    age_max: number | null; sex: "male" | "female" | null; version: string;
  }>("SELECT id::text,key,name,population,age_min,age_max,sex,version FROM ceph_reference_sets WHERE active=TRUE ORDER BY id");
  const { rows: values } = await q.query<{ set_id: string; code: string; mean: number; sd: number }>(`SELECT v.set_id::text,v.code,v.mean,v.sd
    FROM ceph_reference_values v JOIN ceph_reference_sets s ON s.id=v.set_id WHERE s.active=TRUE ORDER BY v.set_id,v.id`);
  const body: CanonicalCephReferenceCatalog = {
    projection: "ceph-reference-catalog",
    sets: sets.map(set => ({ key: set.key, name: set.name, population: set.population, ageMin: set.age_min, ageMax: set.age_max,
      sex: set.sex, version: set.version,
      values: Object.fromEntries(values.filter(value => value.set_id === set.id).map(value => [value.code, { mean: value.mean, sd: value.sd }])),
    })),
  };
  if (!isCanonicalCephReferenceCatalog(body)) throw new CanonicalCephReferenceRefusal("ceph_reference_invalid", "تعذّر التحقق من المراجع المحفوظة؛ لم تُستبدل بقيم افتراضية.");
  return body;
}

export function readCanonicalCephReferences(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(session, "clinical.xrays.view", readCephReferencesWith, { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}
