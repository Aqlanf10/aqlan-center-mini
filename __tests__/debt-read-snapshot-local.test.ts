import {afterAll,beforeAll,expect,it,vi} from "vitest";
vi.stubEnv("USE_LOCAL_DB","true");vi.stubEnv("NODE_ENV","test");vi.stubEnv("DATABASE_URL","");vi.stubEnv("RAILWAY_PROJECT_ID","");
const db=await import("../lib/db");
beforeAll(async()=>{await db.ensureSchema();},120000);
afterAll(async()=>{await db.resetPoolForTesting();vi.unstubAllEnvs();});
it("keeps PGlite debt reads transaction-free alongside a caller-owned write transaction",async()=>{
 const pool=db.getPool();await pool.query("INSERT INTO patients(patient_number,full_name) VALUES('LOCAL-SNAPSHOT-BASE','Synthetic local base')");vi.stubEnv("USE_LOCAL_DB","false");await pool.query("BEGIN");
 const connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query");
 try{
  const [first,second]=await Promise.all([db.computeDebtRows(null,true),db.computeDebtRows(null,true),pool.query("INSERT INTO patients(patient_number,full_name) VALUES('LOCAL-SNAPSHOT-WRITE','Synthetic local write')")]);
  expect(Array.isArray(first)).toBe(true);expect(Array.isArray(second)).toBe(true);expect(connect).not.toHaveBeenCalled();
  expect(query.mock.calls.filter(([sql])=>/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim()))).toEqual([]);
  // Original six reads plus the two batch allocation-proof reads per projection.
  expect(query.mock.calls.filter(([sql])=>sql.trim().startsWith("SELECT"))).toHaveLength(16);
  expect((await pool.query("SELECT id FROM patients WHERE patient_number='LOCAL-SNAPSHOT-WRITE'")).rows).toHaveLength(1);
 }finally{query.mockRestore();connect.mockRestore();await pool.query("ROLLBACK");vi.stubEnv("USE_LOCAL_DB","true");}
 expect((await pool.query("SELECT id FROM patients WHERE patient_number='LOCAL-SNAPSHOT-WRITE'")).rows).toEqual([]);
 await expect(db.computeDebtRows(null,true)).resolves.toBeInstanceOf(Array);
});
