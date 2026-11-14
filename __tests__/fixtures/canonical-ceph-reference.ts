import type { Pool } from "pg";

/** Synthetic catalogue in an owned test database only. No patient data. */
export async function seedCanonicalCephReferences(q: Pick<Pool, "query">) {
  await q.query("UPDATE ceph_reference_sets SET active=FALSE");
  const { rows: [set] } = await q.query<{ id: string }>(`INSERT INTO ceph_reference_sets
    (key,name,population,age_min,age_max,sex,version,created_by)
    VALUES('SYN-reference','مرجع تجريبي حالي','مجموعة اصطناعية',10,18,'female','SYN-v2','SYN private author') RETURNING id::text`);
  await q.query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,'ANB',2.125,1.75),($1,'SYN_OLD_CODE',123.123456,0.125)", [set.id]);
  await q.query("INSERT INTO ceph_reference_sets(key,name,version,active,created_by) VALUES('SYN-inactive','SYN hidden inactive reference','SYN-old',FALSE,'SYN')");
  return set.id;
}
