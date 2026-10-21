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
  // Six base reads plus four evidence reads per projection. Name every query
  // contract, including U0 kind dispatch and absent-schema detection, rather
  // than accepting an unexplained count increase or per-patient N+1 reads.
  const selects=query.mock.calls.filter(([sql])=>sql.trim().startsWith("SELECT"));
  const contracts=[
   /^SELECT id, full_name, phone FROM patients /,
   /^SELECT id, patient_id, GREATEST\(/,
   /^SELECT id, patient_id, base_currency FROM invoices /,
   /^SELECT id, patient_id, invoice_id, plan_id, opening_currency, kind, /,
   /^SELECT patient_id, currency, amount_minor, as_of_date FROM patient_opening_balances /,
   /^SELECT id, patient_id, base_currency FROM treatment_plans /,
   /^SELECT c\.id, COALESCE\(to_jsonb\(c\)->>'currency_evidence_kind','legacy_v1'\)/,
   /^SELECT to_regclass\('invoice_unpaid_currency_claims'\) IS NOT NULL AS installed$/,
   /^SELECT d\.id,d\.correction_id,d\.source_invoice_ids,/,
   /^SELECT d\.id,d\.correction_id,e\.payment_id,p\.invoice_id,/,
  ];
  const normalized=selects.map(([sql])=>sql.trim().replace(/\s+/g," "));
  expect(normalized).toHaveLength(contracts.length*2);
  for(const contract of contracts)expect(normalized.filter(sql=>contract.test(sql)),String(contract)).toHaveLength(2);
  for(const [sql,values] of selects.filter(([sql])=>/^SELECT c\.id,/.test(sql.trim()))){
   expect(sql).toContain("c.patient_id=ANY($1::int[])");
   expect(values).toHaveLength(1);expect(Array.isArray(values?.[0])).toBe(true);
   expect((values?.[0] as number[]).length).toBeGreaterThan(0);
  }
  expect((await pool.query("SELECT id FROM patients WHERE patient_number='LOCAL-SNAPSHOT-WRITE'")).rows).toHaveLength(1);
 }finally{query.mockRestore();connect.mockRestore();await pool.query("ROLLBACK");vi.stubEnv("USE_LOCAL_DB","true");}
 expect((await pool.query("SELECT id FROM patients WHERE patient_number='LOCAL-SNAPSHOT-WRITE'")).rows).toEqual([]);
 await expect(db.computeDebtRows(null,true)).resolves.toBeInstanceOf(Array);
});
