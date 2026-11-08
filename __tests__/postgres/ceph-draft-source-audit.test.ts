import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ceph_draft_source_audit");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { PATCH } = await import("../../app/api/ceph/[id]/route");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actorId: number, expiry: number, serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-ceph-draft");
  [{ id: actorId }] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-ceph-draft','Synthetic ceph author',$1,'admin') RETURNING id", [hash]);
  expiry = Date.now() + 3_600_000;
  context.token = auth.createSessionToken({ userId: actorId, username: "synthetic-ceph-draft", role: "admin", expiresAt: expiry, credentialVersion: auth.sessionCredentialVersion(hash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });
const commands = {
  calibration: { calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, expectedCalibration: { calibration: null, mmPerPixel: null } },
  landmarks: { landmarks: [{ code: "S", x: 20, y: 30, source: "manual" }], expectedLandmarks: [] },
  diagnosis: { diagnosis: { finalDx: "Synthetic reviewed documentary text" }, expectedDiagnosis: null },
};
async function fixture() {
  const [{ id: patientId }] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic ceph patient') RETURNING id", [`CEPH-AUTH-${++serial}`]);
  const [{ id: documentId }] = await q(`INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES($1,'imaging','Synthetic image','image/jpeg',123,$2,$3,'synthetic-ceph-draft') RETURNING id`, [patientId, "a".repeat(64), `synthetic/no-file-${serial}.jpg`]);
  const created = await db.createCephAnalysis({ patientId, documentId, createdBy: "synthetic-ceph-draft" });
  if (!created.ok) throw new Error(created.message);
  const send = (kind: keyof typeof commands) => PATCH(new Request(`https://synthetic.invalid/api/ceph/${created.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commands[kind]) }), { params: Promise.resolve({ id: String(created.id) }) });
  return { patientId, documentId, id: created.id, send };
}
describe("observed draft source identity boundary", () => {
  it.each(["calibration", "landmarks"] as const)("records current behavior when metadata changes after viewing: %s", async kind => {
    const f=await fixture();
    await q("UPDATE patient_documents SET width=1200,height=800 WHERE id=$1",[f.documentId]);
    const viewed=await db.getCephStudy(f.id);
    expect(viewed?.completionSources?.state).toBe("available");
    // Controlled direct SQL represents restore/out-of-band metadata replacement,
    // not an ordinary supported document editing workflow. No file is touched.
    await q("UPDATE patient_documents SET sha256=$2,width=600,height=400 WHERE id=$1",[f.documentId,"b".repeat(64)]);
    const reopened=await db.getCephStudy(f.id);
    expect(reopened?.completionSources).not.toEqual(viewed?.completionSources);
    const response=await f.send(kind);
    expect(response.status).toBe(200);
    if(kind==="landmarks") expect(await q("SELECT x,y FROM ceph_landmarks WHERE analysis_id=$1 AND code='S'",[f.id])).toEqual([{x:20,y:30}]);
    else expect((await q("SELECT cal_x2,mm_per_pixel FROM ceph_analyses WHERE id=$1",[f.id]))[0]).toEqual({cal_x2:100,mm_per_pixel:0.1});
  });
});
