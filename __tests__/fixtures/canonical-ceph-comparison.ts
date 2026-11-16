import type { Pool } from "pg";
import { seedCanonicalCeph } from "./canonical-ceph";

/** Saved synthetic facts; no image file or live tracing engine. */
export async function seedCanonicalCephComparison(q: Pick<Pool, "query">, patientId: number) {
  const before = await seedCanonicalCeph(q, { patientId, value: 4.125 });
  const after = await seedCanonicalCeph(q, { patientId, value: 2.25 });
  for (const [study, newer] of [[before, false], [after, true]] as const) {
    await q.query("UPDATE ceph_analyses SET xray_date=$1,created_at=$2,mm_per_pixel=$3,cal_x1=0,cal_y1=0,cal_x2=100,cal_y2=0,cal_mm=$5,ref_set='SYN historic norm not snapshotted' WHERE id=$4",
      [newer ? "2025-01-15" : "2024-01-15", newer ? "2024-01-01T12:00:00Z" : "2025-01-01T12:00:00Z", newer ? 0.2 : 0.1, study.id, newer ? 20 : 10]);
    await q.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'S',$2,50,'manual','SYN'),($1,'N',$3,50,'manual','SYN'),($1,'A',$4,100,'manual','SYN'),($1,'Me',$5,250,'manual','SYN'),($1,'SYN_OLD_POINT',3,4,'manual','SYN')", [study.id, newer ? 200 : 100, newer ? 300 : 200, newer ? 250 : 150, newer ? 280 : 180]);
    await q.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SYN_OLD_MEASURE',$2),($1,$3,7)", [study.id, newer ? 12.125 : 10.125, newer ? "SYN_ONLY_AFTER" : "SYN_ONLY_BEFORE"]);
  }
  return { before: before.id, after: after.id, document: before.documentId, patientId };
}
