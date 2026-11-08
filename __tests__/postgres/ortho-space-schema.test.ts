import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { ORTHO_SPACE_LEDGER_SQL } from '../../lib/ortho-space-schema';
import { ORTHO_SPACE_SUBMISSION_SQL } from '../../lib/ortho-space-submission-schema';
import { openPeriodontalFixture } from './_periodontal-fixture';

describe('space immutable schema and journal',()=>{
 it('runtime mirrors equal CLI bytes',async()=>{
  expect(ORTHO_SPACE_LEDGER_SQL).toBe(await readFile('migrations/0119_ortho_space_ledger.sql','utf8'));
  expect(ORTHO_SPACE_SUBMISSION_SQL).toBe(await readFile('migrations/0120_ortho_space_submissions.sql','utf8'));
 });
 it('upgrades populated 0118 without inferring clinical facts and rejects unregistered collisions',async()=>{
  const f=await openPeriodontalFixture(process.env,{pristine:true});
  try{
   const files=await loadMigrationFiles();await migrate(f.pool,{apply:true,files:files.filter(x=>x.version<'0119')});
   await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-SPACE-MIGRATION','Synthetic upgrade canary')");
   const before=(await f.pool.query('SELECT * FROM patients')).rows;
   await migrate(f.pool,{apply:true,files});
   expect((await f.pool.query('SELECT * FROM patients')).rows).toEqual(before);
   expect((await f.pool.query('SELECT * FROM ortho_space_entries')).rows).toEqual([]);
   expect((await f.pool.query('SELECT * FROM ortho_space_submissions')).rows).toEqual([]);
   await migrate(f.pool,{apply:true,files});
  }finally{await f.close();}
 });
 it('rejects replacing an unregistered ledger',async()=>{
  const f=await openPeriodontalFixture(process.env,{pristine:true});
  try{
   const files=await loadMigrationFiles();await migrate(f.pool,{apply:true,files:files.filter(x=>x.version<'0119')});
   await f.pool.query("CREATE TABLE ortho_space_entries(id integer,marker text);INSERT INTO ortho_space_entries VALUES(1,'synthetic canary')");
   await expect(migrate(f.pool,{apply:true,files})).rejects.toThrow();
   expect((await f.pool.query('SELECT * FROM ortho_space_entries')).rows).toEqual([{id:1,marker:'synthetic canary'}]);
  }finally{await f.close();}
 });
});

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../../lib/db';
import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
describe("space journal relational invariants",()=>{
let fixture:Awaited<ReturnType<typeof openPeriodontalFixture>>;
beforeAll(async()=>{fixture=await openPeriodontalFixture(process.env,{pristine:true});await migrate(fixture.pool,{apply:true,files:await loadMigrationFiles()});});
afterAll(async()=>{await fixture?.close();});
async function seed(){
 const pool=fixture.pool, key=randomUUID();
 const patient=(await pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic space schema') RETURNING id",[key])).rows[0].id;
 const actor=(await pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic recorder','synthetic','admin') RETURNING id",[key])).rows[0].id;
 const ortho=(await pool.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','active') RETURNING id",[patient])).rows[0].id;
 const bridge=(await pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id",[patient,ortho])).rows[0].id;
 const hash='a'.repeat(64);
 const strategy=(await pool.query("INSERT INTO ortho_strategy_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,rows) VALUES($1,$1,$2,$3,1,$4,'synthetic','synthetic','current',$5,$6,'[{}]') RETURNING id",[patient,ortho,bridge,actor,randomUUID(),hash])).rows[0].id;
 const assessment=(await pool.query("INSERT INTO ortho_assessment_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,content_sha256,content) VALUES($1,$1,$2,$3,1,1,$4,'synthetic','synthetic','current',$5,$6,$6,'{}') RETURNING id",[patient,ortho,bridge,actor,randomUUID(),hash])).rows[0].id;
 const authored={kind:'plan',arch:'upper',strategyRevisionId:strategy,baseline:{kind:'assessment_analysis',id:assessment,member:'synthetic',version:`sha256:${hash}`},gains:[],uses:[],contacts:[],rationale:'Synthetic',alternatives:'Synthetic'};
 const command={schemaVersion:1,clientRequestId:randomUUID(),expectedHeadId:null,reason:'Synthetic entry',content:authored};
 return {patient,actor,ortho,bridge,strategy,assessment,command,content:{authored,baseline:{discrepancyMm:-2.125,estimated:false},adjustment:null}};
}
type Seed=Awaited<ReturnType<typeof seed>>;
async function tx(body:(client:DbClient)=>Promise<void>){const client=await fixture.pool.connect();try{await client.query('BEGIN');await body(client);await client.query('COMMIT');}finally{await client.query('ROLLBACK');client.release();}}
async function journal(client:DbClient,s:Seed){return (await client.query("INSERT INTO ortho_space_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state) VALUES($1,$1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id",[s.patient,s.ortho,s.bridge,s.actor,s.command.clientRequestId,journeyContentHash(s.command),s.command])).rows[0].id;}
async function entry(client:DbClient,s:Seed,fingerprint=journeyContentHash(s.command)){return (await client.query("INSERT INTO ortho_space_entries(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,actor_user_id,created_by,reason,recording_context,case_status_at_capture,command_id,request_fingerprint,content_sha256,content,arch,entry_kind,strategy_revision_id,assessment_revision_id) VALUES($1,$1,$2,$3,1,$4,'synthetic',$5,'current','active',$6,$7,$8,$9,'upper','plan',$10,$11) RETURNING id",[s.patient,s.ortho,s.bridge,s.actor,s.command.reason,s.command.clientRequestId,fingerprint,journeyContentHash(s.content),s.content,s.strategy,s.assessment])).rows[0].id;}
it('requires atomic exact-intent settlement, supports reverse physical restore order and preserves history',async()=>{
 const s=await seed();let id=0,submission=0;
 await tx(async c=>{id=await entry(c,s);submission=await journal(c,s);await c.query("UPDATE ortho_space_submissions SET state='committed',entry_id=$2,settled_at=clock_timestamp() WHERE id=$1",[submission,id]);});
 expect((await fixture.pool.query('SELECT content FROM ortho_space_entries WHERE id=$1',[id])).rows[0].content).toEqual(s.content);
 await expect(fixture.pool.query('UPDATE ortho_space_entries SET reason=reason WHERE id=$1',[id])).rejects.toThrow(/append-only/);
 await expect(fixture.pool.query('DELETE FROM ortho_space_entries WHERE id=$1',[id])).rejects.toThrow(/append-only/);
 await expect(fixture.pool.query('TRUNCATE ortho_space_entries CASCADE')).rejects.toThrow();
 await fixture.pool.query('UPDATE ortho_space_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1',[submission]);
 await expect(fixture.pool.query("UPDATE ortho_space_submissions SET state='pending' WHERE id=$1",[submission])).rejects.toThrow();
});
it('rejects orphan entries and leaves no partially committed clinical fact',async()=>{
 const s=await seed();await expect(tx(async c=>{await entry(c,s);})).rejects.toThrow(/reservation/);
 expect((await fixture.pool.query('SELECT id FROM ortho_space_entries WHERE ortho_case_id=$1',[s.ortho])).rows).toEqual([]);
});
it('rejects an uncommitted journal with a clinical outcome',async()=>{
 const s=await seed();await expect(tx(async c=>{await journal(c,s);await entry(c,s);})).rejects.toThrow(/Uncommitted/);
});
it('rejects a settled entry with different exact authored content even if fingerprint copied',async()=>{
 const s=await seed();await expect(tx(async c=>{const submission=await journal(c,s),hash=journeyContentHash(s.command);s.content.authored.rationale='Different fact';const id=await entry(c,s,hash);await c.query("UPDATE ortho_space_submissions SET state='committed',entry_id=$2,settled_at=clock_timestamp() WHERE id=$1",[submission,id]);})).rejects.toThrow(/exact entry/);
});
it('rejects changed outcome before same-transaction acknowledgement erases recovery intent',async()=>{
 const s=await seed();await expect(tx(async c=>{const submission=await journal(c,s),hash=journeyContentHash(s.command);s.content.authored.rationale='Changed hidden fact';const id=await entry(c,s,hash);
 await c.query("UPDATE ortho_space_submissions SET state='committed',entry_id=$2,settled_at=clock_timestamp() WHERE id=$1",[submission,id]);
 await c.query('UPDATE ortho_space_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1',[submission]);})).rejects.toThrow(/exact entry/);
 expect((await fixture.pool.query('SELECT id FROM ortho_space_entries WHERE ortho_case_id=$1',[s.ortho])).rows).toEqual([]);
});
it('rejects restored committed intent mismatch before acknowledgement scrubs it',async()=>{
 const s=await seed();await expect(tx(async c=>{
 const original=structuredClone(s.command);s.content.authored.rationale='Changed restored fact';const id=await entry(c,s,journeyContentHash(original));
 const submission=(await c.query(`INSERT INTO ortho_space_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,state,entry_id,settled_at)
 VALUES($1,$1,$2,$3,$4,$5,$6,$7,'committed',$8,clock_timestamp()) RETURNING id`,[s.patient,s.ortho,s.bridge,s.actor,original.clientRequestId,journeyContentHash(original),original,id])).rows[0].id;
 await c.query('UPDATE ortho_space_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1',[submission]);
 })).rejects.toThrow(/exact entry/);
});
it('protects patient and bridge ownership of pending intent',async()=>{
 const s=await seed(), other=await seed();await tx(async c=>{await journal(c,s);});
 await expect(fixture.pool.query('UPDATE ortho_cases SET patient_id=$2 WHERE id=$1',[s.ortho,other.patient])).rejects.toThrow();
 await expect(fixture.pool.query('UPDATE clinical_cases SET patient_id=$2 WHERE id=$1',[s.bridge,other.patient])).rejects.toThrow();
});

});
