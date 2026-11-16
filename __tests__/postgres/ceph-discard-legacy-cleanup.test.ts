import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
let fx: CanonicalInventoryDatabase<"owner">;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, { owner: { username: "SYN-CEPH-DISCARD-CLEANUP", role: "admin" } }, "owner"); }, 180_000);
afterAll(async () => { await fx?.close(); });
it("legacy discard rolls back a failed update before releasing the original lease", async () => {
  const patient = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-CEPH-CLEANUP','SYN cleanup') RETURNING id")).rows[0].id);
  const study = await seedCanonicalCeph(fx.pool, { patientId: patient });
  await fx.pool.query("UPDATE ceph_analyses SET status='draft',completed_at=NULL,completed_by=NULL WHERE id=$1", [study.id]);
  await fx.pool.query("CREATE FUNCTION syn_discard_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='discarded' THEN RAISE EXCEPTION 'SYN discard refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_discard_refuse BEFORE UPDATE ON ceph_analyses FOR EACH ROW EXECUTE FUNCTION syn_discard_refuse()");
  const productPool = db.getPool(), client = await productPool.connect(), release = vi.spyOn(client, "release").mockImplementation(() => {});
  const connect = vi.spyOn(productPool, "connect").mockResolvedValue(client);
  try {
    await expect(db.discardCephAnalysis(study.id, "SYN analyst", null)).rejects.toThrow("SYN discard refused");
    expect(release).toHaveBeenCalledTimes(1);
    await expect(client.query("SELECT 1 AS healthy")).resolves.toMatchObject({ rows: [{ healthy: 1 }] });
  } finally {
    connect.mockRestore(); release.mockRestore(); await client.query("ROLLBACK"); client.release();
    await fx.pool.query("DROP TRIGGER syn_discard_refuse ON ceph_analyses; DROP FUNCTION syn_discard_refuse()");
  }
});
