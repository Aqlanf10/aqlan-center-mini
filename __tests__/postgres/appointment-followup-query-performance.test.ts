import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { loadMigrationFiles, migrate, applyRuntimeMigrationFiles } from '../../lib/migrations';
import { PLANNED_REBOOK_GENERATION_SQL } from '../../lib/planned-visit-rebooking-contract';
import { APPOINTMENT_FOLLOWUP_QUERY_SQL } from '../../lib/appointment-followup-query-schema';
import { sessionCredentialVersion } from '../../lib/auth';
import { parseFollowupPage } from '../../lib/appointment-followup-page';
import * as db from '../../lib/db';
import { FOLLOWUP_QUEUE_SQL, readAppointmentFollowupQueue } from '../../lib/appointment-followup-db';

type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Actual Rows': number; 'Actual Loops': number; 'Rows Removed by Filter'?: number; 'Rows Removed by Join Filter'?: number; Plans?: Plan[] };
function nodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
it('populated 0070 upgrades without changing facts; bounded page probes skip 50k retained tasks and unrelated clinical history', async () => {
  const fixture=await openBackupTimestampFixture({...process.env});
  const pool=fixture.source;
  const spy=vi.spyOn(db,'getPool').mockReturnValue(pool as unknown as db.DbPool);
  try {
    const files=await loadMigrationFiles();
    const indexMigration=files.find(f=>f.version==='0071')!;
    expect(indexMigration.sql).toBe(APPOINTMENT_FOLLOWUP_QUERY_SQL);
    await migrate(pool,{apply:true,files:files.filter(f=>f.version<'0071')});
    await pool.query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(900,'synthetic-perf','Synthetic','test-only','reception')");
    await pool.query("INSERT INTO patients(id,patient_number,full_name) VALUES(901,'SYN-PERF-1','Synthetic 1'),(902,'SYN-PERF-2','Synthetic 2')");
    await pool.query("INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time,status,created_at) SELECT n,CASE WHEN n>9980 THEN 902 ELSE 901 END,'2000-01-01','10:00','no_show','2000-01-01T00:00:00.123456Z' FROM generate_series(1,10000)n");
    await pool.query(`INSERT INTO appointment_followups(id,source_appointment_id,source_created_at,generation,assignee_user_id,due_at,status,outcome,next_step,revision) SELECT id,id,EXTRACT(EPOCH FROM created_at)::text,${PLANNED_REBOOK_GENERATION_SQL},900,'2090-01-01'::timestamptz+id*interval '1 minute','open','pending','call',1 FROM appointments`);
    await pool.query('INSERT INTO appointment_followup_links SELECT id,id,patient_id FROM appointments');
    await pool.query("SELECT setval(pg_get_serial_sequence('appointment_followups','id'),10000,true)");
    await pool.query("INSERT INTO appointment_followups(source_appointment_id,source_created_at,generation,assignee_user_id,due_at,status,outcome,next_step,revision) SELECT n,'946684800.123456',md5('old-generation-'||(n%5)),900,'2080-01-01','open','pending','call',1 FROM generate_series(1,50000)n");
    await pool.query("INSERT INTO planned_visits(patient_id,sequence,title,status) SELECT 901,n,'Synthetic','planned' FROM generate_series(1,10000)n");
    await pool.query('UPDATE planned_visits SET appointment_id=id WHERE id>9000 OR id<=26');
    await pool.query("INSERT INTO visits(patient_id,patient_name) SELECT 901,'Synthetic' FROM generate_series(1,10000)");
    await pool.query('UPDATE visits SET appointment_id=id,planned_visit_id=id WHERE id>9000');
    await pool.query("INSERT INTO treatment_plans(id,patient_id,title,total_minor,status) VALUES(1,901,'Synthetic',0,'active')");
    await pool.query("INSERT INTO plan_items(id,plan_id,service_name,unit_price_minor) VALUES(1,1,'Synthetic',0)");
    await pool.query("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id,status) SELECT 1,n,100+(n%9900),'planned' FROM generate_series(1,10000)n");
    await pool.query("INSERT INTO appointment_status_log(appointment_id,from_status,to_status,actor) SELECT 9001+(n%999),'booked','no_show','Synthetic' FROM generate_series(1,10000)n");
    // Dense source-linked evidence exercises probes that the unrelated-record
    // fixture alone cannot cover: planned-only sessions, late attended session,
    // and a long non-attendance status history before an attendance marker.
    await pool.query("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id,status) SELECT 1,10000+n,CASE WHEN n<=400 THEN 1 ELSE 2 END,'planned' FROM generate_series(1,800)n");
    await pool.query("UPDATE treatment_sessions SET status='completed' WHERE sequence=10800");
    await pool.query("INSERT INTO appointment_status_log(appointment_id,from_status,to_status,actor) SELECT 3,'booked','no_show','Synthetic' FROM generate_series(1,1000)");
    await pool.query("INSERT INTO appointment_status_log(appointment_id,from_status,to_status,actor) VALUES(3,'no_show','arrived','Synthetic')");
    const facts=async()=>{
      const result:Record<string,string>={};
      for(const table of ['appointments','appointment_followups','appointment_followup_links','appointment_followup_events','appointment_followup_receipts','visits','planned_visits','treatment_sessions','appointment_status_log']) {
        result[table]=(await pool.query(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY id),'')) AS hash FROM ${table==='appointment_followup_links'?'(SELECT followup_id AS id,l.* FROM appointment_followup_links l)':table==='appointment_followup_receipts'?'(SELECT event_id AS id,r.* FROM appointment_followup_receipts r)':table} t`)).rows[0].hash;
      }
      return result;
    };
    const before=await facts();
    const started=performance.now();
    expect((await migrate(pool,{apply:true,files})).appliedVersions).toEqual(['0071','0072']);
    const ddlMs=performance.now()-started;
    expect(await facts()).toEqual(before);
    expect(await applyRuntimeMigrationFiles(pool,[indexMigration])).toEqual([]);
    expect((await pool.query("SELECT to_regclass('appointment_followups_queue_idx') AS old, to_regclass('appointment_followups_generation_queue_idx')::text AS current")).rows[0]).toEqual({old:null,current:'appointment_followups_generation_queue_idx'});
    await pool.query('ANALYZE'); await pool.query("SET statement_timeout='8s'");
    const generation=(await pool.query(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`)).rows[0].value;
    const actor={userId:900,username:'synthetic-perf',role:'reception',credentialVersion:sessionCredentialVersion('test-only'),expiresAt:Date.now()+3600000};
    const first=await readAppointmentFollowupQueue(actor,{limit:25,patientId:null,cursor:null});
    expect(first.items).toHaveLength(25);expect(first.items.filter(item=>item.contactBlocked).map(item=>item.id)).toEqual([2,3]);
    const options=parseFollowupPage(new URLSearchParams({limit:'25',cursor:first.nextCursor!}))!;
    const second=await readAppointmentFollowupQueue(actor,options);
    expect(second.items).toHaveLength(25);expect(second.items.some(item=>first.items.some(old=>old.id===item.id))).toBe(false);
    const reports=[];
    for(const [label,patientId,due,id] of [['first',null,null,null],['next',null,options.cursor!.due,options.cursor!.id],['sparse-patient',902,null,null]] as const) {
      const result=await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+FOLLOWUP_QUEUE_SQL,['Asia/Aden',patientId,due,id,26,generation]);
      const plan=result.rows[0]['QUERY PLAN'][0]; const all=nodes(plan.Plan);
      expect(plan['Execution Time']).toBeLessThan(2000); // generous guard; actual rows are the key acceptance evidence
      const scans = all.filter(n=>['visits','planned_visits','treatment_sessions','appointment_status_log'].includes(n['Relation Name'] ?? '') && n['Actual Loops']>0);
      const work = scans.map(n=>({relation:n['Relation Name'],index:n['Index Name'],loops:n['Actual Loops'],returned:n['Actual Rows']*n['Actual Loops'],removed:(n['Rows Removed by Filter']??0)*n['Actual Loops'],examined:(n['Actual Rows']+(n['Rows Removed by Filter']??0))*n['Actual Loops'],removedRoundingTolerance:n['Actual Loops']/2}));
      for(const node of scans) expect(node['Node Type']).not.toBe('Seq Scan');
      // EXPLAIN reports per-loop averages (possibly rounded). Count filtered
      // rows too; returned rows alone would hide dense linked evidence scans.
      expect(work.reduce((sum,n)=>sum+n.examined,0)).toBeLessThan(3000);
      if(label==='first') {
        expect(work.filter(n=>n.relation==='treatment_sessions').reduce((sum,n)=>sum+n.returned,0)).toBeGreaterThanOrEqual(790);
        const statusWork=work.filter(n=>n.relation==='appointment_status_log');
        expect(Math.abs(statusWork.reduce((sum,n)=>sum+n.removed,0)-1000)).toBeLessThanOrEqual(statusWork.reduce((sum,n)=>sum+n.removedRoundingTolerance,0));
      }
      if(patientId===null) {
        const scan=all.find(n=>n['Relation Name']==='appointment_followups')!;
        expect(scan['Index Name']).toBe('appointment_followups_generation_queue_idx');
        expect(scan['Actual Rows']).toBe(26);expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
      }
      reports.push({label,plan,scanWork:work});
    }
    const patient=await readAppointmentFollowupQueue(actor,{limit:25,patientId:902,cursor:null});
    expect(patient.items).toHaveLength(20);expect(patient.items.every(item=>item.contactBlocked)).toBe(true);
    expect(await facts()).toEqual(before);
    // Evaluate retaining the published predecessor with the FINAL bound-
    // generation SQL, without changing any numbered migration or Production.
    await pool.query("CREATE INDEX appointment_followups_queue_idx ON appointment_followups(due_at,id) WHERE status='open'");
    const retainedResult=await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+FOLLOWUP_QUEUE_SQL,['Asia/Aden',null,null,null,26,generation]);
    const retainedPredecessorPlan=retainedResult.rows[0]['QUERY PLAN'][0];
    await pool.query('DROP INDEX appointment_followups_queue_idx');
    const directory=process.env.FOLLOWUP_PERF_EVIDENCE_DIR;
    if(directory) {await mkdir(directory,{recursive:true});await writeFile(join(directory,'query-performance.json'),JSON.stringify({synthetic:true,counts:{currentTasks:10000,retainedOldTasks:50000,visits:10000,plannedVisits:10000,sessions:10800,statusEvents:11001},sqlSha256:createHash('sha256').update(FOLLOWUP_QUEUE_SQL).digest('hex'),migrationSha256:indexMigration.checksum,ddlMs,reports,retainedPredecessorPlan},null,2)+'\n');}
  } finally {spy.mockRestore();await fixture.close();}
},180000);
it('0071 rolls back partial index creation on a conflicting name instead of adopting or replacing it',async()=>{
  const fixture=await openBackupTimestampFixture({...process.env});
  try {
    const files=await loadMigrationFiles();const file=files.find(f=>f.version==='0071')!;
    await migrate(fixture.source,{apply:true,files:files.filter(f=>f.version<'0071')});
    await fixture.source.query('CREATE INDEX visits_followup_planned_idx ON visits(patient_id)');
    await expect(applyRuntimeMigrationFiles(fixture.source,[file])).rejects.toMatchObject({code:'42P07'});
    expect((await fixture.source.query("SELECT to_regclass('appointment_followups_generation_queue_idx') AS generation, to_regclass('visits_followup_appointment_idx') AS direct, to_regclass('appointment_followups_queue_idx')::text AS old")).rows[0]).toEqual({generation:null,direct:null,old:'appointment_followups_queue_idx'});
    expect((await fixture.source.query("SELECT version FROM schema_migrations WHERE version='0071'")).rows).toHaveLength(0);
    expect((await fixture.source.query("SELECT indexdef FROM pg_indexes WHERE indexname='visits_followup_planned_idx'")).rows[0].indexdef).toContain('(patient_id)');
  } finally {await fixture.close();}
});
