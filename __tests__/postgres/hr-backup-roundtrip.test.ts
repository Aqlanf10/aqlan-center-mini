import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { Client } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { stubPostgresEnv } from "./_setup";
import { HR_STAFF_SQL } from "../../lib/hr-schema";
import { HR_CONTRACTS_ATTENDANCE_LEAVES_SQL } from "../../lib/hr-contracts-attendance-schema";
import { HR_PAYROLL_SQL } from "../../lib/hr-payroll-schema";
import { HR_TASKS_SQL } from "../../lib/hr-tasks-schema";
import { HR_PAYROLL_INTEGRITY_SQL } from "../../lib/hr-payroll-integrity-schema";
import { readFile } from "node:fs/promises";
stubPostgresEnv();
const db = await import("../../lib/db");
let fixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let baseline:string;
beforeAll(async()=>{
  fixture=await openBackupTimestampFixture({...process.env});
  baseline=await readFile("migrations/0001_baseline_schema.sql","utf8");
  await fixture.source.query(baseline);
  for (const sql of [HR_STAFF_SQL,HR_TASKS_SQL,HR_CONTRACTS_ATTENDANCE_LEAVES_SQL,HR_PAYROLL_SQL,HR_PAYROLL_INTEGRITY_SQL]) await fixture.source.query(sql);
  // Source has intentionally nondefault identifiers and owner-approved custom policies.
  await fixture.source.query(`INSERT INTO hr_staff(id,full_name,created_by) VALUES (71,'HR backup synthetic','test');
    INSERT INTO hr_leave_types(id,code,name_ar,default_days_per_year,allow_negative) VALUES (141,'annual','إجازة مخصصة',17.5,true);
    INSERT INTO hr_leave_balances(id,staff_id,leave_type_code,year,allocated_days,effective_from,effective_to) VALUES (161,71,'annual',2026,17.5,'2026-01-01','2026-12-31');
    INSERT INTO hr_leave_requests(id,staff_id,leave_type_code,start_date,end_date,days_count,reason,created_by) VALUES (181,71,'annual','2026-10-01','2026-10-02',2,'طلب مستعاد','test');
    INSERT INTO hr_settings(id,key,value,updated_by) VALUES (201,'leave_policy','{"annualDefaultDays":17.5,"approved":true}','test');
    INSERT INTO hr_attendance_records(id,staff_id,attendance_date,status,check_in_raw,check_in_actual,created_by) VALUES(211,71,'2026-10-03','incomplete','2026-10-03 08:00+03','2026-10-03 08:00+03','test');
    INSERT INTO hr_attendance_punch_events(id,attendance_id,staff_id,punch_type,punched_at,source,recorded_by) VALUES(221,211,71,'check_in','2026-10-03 08:00+03','manual','test');
    INSERT INTO hr_attendance_corrections(id,attendance_id,staff_id,field_corrected,reason,requested_by,approved_by,approved_at,status) VALUES(231,211,71,'check_in','Pending restored correction','test',NULL,NULL,'pending');`);
});
afterAll(async()=>{await db.resetPoolForTesting();await fixture?.close();});
async function initializeTarget(target:typeof fixture.sqlTarget){
  await db.resetPoolForTesting();
  process.env.DATABASE_URL=target.options.connectionString!;
  process.env.SKIP_SEED="true";
  await db.ensureSchema();
  expect((await target.query("SELECT count(*)::int AS n FROM hr_leave_types")).rows[0].n).toBe(0);
  expect((await target.query("SELECT count(*)::int AS n FROM hr_settings")).rows[0].n).toBe(0);
  await db.resetPoolForTesting();
}
async function dump(source:typeof fixture.source){
  const client=await source.connect();let sql="";
  try {for await(const line of db.backupSqlLines(client)) sql+=line;} finally {client.release();}
  return sql;
}
describe("HR backup restores custom keys, relations and sequences without seed collisions",()=>{
  it("SKIP_SEED permits exact HR restoration and advancing every affected sequence",async()=>{
    await initializeTarget(fixture.sqlTarget);
    await fixture.sqlTarget.query(await dump(fixture.source));
    expect((await fixture.sqlTarget.query("SELECT id,code,name_ar,default_days_per_year,allow_negative FROM hr_leave_types")).rows).toEqual((await fixture.source.query("SELECT id,code,name_ar,default_days_per_year,allow_negative FROM hr_leave_types")).rows);
    expect((await fixture.sqlTarget.query("SELECT id,key,value FROM hr_settings")).rows).toEqual((await fixture.source.query("SELECT id,key,value FROM hr_settings")).rows);
    expect((await fixture.sqlTarget.query("SELECT r.staff_id,r.leave_type_code,t.id AS type_id,b.allocated_days FROM hr_leave_requests r JOIN hr_leave_types t ON t.code=r.leave_type_code JOIN hr_leave_balances b ON b.staff_id=r.staff_id AND b.leave_type_code=r.leave_type_code")).rows).toEqual([{staff_id:71,leave_type_code:"annual",type_id:141,allocated_days:"17.50"}]);
    expect((await fixture.sqlTarget.query("SELECT e.id,e.attendance_id,e.staff_id,c.id AS correction_id,c.status,c.approved_by FROM hr_attendance_punch_events e JOIN hr_attendance_corrections c ON c.attendance_id=e.attendance_id")).rows).toEqual([{id:221,attendance_id:211,staff_id:71,correction_id:231,status:"pending",approved_by:null}]);
    expect((await fixture.sqlTarget.query("INSERT INTO hr_attendance_punch_events(attendance_id,staff_id,punch_type,punched_at,source,recorded_by) VALUES(211,71,'check_out','2026-10-03 16:00+03','manual','test') RETURNING id")).rows[0].id).toBeGreaterThan(221);
    const next=await fixture.sqlTarget.query("INSERT INTO hr_leave_types(code,name_ar) VALUES ('sick','جديد') RETURNING id");expect(next.rows[0].id).toBeGreaterThan(141);
    expect((await fixture.sqlTarget.query("INSERT INTO hr_settings(key,value,updated_by) VALUES ('new_policy','{}','test') RETURNING id")).rows[0].id).toBeGreaterThan(201);
    expect((await fixture.sqlTarget.query("INSERT INTO hr_staff(full_name,created_by) VALUES ('موظف جديد','test') RETURNING id")).rows[0].id).toBeGreaterThan(71);
  });
  it("a pre-HR backup restores onto the current empty schema",async()=>{
    // Independently prepare a legacy source without any HR table.
    const legacyUrl=fixture.archiveTarget.options.connectionString!;
    const legacy=new Client({connectionString:legacyUrl,ssl:false});await legacy.connect();
    try {
      await legacy.query(baseline);
      await legacy.query("INSERT INTO patients(id,patient_number,full_name) VALUES (91,'HR-OLD','مريض نسخة سابقة')");
      let sql="";for await(const line of db.backupSqlLines(legacy)) sql+=line;
      await legacy.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await initializeTarget(fixture.archiveTarget);
      await fixture.archiveTarget.query(sql);
      expect((await fixture.archiveTarget.query("SELECT id,patient_number FROM patients")).rows).toEqual([{id:91,patient_number:"HR-OLD"}]);
      expect((await fixture.archiveTarget.query("SELECT count(*)::int AS n FROM hr_staff")).rows[0].n).toBe(0);
      expect((await fixture.archiveTarget.query("INSERT INTO patients(patient_number,full_name) VALUES ('HR-NEW','مريض جديد') RETURNING id")).rows[0].id).toBeGreaterThan(91);
    } finally {await legacy.end();}
  });
});
