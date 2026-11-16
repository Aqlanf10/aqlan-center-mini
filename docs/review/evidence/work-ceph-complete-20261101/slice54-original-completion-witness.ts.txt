import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
beforeAll(async () => { await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema(); }, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });
async function scenario(key: string, degenerate: boolean) {
  const q = db.getPool();
  const patient = (await q.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$1) RETURNING id", [`SYN-CEPH-COMPLETE-${key}`])).rows[0].id;
  const document = (await q.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'imaging','SYN image','image/png',1,$2,$3,'SYN') RETURNING id", [patient, "a".repeat(64), `SYN/${key}.png`])).rows[0].id;
  const id = (await q.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel) VALUES($1,$2,'draft','SYN',0,0,100,0,50,0.5) RETURNING id", [patient, document])).rows[0].id;
  for (const [i, code] of REQUIRED_LANDMARKS.entries()) await q.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,'manual','SYN')", [id, code, degenerate ? 1 : 40 + (i * 37) % 400, degenerate ? 1 : 30 + (i * 53) % 380]);
  await q.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'ANB',99)", [id]); return id;
}
it("baseline legitimate geometry completes and refreshes its current known measurement", async () => {
  const id = await scenario("valid", false), result = await db.completeCephAnalysis(id, "SYN examiner"); expect(result.ok).toBe(true);
  expect((await db.getPool().query("SELECT value FROM ceph_measurements WHERE analysis_id=$1 AND code='ANB'", [id])).rows[0].value).not.toBe(99);
});
it("must not present a retained measurement as approved when current geometry cannot compute it", async () => {
  const id = await scenario("degenerate", true), result = await db.completeCephAnalysis(id, "SYN examiner");
  const row = (await db.getPool().query("SELECT a.status,m.value FROM ceph_analyses a JOIN ceph_measurements m ON m.analysis_id=a.id AND m.code='ANB' WHERE a.id=$1", [id])).rows[0];
  expect({ ok: result.ok, status: row.status, storedANB: row.value, currentANB: result.measurements?.find(m => m.code === "ANB")?.value ?? null }).not.toEqual({ ok: true, status: "completed", storedANB: 99, currentANB: null });
});
